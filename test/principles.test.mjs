import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize, validEvent } from '../src/normalize.mjs';
import { TownStore } from '../src/store.mjs';
import { startServer } from '../src/server.mjs';
import { configure, mergeHooks } from '../scripts/setup.mjs';
const now = Date.now() - 10000;
const raw = (type, overrides = {}) => ({ session_id: 'root', cwd: '/workspace', hook_event_name: type,
  turn_id: 'turn-a', tool_name: 'Bash', tool_use_id: 'call-a', tool_input: { command: 'npm test' }, ...overrides });
const event = (type, time, overrides = {}) => normalize(raw(type, overrides), { now: now + time });
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'town-principles-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function enqueue(dir, e) { await writeFile(join(dir, 'spool', `${e.at}-${e.id}.json`), JSON.stringify(e)); }
const first = s => s.snapshot(now + 100).tasks[0];

test('approval metadata and JSON key order do not change command correlation', () => {
  const start = event('PreToolUse', 1, { tool_input: { command: 'npm test', cwd: '/workspace' } });
  const permission = event('PermissionRequest', 2, { tool_use_id: undefined,
    tool_input: { description: 'A human-readable approval reason', cwd: '/workspace', command: 'npm test' } });
  const s = new TownStore(); s.ingest(start); s.ingest(permission);
  s.ingest(event('PostToolUse', 3, { tool_input: { cwd: '/workspace', command: 'npm test' } }));
  assert.equal(first(s).pendingApprovals, 0);
  assert.equal(first(s).pendingTools, 0);
});
test('a delayed ID-less approval cannot resurrect a completed invocation', () => {
  const s = new TownStore(); s.ingest(event('PreToolUse', 1)); s.ingest(event('PostToolUse', 3));
  s.ingest(event('PermissionRequest', 2, { tool_use_id: undefined }));
  assert.notEqual(first(s).state, 'waiting');
});
test('a newer identical command still retains its own approval', () => {
  const s = new TownStore(); s.ingest(event('PreToolUse', 1)); s.ingest(event('PostToolUse', 2));
  s.ingest(event('PreToolUse', 3, { tool_use_id: 'call-b' }));
  s.ingest(event('PermissionRequest', 4, { tool_use_id: undefined }));
  assert.equal(first(s).state, 'waiting');
});
test('same-turn prompt delivery must not erase already observed tool work', () => {
  const s = new TownStore(); s.ingest(event('PreToolUse', 1));
  s.ingest(event('UserPromptSubmit', 2));
  assert.equal(first(s).pendingTools, 1); assert.equal(first(s).state, 'testing');
});
test('late tool return after Stop reconciles but never claims new activity', () => {
  const s = new TownStore(); s.ingest(event('PreToolUse', 1)); s.ingest(event('Stop', 2));
  s.ingest(event('PostToolUse', 3));
  assert.ok(['review', 'unknown'].includes(first(s).displayState));
});
test('missing turn ID cannot revive an interrupted task', () => {
  const s = new TownStore(); s.ingest(event('Interrupt', 1));
  s.ingest(event('PostToolUse', 2, { turn_id: undefined }));
  assert.ok(['paused', 'unknown'].includes(first(s).displayState));
});
test('tool events at the prompt timestamp are not lost to strict timestamp boundaries', () => {
  const s = new TownStore(); s.ingest(event('UserPromptSubmit', 1));
  s.ingest(event('PreToolUse', 2, { tool_use_id: 'b' })); s.ingest(event('PreToolUse', 1));
  assert.equal(first(s).pendingTools, 2);
});
test('old failure is historical evidence, not a permanently fresh status', () => {
  const s = new TownStore({ staleMs: 10 });
  s.ingest(event('PostToolUse', 1, { tool_response: { exit_code: 1 } }));
  assert.equal(s.snapshot(now + 12).tasks[0].displayState, 'unknown');
});
test('explicit close can follow interrupt even when both carry the same turn ID', () => {
  const s = new TownStore(); s.ingest(event('Interrupt', 1)); s.ingest(event('SessionEnd', 2));
  assert.equal(first(s).state, 'ended');
});
test('strict identifiers reject coercible arrays and empty event IDs', () => {
  const e = event('PreToolUse', 1);
  assert.equal(validEvent({ ...e, id: '' }), false);
  assert.equal(validEvent({ ...e, taskId: [e.taskId] }), false);
  assert.equal(normalize(raw('PreToolUse', { turn_id: 42 })), null);
});
test('a quoted test name and a compound destructive command are not confidently classified as tests/reads', () => {
  assert.equal(event('PreToolUse', 1, { tool_input: { command: 'echo "pytest"' } }).activity, 'running');
  assert.equal(event('PreToolUse', 1, { tool_input: { command: 'cat package.json && custom-deploy' } }).activity, 'running');
});
test('an oversized original command is not classified from a misleading truncated prefix', () => {
  const command = 'cat ' + 'x'.repeat(9000) + ' && custom-deploy';
  assert.equal(event('PreToolUse', 1, { tool_input: { command } }).activity, 'running');
});
test('rename failure cannot poison all subsequent snapshot writes', async t => {
  const dir = await temp(t); const app = await startServer({ port: 0, dataDir: dir, pollMs: 100000 });
  t.after(() => app.close());
  await mkdir(join(dir, 'state.json')); await enqueue(dir, event('PreToolUse', 1));
  await app.poll(); assert.equal((await readdir(join(dir, 'spool'))).length, 1);
  await rm(join(dir, 'state.json'), { recursive: true }); await app.poll();
  assert.equal((await readdir(join(dir, 'spool'))).length, 0);
  assert.equal(JSON.parse(await readFile(join(dir, 'state.json'))).tasks.length, 1);
});
test('corrupt checkpoint is never silently replaced by an empty town', async t => {
  const dir = await temp(t); const damaged = '{a truncated checkpoint';
  await writeFile(join(dir, 'state.json'), damaged);
  let app;
  try { await assert.rejects(async () => { app = await startServer({ port: 0, dataDir: dir }); }, /checkpoint/i); }
  finally { if (app) await app.close(); }
  assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), damaged);
  assert.ok(!(await readdir(dir)).includes('collector.lock'));
});
test('an abandoned lock is not unsafely reclaimed through a read/unlink race', async t => {
  const dir = await temp(t); await writeFile(join(dir, 'collector.lock'), '2147483647\n');
  let app;
  try { await assert.rejects(async () => { app = await startServer({ port: 0, dataDir: dir }); }, /lock/i); }
  finally { if (app) await app.close(); }
});
test('setup never follows a pre-existing temporary symlink', async t => {
  const dir = await temp(t), codexHome = join(dir, 'codex'), target = join(dir, 'unrelated.txt');
  await mkdir(codexHome); await writeFile(target, 'keep-me');
  await symlink(target, join(codexHome, 'hooks.json.task-town.tmp'));
  await configure({ write: true, codexHome, dataDir: join(dir, 'data') }).catch(() => {});
  assert.equal(await readFile(target, 'utf8'), 'keep-me');
});
test('frequent tool telemetry is async; sparse lifecycle boundaries stay ordered', () => {
  const config = mergeHooks({}, 'node hook --codex-task-town --data-dir /tmp/town');
  for (const [type, groups] of Object.entries(config.hooks)) {
    assert.equal(groups[0].hooks[0].async, ['PreToolUse', 'PermissionRequest', 'PostToolUse'].includes(type), type);
  }
});
test('a marker mentioned in an unrelated hook is not ownership proof', () => {
  const original = { hooks: { Stop: [{ hooks: [{type:'command', command:'echo documentation --codex-task-town not-an-installed-recorder'}] }] } };
  assert.deepEqual(mergeHooks(original, '', true), original);
});
test('synthetic probe provenance survives persistence and is separate from real events', () => {
  const e = normalize(raw('PreToolUse'), { now, synthetic: true });
  const s = new TownStore(); s.ingest(e);
  const restored = new TownStore(); restored.restore(JSON.parse(s.serialize()));
  assert.equal(restored.snapshot().tasks[0].synthetic, true);
  assert.equal(restored.snapshot().realEventCount, 0);
});

test('all delivery permutations of a documented tool lifecycle converge without a stuck approval', () => {
  const permutations = xs => xs.length < 2 ? [xs] : xs.flatMap((x,i) => permutations(xs.filter((_,j)=>i!==j)).map(t=>[x,...t]));
  const facts = [event('PreToolUse', 1), event('PermissionRequest', 2, { tool_use_id: undefined }), event('PostToolUse', 3)];
  for (const order of permutations(facts)) {
    const s = new TownStore();
    for (const e of order) s.ingest(e);
    assert.equal(first(s).pendingTools, 0, order.map(e=>e.type).join(','));
    assert.equal(first(s).pendingApprovals, 0, order.map(e=>e.type).join(','));
  }
});
test('ambiguous identical parallel approvals remain explicitly uncertain, not silently cleared', () => {
  const s = new TownStore(); s.ingest(event('PreToolUse', 1));
  s.ingest(event('PreToolUse', 2, { tool_use_id: 'b' }));
  s.ingest(event('PermissionRequest', 3, { tool_use_id: undefined }));
  assert.equal(first(s).displayState, 'unknown');
  assert.equal(first(s).pendingApprovals, 1);
});
test('async approval recorded after completion does not falsely prove a fresh wait', () => {
  const s = new TownStore(); s.ingest(event('PreToolUse', 1)); s.ingest(event('PostToolUse', 2));
  s.ingest(event('PermissionRequest', 3, { tool_use_id: undefined }));
  assert.equal(first(s).displayState, 'unknown');
});
test('correlation overflow is bounded and observable; a new turn restores certainty', () => {
  const s = new TownStore();
  for (let i=0;i<140;i++) s.ingest(event('PreToolUse', i, {tool_use_id:`call-${i}`}));
  assert.equal(first(s).pendingTools, 128); assert.equal(first(s).displayState, 'unknown');
  s.ingest(event('UserPromptSubmit', 150, {turn_id:'turn-b'}));
  assert.equal(s.snapshot(now+151).tasks[0].displayState, 'thinking');
});
test('unseen foreign-turn tool events cannot overwrite the observed active turn', () => {
  const s = new TownStore(); s.ingest(event('PreToolUse', 1));
  s.ingest(event('PostToolUse', 2, {turn_id:'unknown-older-round',tool_response:{exit_code:1}}));
  assert.equal(first(s).displayState, 'unknown');
  assert.equal(first(s).pendingTools, 1);
});
test('compaction notifications do not hide an unresolved approval', () => {
  const s = new TownStore(); s.ingest(event('PermissionRequest', 1));
  s.ingest(event('PreCompact', 2)); s.ingest(event('PostCompact', 3));
  assert.equal(first(s).state, 'waiting');
});
test('malformed JSON-compatible fields are rejected without throwing', () => {
  const e=event('PreToolUse',1);
  for(const value of [null,{},[],[e.taskId],{toString:null},42,false]) {
    assert.equal(validEvent({...e,role:value}),false);
    assert.equal(validEvent({...e,taskId:value}),false);
  }
});
test('the state machine accepts a hand-authored wire fixture without relying on its normalizer', () => {
  const s=new TownStore();
  const fixture={v:1,id:'11111111-1111-4111-8111-111111111111',at:now,taskId:'a'.repeat(20),
    projectId:'b'.repeat(20),turnId:'c'.repeat(20),callId:'d'.repeat(20),toolKey:'e'.repeat(20),
    type:'PreToolUse',role:'frontend',activity:'coding',summary:'正在修改代码',failed:false};
  assert.equal(s.ingest(fixture),true);
  assert.equal(first(s).state,'coding');
  s.ingest({...fixture,id:'22222222-2222-4222-8222-222222222222',at:now+1,type:'PostToolUse'});
  assert.equal(first(s).pendingTools,0);
});
test('strict Bearer authentication and cross-site request rejection', async t => {
  const dir=await temp(t), token='a-private-test-value-at-least-24-chars';
  const app=await startServer({port:0,dataDir:dir,token});t.after(()=>app.close());
  const url=`http://127.0.0.1:${app.address.port}/api/snapshot`;
  assert.equal((await fetch(url,{headers:{Authorization:token}})).status,401);
  assert.equal((await fetch(url,{headers:{Authorization:`Bearer ${token}`,'Sec-Fetch-Site':'cross-site'}})).status,403);
});

test('old checkpoint data is marked legacy until a fresh versioned observation arrives', () => {
  const s=new TownStore();s.ingest(event('PreToolUse',1));const saved=JSON.parse(s.serialize());
  delete saved.tasks[0].synthetic;delete saved.tasks[0].legacy;delete saved.realCount;delete saved.lastRealHookAt;
  const r=new TownStore();r.restore(saved);assert.equal(first(r).legacy,true);assert.equal(r.snapshot().realEventCount,0);
  r.ingest(event('PostToolUse',2));assert.equal(first(r).legacy,false);assert.equal(r.snapshot().realEventCount,1);
});
test('opening an old session does not refresh outstanding activity evidence', () => {
  const s=new TownStore({staleMs:10});s.ingest(event('PreToolUse',1));
  s.ingest(event('SessionStart',30,{turn_id:undefined,source:'resume'}));
  assert.equal(s.snapshot(now+31).tasks[0].displayState,'unknown');assert.equal(first(s).lastAt,now+1);
});
test('read commands with redirection and look-alike program names remain generic', () => {
  for(const command of ['cat source > output','cat-custom source','cat <(custom-deploy)'])
    assert.equal(event('PreToolUse',1,{tool_input:{command}}).activity,'running');
});
test('unscoped unmatched results cannot change the current identified turn', () => {
  const s=new TownStore();s.ingest(event('PreToolUse',1));
  s.ingest(event('PostToolUse',2,{turn_id:undefined,tool_use_id:'unrelated',tool_response:{exit_code:1}}));
  assert.equal(first(s).displayState,'unknown');assert.equal(first(s).pendingTools,1);
});
test('real installed command, offline queue replay, and authenticated HTTP form one tested chain', async t => {
  const {spawnSync}=await import('node:child_process');
  const dir=await temp(t),codexHome=join(dir,'codex'),dataDir=join(dir,'data');
  await configure({write:true,codexHome,dataDir});
  const configured=JSON.parse(await readFile(join(codexHome,'hooks.json')));
  const command=configured.hooks.PreToolUse[0].hooks[0].command;
  const child=spawnSync('/bin/sh',['-c',command],{input:JSON.stringify({session_id:'installed-chain',
    hook_event_name:'PreToolUse',turn_id:'round',tool_use_id:'patch',cwd:'/secret/path',tool_name:'apply_patch',
    tool_input:{command:'*** Update File: /secret/never-share.ts'}}),encoding:'utf8',timeout:2500});
  assert.equal(child.status,0);assert.equal(child.stdout,'');assert.equal(child.stderr,'');
  const token='independent-chain-fixture-viewer-token';
  const app=await startServer({port:0,dataDir,token});t.after(()=>app.close());
  const response=await fetch(`http://127.0.0.1:${app.address.port}/api/snapshot`,{headers:{Authorization:`Bearer ${token}`}});
  const snapshot=await response.json();assert.equal(snapshot.tasks[0].displayState,'coding');
  assert.equal(snapshot.realEventCount,1);assert.ok(!JSON.stringify(snapshot).includes('/secret'));
});
test('recovery from write failure promptly publishes health recovery over real SSE', async t => {
  const dir=await temp(t),app=await startServer({port:0,dataDir:dir,pollMs:100000});t.after(()=>app.close());
  const response=await fetch(`http://127.0.0.1:${app.address.port}/api/events`);
  const reader=response.body.getReader();await reader.read();
  const next=async()=>{
    let timer;
    try{return new TextDecoder().decode((await Promise.race([reader.read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('no SSE recovery')),1500)})])).value);}
    finally{clearTimeout(timer);}
  };
  try {
    await mkdir(join(dir,'state.json.tmp'));await enqueue(dir,event('PreToolUse',1));await app.poll();
    assert.match(await next(),/"collectorError":true/);
    await rm(join(dir,'state.json.tmp'),{recursive:true});await app.poll();
    assert.match(await next(),/"collectorError":false/);
  } finally {await reader.cancel();}
});

test('SIGKILL preserves acknowledged state; explicit isolated recovery never replays it twice', { timeout: 10000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const dir = await temp(t);
  const source = `import {startServer} from ${JSON.stringify(new URL('../src/server.mjs', import.meta.url).href)};
    const app=await startServer({port:0,dataDir:process.argv[1],pollMs:20});
    console.log('ready');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('collector failed to start'); })]);
  const e = event('PreToolUse', 1); await enqueue(dir, e);
  const until = Date.now() + 3000;
  let saved;
  while (Date.now() < until) {
    try { saved = JSON.parse(await readFile(join(dir, 'state.json'))); }
    catch { /* Wait for the real collector to commit. */ }
    if (saved?.seen.includes(e.id) && !(await readdir(join(dir, 'spool'))).length) break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(saved?.seen.includes(e.id));
  assert.equal((await readdir(join(dir, 'spool'))).length, 0);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  await assert.rejects(startServer({ port: 0, dataDir: dir }), /lock/i);
  // Only this test's child existed, and its exit has been awaited. This is not
  // automatic lock reclamation in the application or in the user's data directory.
  await rm(join(dir, 'collector.lock'));
  await enqueue(dir, e);
  const restarted = await startServer({ port: 0, dataDir: dir }); t.after(() => restarted.close());
  assert.equal(restarted.store.count, 1);
  assert.equal(restarted.store.snapshot().tasks[0].history.length, 1);
  assert.equal(restarted.store.snapshot().tasks[0].displayState, 'unknown');
  assert.equal((await readdir(join(dir, 'spool'))).length, 0);
});
