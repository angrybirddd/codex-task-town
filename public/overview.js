import { DEFAULT_CURRENT_WINDOW_MS, rosterScope, scopeTasks, rosterCounts } from './lifecycle.js';
// One view model for counters, worklist and scene: never infer task activity here.
export const LABELS = { thinking: '分析中', coding: '编码中', reading: '阅读中', testing: '测试中', running: '执行中',
  waiting: '等待审批', idle: '休息 / 待命', review: '本轮收尾', paused: '已中断', ended: '会话关闭', error: '工具失败', unknown: '状态待确认' };
export const ROLES = { frontend: '前端工程师', backend: '后端工程师', testing: '测试工程师', docs: '文档工程师', ops: '运维工程师', general: '工程师' };
export const ACTIVE = ['thinking', 'coding', 'reading', 'testing', 'running'];
export const GROUPS = { active: '主任务 · 工作中', waiting: '主任务 · 需留意', quiet: '主任务 · 收尾 / 暂停 / 待命', children: '子任务 · 不计入主任务数', archived: '历史记录 · 不代表需求完成', reference: '自检 / 旧版来源参考' };
export function category(t) {
  if (t.synthetic || t.legacy) return 'reference';
  if (['children', 'archived'].includes(t.scope)) return t.scope;
  if (ACTIVE.includes(t.displayState)) return 'active';
  return ['waiting', 'unknown', 'error'].includes(t.displayState) ? 'waiting' : 'quiet';
}
export function presentTask(t, { alias = {}, now = Date.now(), connected = true, collectorError = false,
  staleMs = 120000, mode = 'live', index = 0, currentWindowMs = DEFAULT_CURRENT_WINDOW_MS } = {}) {
  const oldSignal = [...ACTIVE, 'waiting', 'review', 'error'].includes(t.state) && now - t.lastAt > staleMs;
  const stale = mode === 'live' && (!connected || collectorError || t.stale || oldSignal);
  const displayState = stale ? 'unknown' : t.displayState || t.state;
  const hasAlias = typeof alias.title === 'string' && Boolean(alias.title.trim());
  const generated = !t.title || t.title === `${ROLES[t.role]} · ${t.id.slice(0, 4)}`;
  const unnamed = !hasAlias && t.titleSource !== 'shared' && generated;
  const title = hasAlias ? alias.title.trim().slice(0, 64) : unnamed ? `未命名任务 · ${t.id.slice(0, 4)}` : t.title;
  const scope = rosterScope(t, now, currentWindowMs);
  const evidenceOnly = stale || displayState === 'unknown' || scope.scope === 'archived';
  return { ...t, ...scope, title, unnamed, number: String(index + 1).padStart(2, '0'), room: Math.floor(index / 8) + 1,
    role: Object.hasOwn(ROLES, alias.role) ? alias.role : t.role, displayState, stale,
    titleSource: hasAlias ? 'browser' : t.titleSource === 'shared' ? 'shared' : unnamed ? 'generated' : 'source',
    activityText: evidenceOnly ? `上次：${t.summary}` : t.summary,
    signalNote: t.synthetic ? '自检信号，非真实工作' : t.legacy ? '历史记录，来源待确认' :
      !connected ? '连接已断开，不能确认当前工作' : collectorError ? '采集异常，不能确认当前工作' :
      evidenceOnly ? '缺少足够新证据，不代表正在工作' : '依据最近事件，不是持续运行保证' };
}
export function matchesTask(t, filter = 'all', query = '') {
  const needle = query.trim().toLowerCase();
  return ((filter === 'all' && !['reference', 'archived'].includes(category(t))) || category(t) === filter) && (!needle ||
    [t.title, t.id, t.number, ROLES[t.role], t.projectLabel, t.summary, LABELS[t.displayState]].join(' ').toLowerCase().includes(needle));
}
export function overview(all, { filter = 'all', query = '', now = Date.now(), currentWindowMs = DEFAULT_CURRENT_WINDOW_MS } = {}) {
  const records = scopeTasks(all, { now, currentWindowMs }).map(t => ({ ...t,
    activityText: t.scope === 'archived' && !t.activityText?.startsWith('上次：') ? `上次：${t.summary}` : t.activityText }));
  const count = rosterCounts(records);
  const counts = { all: count.current, active: count.working, waiting: count.attention, quiet: count.quiet,
    children: count.children, archived: count.archived, reference: count.reference, retained: count.retained };
  // History and probes do not consume current-room seats. Normal status/search filters
  // still preserve seating within the current pool; numbering uses stable record order.
  const pool = records.filter(t => filter === 'archived' ? t.scope === 'archived' :
    filter === 'reference' ? t.scope === 'reference' : ['current', 'children'].includes(t.scope))
    .map((t, i) => ({ ...t, room: Math.floor(i / 8) + 1 }));
  const matching = pool.filter(t => matchesTask(t, filter, query));
  const rows = Object.keys(GROUPS).flatMap(group => matching.filter(t => category(t) === group));
  const rooms = [];
  for (let i = 0; i < pool.length; i += 8) {
    const tasks = pool.slice(i, i + 8).filter(t => matchesTask(t, filter, query));
    if (tasks.length) rooms.push({ number: Math.floor(i / 8) + 1, tasks });
  }
  return { counts, rows, rooms, stageTasks: pool, records };
}
