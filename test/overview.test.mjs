import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { presentTask, overview, category, matchesTask } from '../public/overview.js';
import { loadLabels, validateLabels, applyLabels } from '../src/labels.mjs';
import { startServer } from '../src/start.mjs';
const now = Date.now(), id = 'a'.repeat(20), projectId = 'b'.repeat(20);
const task = (extra = {}) => ({ id, projectId, title: `前端工程师 · ${id.slice(0, 4)}`, role: 'frontend', state: 'coding', displayState: 'coding',
  summary: '正在修改代码', lastAt: now, createdAt: now, history: [], ...extra });
const show = (t, i = 0, options = {}) => presentTask(t, { now, index: i, ...options });

test('work count equals named cross-room rows, not only the eight visible seats', () => {
  const all = Array.from({ length: 20 }, (_, i) => show(task({ id: String(i).padStart(20, '0'), state: i % 5 === 0 ? 'coding' : 'ended', displayState: i % 5 === 0 ? 'coding' : 'ended' }), i));
  const view = overview(all, { filter: 'active' });
  assert.equal(view.counts.active, 4); assert.equal(view.rows.length, 4);
  assert.deepEqual(view.rows.map(t => t.number), ['01', '06', '11', '16']);
  assert.equal(view.rooms.length, 1); // closed records no longer consume current-room seats
  assert.equal(view.rooms.flatMap(r => r.tasks).length, view.rows.length);
  assert.deepEqual(view.rows.map(t => t.room), [1, 1, 1, 1]);
});
test('filters and action/project search preserve resident number and logical room', () => {
  const t = show(task({ title: '修复登录权限', projectLabel: '青山后台', summary: '正在运行权限测试' }), 17);
  for (const query of ['权限', '青山', '18', id, '测试']) assert.equal(matchesTask(t, 'all', query), true);
  assert.equal(matchesTask(t, 'quiet', '权限'), false);
  assert.equal(t.room, 3); assert.equal(t.number, '18');
});
test('synthetic and legacy records cannot inflate the work count', () => {
  const all = [show(task()), show(task({ id:'c'.repeat(20), synthetic:true })), show(task({ id:'d'.repeat(20), legacy:true }))];
  const view = overview(all);
  assert.equal(view.counts.active, 1); assert.equal(view.counts.reference, 2); assert.equal(view.counts.all, 1); assert.equal(view.counts.retained, 3);
  assert.equal(overview(all, {filter:'reference'}).rows.length, 2);
});
test('expired evidence is labelled as previous activity and excluded from work count', () => {
  const t = show(task({ lastAt:now - 120001 }));
  assert.equal(t.displayState, 'unknown'); assert.equal(category(t), 'waiting');
  assert.equal(t.activityText, '上次：正在修改代码'); assert.equal(overview([t]).counts.active, 0);
});
test('disconnected or unhealthy collector never presents previous action as current', () => {
  for (const options of [{connected:false}, {collectorError:true}]) {
    const t = show(task(), 0, options);
    assert.equal(t.stale, true); assert.equal(t.displayState,'unknown'); assert.match(t.signalNote, /不能确认/);
    assert.equal(overview([t]).counts.active, 0);
  }
});
test('role names are not represented as real task objectives; explicit titles are respected', () => {
  const t = show(task()); assert.equal(t.unnamed, true); assert.match(t.title, /^未命名任务/);
  const named = show(task({title:'修复登录权限',titleSource:'shared'}));
  assert.equal(named.unnamed, false); assert.equal(named.titleSource, 'shared');
  const alias = show(task({title:'修复登录权限',titleSource:'shared'}), 0, {alias:{title:'个人的标签',role:'testing'}});
  assert.equal(alias.titleSource, 'browser'); assert.equal(alias.role,'testing');
});
test('same-state generic summary does not become an invented description', () => {
  assert.equal(show(task()).activityText, '正在修改代码');
  const unknown = show(task({displayState:'unknown', unknownReason:'correlation-limit'}));
  assert.equal(unknown.activityText,'上次：正在修改代码'); assert.equal(category(unknown),'waiting');
});
test('labels are explicit hashed ID maps with bounded text, not arbitrary JSON forwarded to clients', () => {
  const labels=validateLabels({version:1,tasks:{[id]:' 修复登录权限 '},projects:{[projectId]:'青山后台'}});
  assert.equal(labels.tasks[id], '修复登录权限');
  for (const data of [null, [], {version:2}, {version:1,token:'secret'}, {version:1,tasks:{raw_session_id:'x'}},
    {version:1,tasks:{[id]:'a'.repeat(65)}}, {version:1,tasks:{[id]:'hello\nsecret'}}, {version:1,tasks:{[id]:'a\u202eb'}},
    {version:1,tasks:{[id]:{title:'x',prompt:'secret'}}}]) assert.throws(()=>validateLabels(data));
});
test('display labels never change original snapshot, event summary, identity or task state', () => {
  const original={tasks:[task()], eventCount:1}, before=JSON.stringify(original);
  const labels=validateLabels({version:1,tasks:{[id]:'登录权限修复'},projects:{[projectId]:'青山后台'}});
  const display=applyLabels(original, labels);
  assert.equal(display.tasks[0].title, '登录权限修复'); assert.equal(display.tasks[0].projectLabel,'青山后台');
  assert.equal(display.tasks[0].summary, original.tasks[0].summary); assert.equal(display.tasks[0].id,id);
  assert.equal(JSON.stringify(original),before);
});
test('shared labels load as optional regular file; invalid configuration leaves no collector lock', async () => {
  const dir=await mkdtemp(join(tmpdir(),'town-labels-'));
  try {
    assert.deepEqual(await loadLabels(dir), {version:1,tasks:{},projects:{}});
    await writeFile(join(dir,'labels.json'),'not json'); await assert.rejects(startServer({port:0,dataDir:dir}), /labels/);
    await rm(join(dir,'labels.json')); await writeFile(join(dir,'other.json'),'{}');
    await symlink(join(dir,'other.json'),join(dir,'labels.json')); await assert.rejects(loadLabels(dir), /labels/);
    await rm(join(dir,'labels.json'));
    const app=await startServer({port:0,dataDir:dir}); await app.close();
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('real HTTP applies shared labels for all viewers without changing hook or authentication', async () => {
  const dir=await mkdtemp(join(tmpdir(),'town-label-http-'));
  let app;
  try {
    await writeFile(join(dir,'labels.json'),JSON.stringify({version:1,tasks:{[id]:'共享任务名'},projects:{[projectId]:'共享项目'}}));
    app=await startServer({port:0,dataDir:dir,token:'test-read-only-token'});
    app.store.tasks.set(id,{...task(), pending:{},completed:[],approvals:{},closedTurns:[],restored:false});
    const url=`http://127.0.0.1:${app.address.port}`;
    assert.equal((await fetch(url+'/api/snapshot')).status,401);
    for (let i=0;i<2;i++) {
      const data=await (await fetch(url+'/api/snapshot',{headers:{Authorization:'Bearer test-read-only-token'}})).json();
      assert.equal(data.tasks[0].title,'共享任务名');assert.equal(data.tasks[0].projectLabel,'共享项目');
    }
    const module=await fetch(url+'/app.js');assert.equal(module.status,200);assert.match(module.headers.get('content-type'),/javascript/);
    assert.equal((await fetch(url+'/api/labels',{method:'POST',body:'{}'})).status,405);
  } finally { if(app) await app.close();await rm(dir,{recursive:true,force:true}); }
});
