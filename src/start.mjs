// Small bootstrap adapter. Keep the collector's existing HTTP/security implementation intact.
import { startServer as startCollector } from './server.mjs';
import { loadLabels, applyLabels } from './labels.mjs';
import { DEFAULT_CURRENT_WINDOW_MS, validateWindow } from '../public/lifecycle.js';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function startServer(options = {}) {
  const dataDir = resolve(options.dataDir || join(homedir(), '.codex-task-town'));
  const staleMs = options.staleMs ?? 120000;
  const currentWindowMs = validateWindow(options.currentWindowMs ?? Math.max(DEFAULT_CURRENT_WINDOW_MS, staleMs), staleMs);
  const labels = await loadLabels(dataDir);
  const app = await startCollector({ ...options, dataDir, staleMs });
  app.store.currentWindowMs = currentWindowMs;
  const snapshot = app.store.snapshot.bind(app.store);
  app.store.snapshot = now => ({ ...applyLabels(snapshot(now), labels), appVersion: '0.4.1' });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const app = await startServer({ port: Number(process.env.PORT || 4317), host: process.env.TOWN_HOST || '127.0.0.1',
      token: process.env.TOWN_VIEW_TOKEN || '', dataDir: process.env.TOWN_DATA_DIR || undefined,
      staleMs: Math.max(10000, Number(process.env.TOWN_STALE_MS) || 120000),
      currentWindowMs: process.env.TOWN_CURRENT_WINDOW_MS === undefined ? undefined : Number(process.env.TOWN_CURRENT_WINDOW_MS) });
    console.log(`Task Town 0.4.1 started on port ${app.address.port}`);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
