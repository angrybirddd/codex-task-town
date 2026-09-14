import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize } from '../src/normalize.mjs';
import { TownStore } from '../src/store.mjs';
import { startServer } from '../src/server.mjs';
import { StudioLayout, SLOTS } from '../public/layout.js';
const now = Date.now() - 10000;
const event = (type, at, overrides = {}) => normalize({ session_id: 's', hook_event_name: type,
  turn_id: 'turn', tool_use_id: 'a', tool_name: 'Bash', tool_input: { command: 'npm test' }, ...overrides }, { now: now + at });
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'town-review-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function enqueue(dir, e) { await writeFile(join(dir, 'spool', `${e.at}-${e.id}.json`), JSON.stringify(e)); }

test('out-of-order parallel completion reconciles without rewinding last activity', () => {
  const s = new TownStore(); s.ingest(event('PreToolUse', 10));
  s.ingest(event('PreToolUse', 30, { tool_use_id: 'b' }));
  assert.equal(s.ingest(event('PostToolUse', 20)), true);
  let t = s.snapshot(now + 31).tasks[0]; assert.equal(t.pendingTools, 1); assert.equal(t.lastAt, now + 30);
  s.ingest(event('PostToolUse', 40, { tool_use_id: 'b' })); assert.equal(s.snapshot().tasks[0].pendingTools, 0);
});
test('same-turn delayed start is tracked but older closed-turn activity is rejected', () => {
  const s = new TownStore(); s.ingest(event('UserPromptSubmit', 1));
  s.ingest(event('PreToolUse', 30, { tool_use_id: 'b' }));
  s.ingest(event('PreToolUse', 20)); assert.equal(s.snapshot().tasks[0].pendingTools, 2);
  s.ingest(event('Stop', 40)); assert.equal(s.ingest(event('PreToolUse', 35, { tool_use_id: 'c' })), false);
});
test('parallel completion must not hide a different pending approval', () => {
  const s = new TownStore(); s.ingest(event('PreToolUse', 1));
  s.ingest(event('PermissionRequest', 2, { tool_use_id: '', tool_input: { command: 'network-task' } }));
  s.ingest(event('PostToolUse', 3));
  assert.equal(s.snapshot().tasks[0].state, 'waiting');
  s.ingest(event('PostToolUse', 4, { tool_use_id: 'network', tool_input: { command: 'network-task' } }));
  assert.equal(s.snapshot().tasks[0].pendingApprovals, 0);
});
test('an unmatched result does not wipe all pending calls', () => {
  const s = new TownStore(); s.ingest(event('PreToolUse', 1));
  s.ingest(event('PostToolUse', 2, { tool_use_id: '', tool_input: { command: 'unrelated' } }));
  assert.equal(s.snapshot().tasks[0].pendingTools, 1);
});
test('a subagent shares parent session_id but not the parent character', () => {
  const parent = event('UserPromptSubmit', 1), child = event('SubagentStart', 2, { agent_id: 'agent-1' });
  assert.notEqual(parent.taskId, child.taskId); assert.equal(child.parentTaskId, parent.taskId);
  assert.ok(!JSON.stringify(child).includes('agent-1'));
  const s = new TownStore(); s.ingest(parent); s.ingest(child);
  s.ingest(event('SubagentStop', 3, { agent_id: 'agent-1' }));
  assert.equal(s.snapshot().tasks.find(t => t.id === parent.taskId).state, 'thinking');
  assert.equal(s.snapshot().tasks.find(t => t.id === child.taskId).state, 'review');
});
test('session open and old Stop signals do not establish current idleness', () => {
  const s = new TownStore({ staleMs: 100 }); s.ingest(event('SessionStart', 1));
  assert.equal(s.snapshot().tasks[0].state, 'unknown'); s.ingest(event('Stop', 2));
  assert.equal(s.snapshot(now + 103).tasks[0].displayState, 'unknown');
});
test('restart preserves deduplication and parallel call metadata without claiming freshness', () => {
  const s = new TownStore(), e = event('PreToolUse', 1); s.ingest(e);
  const restored = new TownStore(); restored.restore(JSON.parse(s.serialize()));
  assert.equal(restored.ingest(e), false); assert.equal(restored.snapshot().tasks[0].pendingTools, 1);
  assert.equal(restored.snapshot().tasks[0].displayState, 'unknown');
  restored.ingest(event('PostToolUse', 2)); assert.equal(restored.snapshot().tasks[0].pendingTools, 0);
});
test('malformed persisted history entries do not crash restore', () => {
  const s = new TownStore(); s.ingest(event('Stop', 1));
  const data = JSON.parse(s.serialize()); data.tasks[0].history = [null, {}, ...data.tasks[0].history];
  data.count = Infinity; data.lastHookAt = -1;
  const r = new TownStore(); r.restore(data); assert.equal(r.snapshot().eventCount, 0); assert.equal(r.snapshot().lastHookAt, 0);
});
test('queue is not acknowledged until the state snapshot exists on disk', async t => {
  const dir = await temp(t), app = await startServer({ port: 0, dataDir: dir, pollMs: 100000 }); t.after(() => app.close());
  const e = event('PreToolUse', 1); await enqueue(dir, e); await app.poll();
  assert.equal((await readdir(join(dir, 'spool'))).length, 0);
  const saved = JSON.parse(await readFile(join(dir, 'state.json')));
  assert.equal(saved.tasks[0].id, e.taskId); assert.ok(saved.seen.includes(e.id));
});
test('write failure retains the queue and recovers without double counting', async t => {
  const dir = await temp(t), app = await startServer({ port: 0, dataDir: dir, pollMs: 100000 }); t.after(() => app.close());
  await mkdir(join(dir, 'state.json.tmp')); const e = event('PreToolUse', 1); await enqueue(dir, e);
  await app.poll(); assert.equal((await readdir(join(dir, 'spool'))).length, 1);
  let health = await (await fetch(`http://127.0.0.1:${app.address.port}/api/health`)).json(); assert.equal(health.ok, false);
  await rm(join(dir, 'state.json.tmp'), { recursive: true }); await app.poll();
  assert.equal((await readdir(join(dir, 'spool'))).length, 0); assert.equal(app.store.count, 1);
  health = await (await fetch(`http://127.0.0.1:${app.address.port}/api/health`)).json(); assert.equal(health.ok, true);
});
test('a second collector cannot consume the same directory, even on another port', async t => {
  const dir = await temp(t), app = await startServer({ port: 0, dataDir: dir });
  await assert.rejects(startServer({ port: 0, dataDir: dir }), /Collector/); await app.close();
  const next = await startServer({ port: 0, dataDir: dir }); await next.close();
});
test('invalid queue events are counted and symlinks do not expose target contents', async t => {
  const dir = await temp(t), app = await startServer({ port: 0, dataDir: dir, pollMs: 100000 }); t.after(() => app.close());
  await writeFile(join(dir, 'secret'), 'private-data'); await symlink(join(dir, 'secret'), join(dir, 'spool', '123-abcd.json'));
  await writeFile(join(dir, 'spool', '124-abcd.json'), '{}'); await app.poll();
  const health = await (await fetch(`http://127.0.0.1:${app.address.port}/api/health`)).json();
  assert.equal(health.rejectedEvents, 2); assert.equal(await readFile(join(dir, 'secret'), 'utf8'), 'private-data');
});
test('viewer tokens are only accepted in headers, not URL query strings', async t => {
  const dir = await temp(t), token = 'review-test-secret-long-enough', app = await startServer({ port: 0, dataDir: dir, token }); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.address.port}`;
  assert.equal((await fetch(`${base}/api/snapshot?token=${token}`)).status, 401);
  assert.equal((await fetch(`${base}/api/snapshot`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
});
test('studio filters keep the remaining residents at their existing places', () => {
  const l = new StudioLayout(), all = Array.from({length:8}, (_,i) => ({id:String(i), role:'frontend',displayState:'coding'}));
  l.update(all); const place = l.get('3'); l.update([all[3]], all); assert.equal(l.get('3'), place);
  l.update(all); assert.equal(new Set(all.map(t => l.get(t.id))).size, 8);
});
test('working residents never overflow into the lounge; unknown preserves position', () => {
  const l = new StudioLayout(), all = Array.from({length:8}, (_,i) => ({id:String(i), role:'general',displayState:'coding'}));
  l.update(all); assert.ok(all.every(t => l.get(t.id).area !== 'rest'));
  const place = l.get('0'); all[0].displayState = 'unknown'; l.update(all); assert.equal(l.get('0'), place);
  all[0].displayState = 'idle'; l.update(all); assert.equal(l.get('0').area, 'rest');
});
test('all shared-studio anchor positions remain within the scene and distinct', () => {
  assert.equal(new Set(SLOTS.map(s => `${s.x}:${s.y}`)).size, SLOTS.length);
  assert.ok(SLOTS.every(s => s.x > 100 && s.x < 1100 && s.y > 120 && s.y < 750));
});

test('new static layout module is actually served as JavaScript', async t => {
  const dir = await temp(t), app = await startServer({ port: 0, dataDir: dir }); t.after(() => app.close());
  const response = await fetch(`http://127.0.0.1:${app.address.port}/layout.js`);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /javascript/);
  assert.match(await response.text(), /StudioLayout/);
});
test('authenticated SSE sends a snapshot without URL credentials', async t => {
  const dir = await temp(t), token = 'a-private-viewer-key-with-enough-length';
  const app = await startServer({ port: 0, dataDir: dir, token }); t.after(() => app.close());
  const response = await fetch(`http://127.0.0.1:${app.address.port}/api/events`, { headers: { Authorization: `Bearer ${token}` } });
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: snapshot/);
  await reader.cancel();
});
