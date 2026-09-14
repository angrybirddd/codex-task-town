import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { mkdir, readFile, open, rename, readdir, unlink, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TownStore } from './store.mjs';
import { validEvent } from './normalize.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'],
  '/scene.js': ['scene.js', 'text/javascript'], '/layout.js': ['layout.js', 'text/javascript'],
  '/styles.css': ['styles.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

async function lockDirectory(dir) {
  const path = join(dir, 'collector.lock'), owner = `${process.pid}\n`;
  try {
    const lock = await open(path, 'wx', 0o600); await lock.writeFile(owner); await lock.close();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // A dead process cannot still consume this queue. Never remove an active/ambiguous lock.
    const old = await readFile(path, 'utf8'); const pid = Number(old.trim());
    let dead = false;
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); } catch (e) { dead = e.code === 'ESRCH'; }
    }
    if (!dead) throw new Error(`Collector already running or lock needs inspection: ${path}`);
    if (await readFile(path, 'utf8') !== old) throw new Error('Collector lock changed. Retry.');
    await unlink(path); return lockDirectory(dir);
  }
  return async () => { if (await readFile(path, 'utf8').catch(() => '') === owner) await unlink(path).catch(() => {}); };
}

export async function startServer({ port = 4317, host = '127.0.0.1', token = '',
  dataDir = join(homedir(), '.codex-task-town'), staleMs = 120000, pollMs = 500 } = {}) {
  const local = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (!local && token.length < 24) throw new Error('LAN sharing requires TOWN_VIEW_TOKEN with at least 24 characters.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
  if (!Number.isFinite(pollMs) || pollMs < 10) throw new Error('pollMs must be at least 10.');
  dataDir = resolve(dataDir);
  const spool = join(dataDir, 'spool'), stateFile = join(dataDir, 'state.json');
  await mkdir(spool, { recursive: true, mode: 0o700 });
  const unlock = await lockDirectory(dataDir);
  const store = new TownStore({ staleMs });
  try {
    const s = await lstat(stateFile);
    if (s.isFile() && s.size < 8 * 1024 * 1024) store.restore(JSON.parse(await readFile(stateFile, 'utf8')));
  } catch (e) { if (e.code !== 'ENOENT') console.warn('Saved state unavailable; replaying remaining queue.'); }
  const clients = new Set(); let busy = false, queueDepth = 0, rejected = 0, readError = false, writeError = false;
  let broadcastTimer, interval, heartbeat, closing = false;
  const snapshot = () => ({ ...store.snapshot(), queueDepth, rejectedEvents: rejected, collectorError: readError || writeError });
  const frame = () => `event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`;
  const broadcast = () => {
    const message = frame();
    for (const client of clients) {
      if (client.destroyed || client.writableLength > 1024 * 1024) { client.destroy(); clients.delete(client); }
      else client.write(message);
    }
  };
  async function save() {
    let file;
    try {
      // Exclusive temporary creation rejects symlinks and unexpected existing files.
      file = await open(`${stateFile}.tmp`, 'wx', 0o600);
      await file.writeFile(store.serialize()); await file.sync(); await file.close(); file = null;
      await rename(`${stateFile}.tmp`, stateFile);
      writeError = false; return true;
    } catch { writeError = true; return false; }
    finally { if (file) { await file.close().catch(() => {}); await unlink(`${stateFile}.tmp`).catch(() => {}); } }
  }
  // Recover a normal temp file left by a crash; do not follow links or remove directories.
  try { if ((await lstat(`${stateFile}.tmp`)).isFile()) await unlink(`${stateFile}.tmp`); } catch {}
  async function poll() {
    if (busy || closing) return;
    busy = true;
    try {
      const all = await readdir(spool);
      const names = all.filter(n => /^\d+-[a-f0-9-]+\.json$/.test(n)).sort();
      queueDepth = names.length; readError = false;
      for (const n of all.filter(n => /^\.\d+-[a-f0-9-]+\.json\.tmp$/.test(n)).slice(0, 100)) {
        const path = join(spool, n), info = await lstat(path);
        if (info.isFile() && Date.now() - info.mtimeMs > 60000) await unlink(path);
      }
      const consumed = []; let changed = false;
      for (const name of names.slice(0, 300)) {
        const path = join(spool, name);
        try {
          const info = await lstat(path);
          if (!info.isFile() || info.size > 4096) throw new Error('Invalid queue file');
          const event = JSON.parse(await readFile(path, 'utf8'));
          if (!validEvent(event) || event.at > Date.now() + 60000) { rejected++; }
          else changed = store.ingest(event) || changed;
          consumed.push(path);
        } catch (e) {
          if (['EACCES', 'EIO'].includes(e.code)) readError = true;
          else { rejected++; consumed.push(path); }
        }
      }
      // Commit snapshot AND dedupe IDs before acknowledgement; failed writes keep the queue.
      if (consumed.length && await save()) {
        for (const path of consumed) {
          try { await unlink(path); queueDepth--; } catch { readError = true; }
        }
      }
      if ((changed || writeError) && !broadcastTimer) broadcastTimer = setTimeout(() => {
        broadcastTimer = null; broadcast();
      }, 150);
    } catch { readError = true; }
    finally { busy = false; }
  }
  const server = http.createServer(async (req, res) => {
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { ...headers, 'Content-Type': `${type}; charset=utf-8` });
      res.end(req.method === 'HEAD' ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//')) return send(400, { error: 'Invalid request target' });
      const authority = req.headers.host || 'invalid';
      const origin = new URL(`http://${authority}`).origin;
      const url = new URL(req.url, origin);
      if (url.origin !== origin) return send(403, { error: 'Invalid origin' });
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      if (!(['localhost', '127.0.0.1', '::1'].includes(hostname) || (!local && isIP(hostname)))) return send(403, { error: 'Invalid host' });
      if (req.headers.origin && req.headers.origin !== origin) return send(403, { error: 'Cross-origin requests are not allowed' });
      if (!['GET', 'HEAD'].includes(req.method)) return send(405, { error: 'Read-only dashboard' });
      if (url.pathname.startsWith('/api/')) {
        const supplied = req.headers.authorization?.replace(/^Bearer /, '') || '';
        if (token && !eq(supplied, token)) return send(401, { error: 'A viewer token is required' });
        if (url.pathname === '/api/snapshot') return send(200, snapshot());
        if (url.pathname === '/api/health') return send(200, { ok: !readError && !writeError, version: '0.2.0', queueDepth, rejectedEvents: rejected, lastHookAt: store.lastHookAt });
        if (url.pathname === '/api/events' && req.method === 'GET') {
          if (clients.size >= 25) return send(503, { error: 'Viewer limit reached' });
          res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          clients.add(res); res.write(`retry: 2500\n${frame()}`); res.on('close', () => clients.delete(res)); return;
        }
        return send(404, { error: 'Not found' });
      }
      if (!Object.hasOwn(FILES, url.pathname)) return send(404, 'Not found', 'text/plain');
      const [name, type] = FILES[url.pathname]; send(200, await readFile(join(ROOT, 'public', name)), type);
    } catch { if (!res.headersSent) send(500, { error: 'Request failed' }); else res.end(); }
  });
  server.headersTimeout = 10000; server.requestTimeout = 15000;
  try { await new Promise((done, fail) => { server.once('error', fail); server.listen(port, host, done); }); }
  catch (e) { await unlock(); throw e; }
  await poll(); interval = setInterval(poll, pollMs);
  heartbeat = setInterval(broadcast, 15000); // Connection health is not task activity.
  return { server, store, poll, address: server.address(), dataDir,
    async close() {
      if (closing) return; closing = true;
      clearInterval(interval); clearInterval(heartbeat); clearTimeout(broadcastTimer);
      while (busy) await new Promise(r => setTimeout(r, 10));
      clearTimeout(broadcastTimer);
      for (const client of clients) client.end();
      await new Promise(r => server.close(r)); await unlock();
    } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const app = await startServer({ port: Number(process.env.PORT || 4317), host: process.env.TOWN_HOST || '127.0.0.1',
      token: process.env.TOWN_VIEW_TOKEN || '', dataDir: process.env.TOWN_DATA_DIR || undefined,
      staleMs: Math.max(10000, Number(process.env.TOWN_STALE_MS) || 120000) });
    const bind = app.address.address.includes(':') ? `[${app.address.address}]` : app.address.address;
    console.log(`\n  Task Town Studio · http://${bind}:${app.address.port}\n  Data: ${app.dataDir}\n  Demo: /?demo=1\n`);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
