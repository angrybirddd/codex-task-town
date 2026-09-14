import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalize, inferRole, validEvent, EVENTS } from '../src/normalize.mjs';
import { TownStore } from '../src/store.mjs';
import { startServer } from '../src/server.mjs';
import { configure, mergeHooks } from '../scripts/setup.mjs';
const hook = fileURLToPath(new URL('../src/hook.mjs', import.meta.url));
const now = Date.now() - 1000;
const event = (type, overrides = {}, at = now) => normalize({ hook_event_name: type, session_id: 'session-a',
  turn_id: 'turn-1', tool_use_id: 'call-1', cwd: '/private/client-project', tool_name: 'Bash',
  tool_input: { command: 'npm test' }, ...overrides }, { now: at });
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'task-town-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
function record(directory, raw) {
  return spawnSync(process.execPath, [hook, '--data-dir', directory], { input: typeof raw === 'string' ? raw : JSON.stringify(raw), encoding: 'utf8', timeout: 2500 });
}
async function statusWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Host: host } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject);
  });
}

test('normalizer rejects malformed and unsupported events', () => {
  for (const raw of [null, [], {}, { session_id: 's', hook_event_name: 'NotAHook' }]) assert.equal(normalize(raw), null);
  assert.equal(validEvent({}), false);
});
test('all configured lifecycle events have normalized schemas', () => { for (const type of EVENTS) assert.equal(validEvent(event(type, type.startsWith('Subagent') ? { agent_id: 'child' } : {})), true, type); });
test('minimal payload drops prompts, paths, commands, output and raw identifiers', () => {
  const e = event('UserPromptSubmit', { prompt: '前端 sk-super-secret', transcript_path: '/secret/log',
    tool_input: { command: 'echo TOKEN=abcdef', file_path: '/secret/private.tsx' }, tool_response: { output: 'sensitive-log' } });
  assert.equal(e.role, 'frontend');
  for (const value of ['sk-super-secret', 'TOKEN=', 'abcdef', '/private', '/secret', 'sensitive-log', 'session-a', 'turn-1', 'call-1']) assert.ok(!JSON.stringify(e).includes(value), value);
});
test('classifies patches, tests, reads, builds and generic commands', () => {
  assert.equal(event('PreToolUse', { tool_name: 'apply_patch' }).activity, 'coding');
  assert.equal(event('PreToolUse').activity, 'testing');
  assert.equal(event('PreToolUse', { tool_input: { command: 'rg function src' } }).activity, 'reading');
  assert.equal(event('PreToolUse', { tool_input: { command: 'pnpm build' } }).summary, '正在构建项目');
  assert.equal(event('PreToolUse', { tool_input: { command: 'some-unknown-command' } }).summary, '正在运行命令');
});
test('basename sharing is opt-in; sensitive filenames are omitted', () => {
  const raw = { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Update File: src/Sidebar.tsx' } };
  assert.ok(!normalize(raw).summary.includes('Sidebar'));
  assert.equal(normalize(raw, { filenames: true }).summary, '正在修改 Sidebar.tsx');
  raw.tool_input.command = '*** Update File: /project/.env';
  assert.equal(normalize(raw, { filenames: true }).summary, '正在修改代码');
});
test('failures use structured response fields, not arbitrary text', () => {
  assert.equal(event('PostToolUse', { tool_response: { exit_code: 2 } }).failed, true);
  assert.equal(event('PostToolUse', { tool_response: { output: 'failed in documentation sample' } }).failed, false);
});
test('identities remain stable and role rules are deterministic', () => {
  assert.equal(event('Stop').taskId, event('UserPromptSubmit').taskId);
  assert.notEqual(event('Stop').taskId, event('Stop', { session_id: 'other' }).taskId);
  assert.equal(inferRole('部署 docker'), 'ops'); assert.equal(inferRole('更新 README'), 'docs');
});
test('independent sessions cannot overwrite each other', () => {
  const s = new TownStore(); s.ingest(event('PreToolUse')); s.ingest(event('PermissionRequest', { session_id: 'b' }));
  assert.deepEqual(s.snapshot().tasks.map(t => t.state), ['testing', 'waiting']);
});
test('tool return does not imply idle or completion', () => {
  const s = new TownStore(); s.ingest(event('PreToolUse')); s.ingest(event('PostToolUse', {}, now + 1));
  assert.equal(s.snapshot().tasks[0].state, 'thinking');
});
test('Stop is advisory review and can be followed by continued work', () => {
  const s = new TownStore(); s.ingest(event('Stop')); assert.equal(s.snapshot().tasks[0].state, 'review');
  s.ingest(event('PreToolUse', {}, now + 1)); assert.equal(s.snapshot().tasks[0].state, 'testing');
});
test('closed session is not described as completed work', () => {
  const s = new TownStore(); s.ingest(event('SessionEnd')); assert.equal(s.snapshot().tasks[0].state, 'ended');
});
test('parallel tool calls retain outstanding activity', () => {
  const s = new TownStore(); s.ingest(event('PreToolUse')); s.ingest(event('PreToolUse', { tool_use_id: 'call-2' }, now + 1));
  s.ingest(event('PostToolUse', {}, now + 2));
  assert.equal(s.snapshot().tasks[0].state, 'testing'); assert.equal(s.snapshot().tasks[0].pendingTools, 1);
});
test('duplicate and older events cannot rewind state', () => {
  const s = new TownStore(), e = event('Stop', {}, now + 10);
  assert.equal(s.ingest(e), true); assert.equal(s.ingest(e), false); assert.equal(s.ingest(event('PreToolUse')), false);
  assert.equal(s.snapshot().tasks[0].state, 'review');
});
test('late PreToolUse cannot revive a completed tool call', () => {
  const s = new TownStore(); s.ingest(event('PostToolUse'));
  assert.equal(s.ingest(event('PreToolUse', {}, now + 1)), false);
});
test('late result after interrupt cannot resume the interrupted turn', () => {
  const s = new TownStore(); s.ingest(event('Interrupt'));
  assert.equal(s.ingest(event('PostToolUse', {}, now + 1)), false);
  assert.equal(s.snapshot().tasks[0].state, 'paused');
  s.ingest(event('UserPromptSubmit', { turn_id: 'turn-2' }, now + 2));
  assert.equal(s.snapshot().tasks[0].state, 'thinking');
});
test('silence makes active tasks unknown, never idle', () => {
  const s = new TownStore({ staleMs: 1000 }); s.ingest(event('PreToolUse'));
  const t = s.snapshot(now + 1001).tasks[0]; assert.equal(t.state, 'testing'); assert.equal(t.displayState, 'unknown');
});
test('restored active tasks require a fresh signal', () => {
  const s = new TownStore(); s.ingest(event('PreToolUse')); const restored = new TownStore(); restored.restore(JSON.parse(s.serialize()));
  assert.equal(restored.snapshot().tasks[0].displayState, 'unknown');
  restored.ingest(event('PostToolUse', {}, now + 1)); assert.equal(restored.snapshot().tasks[0].displayState, 'thinking');
});
test('task and history retention are bounded', () => {
  const s = new TownStore({ maxTasks: 2 });
  for (let i = 0; i < 20; i++) s.ingest(event('UserPromptSubmit', { turn_id: String(i) }, now + i));
  assert.equal(s.snapshot().tasks[0].history.length, 16);
  for (const session_id of ['b', 'c']) s.ingest(event('SessionStart', { session_id }));
  assert.equal(s.snapshot().tasks.length, 2);
});
test('recorder is silent and atomically writes only normalized events', async t => {
  const dir = await temp(t); const result = record(dir, { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: '前端 super-secret' });
  assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  const files = await readdir(join(dir, 'spool')); assert.equal(files.length, 1); assert.ok(files[0].endsWith('.json'));
  const data = await readFile(join(dir, 'spool', files[0]), 'utf8'); assert.ok(!data.includes('super-secret')); assert.ok(validEvent(JSON.parse(data)));
});
test('malformed input and unavailable storage quietly drop telemetry', async t => {
  const dir = await temp(t); await writeFile(join(dir, 'file'), 'x');
  for (const result of [record(dir, '{'), record(join(dir, 'file'), { hook_event_name: 'Stop', session_id: 's' })]) {
    assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  }
});
test('stdin watchdog bounds the recorder lifetime', async () => {
  const began = Date.now(), child = spawn(process.execPath, [hook], { stdio: ['pipe', 'pipe', 'pipe'] });
  const code = await new Promise(r => child.on('exit', r)); assert.equal(code, 0); assert.ok(Date.now() - began < 2500);
});
test('installer preserves other handlers and configuration metadata', () => {
  const original = { description: 'mine', hooks: { Stop: [{ matcher: 'x', hooks: [{ type: 'command', command: 'echo mine' }] }] } };
  const command = 'node hook --codex-task-town --data-dir /tmp/town';
  const merged = mergeHooks(original, command);
  assert.equal(merged.description, 'mine'); assert.equal(merged.hooks.Stop[0].hooks[0].command, 'echo mine');
  assert.equal(original.hooks.Stop.length, 1); assert.deepEqual(mergeHooks(merged, command), merged);
});
test('preview does not write; install backs up; uninstall preserves originals', async t => {
  const dir = await temp(t), codexHome = join(dir, 'codex'), dataDir = join(dir, 'data');
  await mkdir(codexHome); const original = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } };
  await writeFile(join(codexHome, 'hooks.json'), JSON.stringify(original));
  const preview = await configure({ codexHome, dataDir }); assert.ok(preview.preview); assert.equal((await readdir(codexHome)).length, 1);
  const installed = await configure({ write: true, codexHome, dataDir }); assert.ok(installed.backup);
  const hooks = JSON.parse(await readFile(join(codexHome, 'hooks.json')));
  assert.equal(hooks.hooks.Stop.length, 2); assert.equal(hooks.hooks.Stop[1].hooks[0].timeout, 1);
  assert.equal((await configure({ write: true, codexHome, dataDir })).changed, false);
  await configure({ write: true, remove: true, codexHome, dataDir });
  assert.deepEqual(JSON.parse(await readFile(join(codexHome, 'hooks.json'))), original);
});
test('invalid existing config is never overwritten', async t => {
  const dir = await temp(t); await writeFile(join(dir, 'hooks.json'), '{invalid');
  await assert.rejects(configure({ write: true, codexHome: dir }));
  assert.equal(await readFile(join(dir, 'hooks.json'), 'utf8'), '{invalid');
});
test('installed recorder works from an unrelated cwd and quoted path', async t => {
  const dir = await temp(t), codexHome = join(dir, 'codex'), dataDir = join(dir, "folder with ' quote");
  await configure({ write: true, codexHome, dataDir });
  const config = JSON.parse(await readFile(join(codexHome, 'hooks.json')));
  const command = config.hooks.Stop[0].hooks[0].command;
  const child = spawnSync('/bin/sh', ['-c', command], { cwd: tmpdir(), input: JSON.stringify({ session_id: 'test', hook_event_name: 'Stop' }), encoding: 'utf8', timeout: 2500 });
  assert.equal(child.status, 0); assert.equal(child.stderr, ''); assert.equal((await readdir(join(dataDir, 'spool'))).length, 1);
});
test('HTTP is read-only, Host/Origin checked, and collects real recorder events', async t => {
  const dir = await temp(t), app = await startServer({ port: 0, dataDir: dir, pollMs: 100000 }); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address.port}`;
  const response = await fetch(base); assert.equal(response.status, 200); assert.ok((await response.text()).includes('让工作，被看见'));
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(base + '/api/snapshot', { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/api/snapshot', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(base + '/state.json')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e/src/server.mjs')).status, 404);
  assert.equal(await statusWithHost(base + '/api/snapshot', 'evil.example'), 403);
  record(dir, { session_id: 'real', hook_event_name: 'PreToolUse', tool_name: 'apply_patch' }); await app.poll();
  const snapshot = await (await fetch(base + '/api/snapshot')).json(); assert.equal(snapshot.tasks[0].state, 'coding');
  assert.ok(!JSON.stringify(snapshot).includes('pending":'));
});
test('LAN listener requires strong token; API checks authorization', async t => {
  const dir = await temp(t); await assert.rejects(startServer({ port: 0, host: '0.0.0.0', dataDir: dir }), /TOKEN/);
  const token = 'a-strong-test-token-over-24-chars'; const app = await startServer({ port: 0, token, dataDir: dir }); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address.port}`;
  assert.equal((await fetch(base + '/api/snapshot')).status, 401);
  assert.equal((await fetch(base + '/api/snapshot', { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await fetch(base + '/api/snapshot?token=wrong')).status, 401);
});
test('SSE starts with a snapshot and delivers recorded state changes', async t => {
  const dir = await temp(t), app = await startServer({ port: 0, dataDir: dir, pollMs: 100000 });
  const controller = new AbortController(); t.after(async () => { controller.abort(); await app.close(); });
  const response = await fetch(`http://127.0.0.1:${app.address.port}/api/events`, { signal: controller.signal });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: snapshot/); assert.match(first, /"tasks":\[\]/);
  record(dir, { session_id: 'sse', hook_event_name: 'PermissionRequest' }); await app.poll();
  let timer;
  try {
    const next = await Promise.race([reader.read(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('SSE timeout')), 3000); timer.unref(); })]);
    assert.match(new TextDecoder().decode(next.value), /"state":"waiting"/);
  } finally { clearTimeout(timer); await reader.cancel(); }
});
test('late result from an old turn cannot overwrite a new turn', () => {
  const s = new TownStore(); s.ingest(event('PreToolUse'));
  s.ingest(event('UserPromptSubmit', { turn_id: 'new-turn' }, now + 1));
  assert.equal(s.ingest(event('PostToolUse', {}, now + 2)), false);
  assert.equal(s.snapshot().tasks[0].state, 'thinking');
});
test('persistence restores only known fields and ignores malformed tasks', () => {
  const s = new TownStore(); s.ingest(event('PreToolUse'));
  const data = JSON.parse(s.serialize()); data.tasks[0].secret = 'never expose'; data.tasks.push({ id: 'invalid' });
  const restored = new TownStore(); restored.restore(data);
  assert.equal(restored.snapshot().tasks.length, 1); assert.ok(!JSON.stringify(restored.snapshot()).includes('never expose'));
});
test('installed script path is content-addressed; unexpected changes are refused', async t => {
  const dir = await temp(t), codexHome = join(dir, 'codex'), dataDir = join(dir, 'data');
  await configure({ write: true, codexHome, dataDir });
  const fingerprints = await readdir(join(dataDir, 'integration'));
  assert.match(fingerprints[0], /^[a-f0-9]{16}$/);
  await writeFile(join(dataDir, 'integration', fingerprints[0], 'hook.mjs'), '// changed');
  await assert.rejects(configure({ write: true, codexHome, dataDir }), /fingerprint/);
});
test('oversized stdin is dropped quietly without persisting raw content', async t => {
  const dir = await temp(t), result = record(dir, 'x'.repeat(1024 * 1024 + 1));
  assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  assert.equal((await readdir(dir)).length, 0);
});
