import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TownStore } from '../src/store.mjs';
import { normalize, hash } from '../src/normalize.mjs';
import { startServer } from '../src/start.mjs';
import { DEFAULT_CURRENT_WINDOW_MS, scopeTasks, rosterCounts } from '../public/lifecycle.js';
import { presentTask, overview } from '../public/overview.js';
const now = Date.now(), windowMs = DEFAULT_CURRENT_WINDOW_MS;
const event = (type, extra = {}, at = now) => normalize({ hook_event_name: type, session_id: 'root',
  cwd: '/fixture', turn_id: 'turn', tool_use_id: 'call', tool_name: 'Bash', tool_input: { command: 'npm test' }, ...extra }, { now: at });
const view = (store, time = now) => {
  const snap = store.snapshot(time);
  return overview(snap.tasks.map((t, i) => presentTask(t, { now: time, index: i, currentWindowMs: snap.currentWindowMs })),
    { now: time, currentWindowMs: snap.currentWindowMs });
};

test('one session across 20 turns is one task, not 20 tool runs', () => {
  const s = new TownStore();
  for (let i = 0; i < 20; i++) {
    const turn_id = `turn-${i}`;
    for (const type of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) s.ingest(event(type, { turn_id }, now + i));
  }
  assert.equal(s.snapshot(now + 30).tasks.length, 1);
  assert.equal(view(s, now + 30).counts.all, 1);
  assert.equal(s.snapshot().eventCount, 80);
});
test('closed root stops inflating current total but remains in history', () => {
  const s = new TownStore(); s.ingest(event('UserPromptSubmit')); s.ingest(event('SessionEnd', {}, now + 1));
  assert.equal(view(s, now + 2).counts.all, 0);
  assert.equal(view(s, now + 2).counts.archived, 1);
  assert.equal(view(s, now + 2).rows.length, 0);
  assert.equal(s.snapshot(now + 2).tasks[0].state, 'ended');
});
test('new turn resumes the same closed task without creating a second resident', () => {
  const s = new TownStore(); s.ingest(event('SessionEnd'));
  s.ingest(event('UserPromptSubmit', { turn_id: 'new-turn' }, now + 1));
  assert.equal(view(s, now + 2).counts.all, 1);
  assert.equal(s.snapshot().tasks.length, 1);
  assert.equal(s.snapshot().tasks[0].id, hash('root'));
});
test('thirty finished child runs never turn one main task into thirty-one', () => {
  const s = new TownStore(); s.ingest(event('UserPromptSubmit'));
  for (let i = 0; i < 30; i++) {
    const agent_id = `helper-${i}`;
    s.ingest(event('SubagentStart', { agent_id }, now + 1));
    assert.equal(view(s, now + 2).counts.all, 1);
    s.ingest(event('SubagentStop', { agent_id }, now + 3));
  }
  const v = view(s, now + 4);
  assert.equal(v.counts.all, 1); assert.equal(v.counts.children, 0); assert.equal(v.counts.archived, 30);
  assert.equal(v.rows.length, 1); assert.equal(s.snapshot(now + 4).tasks.length, 31);
});
test('running children are visible without inflating main-task working count', () => {
  const s = new TownStore(); s.ingest(event('PreToolUse'));
  s.ingest(event('SubagentStart', { agent_id: 'helper' }));
  const v = view(s);
  assert.equal(v.counts.all, 1); assert.equal(v.counts.active, 1); assert.equal(v.counts.children, 1);
  assert.equal(v.rows.length, 2); assert.equal(v.rows[1].parentTaskId, hash('root'));
});
test('child without observed parent is a child, not a manufactured main task', () => {
  const s = new TownStore(); s.ingest(event('SubagentStart', { agent_id: 'orphan' }));
  assert.equal(view(s).counts.all, 0); assert.equal(view(s).counts.children, 1);
});
test('time alone removes old records from current scope without declaring completion', () => {
  const s = new TownStore(); s.ingest(event('PreToolUse'));
  assert.equal(view(s, now + 120001).counts.all, 1); // stale, but still recent
  assert.equal(view(s, now + 120001).counts.active, 0);
  const later = s.snapshot(now + windowMs + 1);
  assert.equal(later.roster.current, 0); assert.equal(later.roster.archived, 1);
  assert.equal(later.tasks[0].state, 'testing'); assert.equal(later.tasks[0].displayState, 'unknown');
  assert.equal(later.tasks[0].archiveReason, 'outside-window');
  assert.match(view(s, now + windowMs + 1).records[0].activityText, /^上次：/);
});
test('recent child keeps a quiet parent discoverable but does not claim parent is working', () => {
  const s = new TownStore(); s.ingest(event('PreToolUse', {}, now - windowMs - 1));
  s.ingest(event('SubagentStart', { agent_id: 'helper' }));
  const v = view(s);
  assert.equal(v.counts.all, 1); assert.equal(v.counts.active, 0); assert.equal(v.counts.waiting, 1);
  assert.equal(v.counts.children, 1);
});
test('synthetic child cannot revive historical main-task scope', () => {
  const s = new TownStore(); s.ingest(event('PreToolUse', {}, now - windowMs - 1));
  s.ingest({ ...event('SubagentStart', { agent_id: 'probe' }), synthetic: true });
  assert.equal(view(s).counts.all, 0); assert.equal(view(s).counts.reference, 1);
});
test('old version-1 checkpoints are reclassified on restore without deleting evidence', () => {
  const s = new TownStore(); s.ingest(event('PreToolUse', {}, now - windowMs - 1));
  s.ingest(event('SessionEnd', { session_id: 'closed' }));
  const saved = JSON.parse(s.serialize());
  assert.equal(saved.version, 1);
  const restored = new TownStore(); restored.restore(saved);
  assert.equal(view(restored).counts.all, 0); assert.equal(view(restored).counts.archived, 2);
  assert.equal(restored.snapshot().tasks.length, 2);
});
test('duplicate events and persisted replays never increase task count', () => {
  const s = new TownStore(), e = event('PreToolUse');
  for (let i = 0; i < 50; i++) s.ingest(e);
  const restored = new TownStore(); restored.restore(JSON.parse(s.serialize())); restored.ingest(e);
  assert.equal(restored.snapshot().eventCount, 1); assert.equal(view(restored).counts.all, 1);
});
test('same project and role do not merge different real sessions', () => {
  const s = new TownStore(); s.ingest(event('PreToolUse')); s.ingest(event('PreToolUse', { session_id: 'another' }));
  assert.equal(view(s).counts.all, 2);
});
test('at capacity helper churn evicts history before a still-current parent', () => {
  const s = new TownStore({ maxTasks: 5 }); s.ingest(event('UserPromptSubmit'));
  for (let i = 0; i < 40; i++) {
    s.ingest(event('SubagentStart', { agent_id: `helper-${i}` }, now + i + 1));
    s.ingest(event('SubagentStop', { agent_id: `helper-${i}` }, now + i + 2));
  }
  assert.ok(s.tasks.has(hash('root'))); assert.equal(s.tasks.size, 5);
  assert.equal(view(s, now + 50).counts.all, 1);
});
test('old incoming sessions or probes cannot evict a full current main-task set', () => {
  const s = new TownStore({ maxTasks: 2 });
  s.ingest(event('PreToolUse')); s.ingest(event('PreToolUse', { session_id: 'other' }));
  s.ingest(event('SessionEnd', { session_id: 'old-record' }, now - windowMs));
  s.ingest({ ...event('PreToolUse', { session_id: 'probe' }), synthetic: true });
  assert.equal(s.tasks.size, 2); assert.equal(view(s).counts.all, 2);
});
test('current main counters partition current scope; histories/probes never enter default roster', () => {
  const s = new TownStore();
  for (const [session_id, type] of [['work', 'PreToolUse'], ['wait', 'PermissionRequest'], ['quiet', 'Stop'], ['closed', 'SessionEnd']])
    s.ingest(event(type, { session_id }));
  s.ingest({ ...event('PreToolUse', { session_id: 'probe' }), synthetic: true });
  const v = view(s);
  assert.equal(v.counts.all, 3);
  assert.equal(v.counts.active + v.counts.waiting + v.counts.quiet, v.counts.all);
  assert.equal(v.rows.length, 3); assert.equal(v.counts.retained, 5);
  assert.equal(overview(v.records, { filter: 'archived', now }).rows.length, 1);
  assert.equal(overview(v.records, { filter: 'reference', now }).rows.length, 1);
  assert.deepEqual(s.snapshot(now).roster, rosterCounts(scopeTasks(s.snapshot(now).tasks, { now })));
});
test('invalid roster windows fail rather than silently accepting bad configuration', () => {
  for (const currentWindowMs of [0, -1, 0.5, NaN, Infinity, '1000', 120000 - 1, 31 * 86400000])
    assert.throws(() => new TownStore({ currentWindowMs }));
  assert.equal(new TownStore({ currentWindowMs: 180000 }).snapshot().currentWindowMs, 180000);
});
test('real HTTP reports current/history scopes for an existing checkpoint and same scope module', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'town-lifecycle-')); let app;
  try {
    const s = new TownStore(); s.ingest(event('SessionEnd')); s.ingest(event('PreToolUse', { session_id: 'recent' }));
    await writeFile(join(dir, 'state.json'), s.serialize());
    app = await startServer({ port: 0, dataDir: dir, currentWindowMs: 180000 });
    const base = `http://127.0.0.1:${app.address.port}`;
    const snap = await (await fetch(base + '/api/snapshot')).json();
    assert.equal(snap.currentWindowMs, 180000); assert.equal(snap.roster.current, 1); assert.equal(snap.roster.archived, 1);
    assert.equal(snap.tasks.length, 2);
    assert.equal((await fetch(base + '/app.js')).status, 200);
    assert.equal(snap.appVersion, '0.4.1');
  } finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('capacity protection includes a parent kept current by its child evidence', () => {
  const s = new TownStore({ maxTasks: 3 });
  s.ingest(event('PreToolUse', {}, now - windowMs - 1));
  s.ingest(event('SubagentStart', { agent_id: 'recent-helper' }));
  s.ingest(event('PreToolUse', { session_id: 'other-main' }));
  s.ingest(event('SubagentStart', { agent_id: 'another-helper' }, now + 1));
  assert.ok(s.tasks.has(hash('root')), 'do not evict a parent with recent child evidence');
  assert.equal(view(s, now + 2).counts.all, 2);
});
