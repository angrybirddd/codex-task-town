import { ROLES, STATES, validEvent } from './normalize.mjs';
const ACTIVE = new Set(['thinking', 'coding', 'reading', 'testing', 'running', 'waiting', 'review']);
const ID = /^[a-f0-9]{20}$/;
const TOOL = new Set(['PreToolUse', 'PermissionRequest', 'PostToolUse']);

export class TownStore {
  constructor({ staleMs = 120000, maxTasks = 200 } = {}) {
    this.staleMs = staleMs; this.maxTasks = maxTasks;
    this.tasks = new Map(); this.seen = new Set(); this.count = 0; this.lastHookAt = 0;
  }
  ingest(e) {
    if (!validEvent(e) || this.seen.has(e.id) || e.at > Date.now() + 60000) return false;
    this.seen.add(e.id);
    if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value);
    this.count++; this.lastHookAt = Math.max(this.lastHookAt, e.at);
    let t = this.tasks.get(e.taskId);
    if (!t) {
      if (this.tasks.size >= this.maxTasks) {
        const oldest = [...this.tasks.values()].sort((a, b) => a.lastAt - b.lastAt)[0];
        this.tasks.delete(oldest.id);
      }
      t = { id: e.taskId, parentTaskId: e.parentTaskId || '', projectId: e.projectId, role: e.role,
        title: `${ROLES[e.role]} · ${e.taskId.slice(0, 4)}`, createdAt: e.at, lastAt: 0,
        state: 'unknown', summary: '等待任务信号', turnId: '', pending: {}, approvals: {},
        completed: [], closedTurns: [], boundaryAt: 0, history: [], restored: false };
      this.tasks.set(t.id, t);
    }
    // A result from a previous turn must never revive the current one.
    if (e.turnId && t.closedTurns.includes(e.turnId)) return false;
    const older = e.at < t.lastAt;
    const sameTurn = !e.turnId || !t.turnId || e.turnId === t.turnId;
    // Delayed parallel tool events still reconcile their own call, but not across a lifecycle boundary.
    if (older && !(TOOL.has(e.type) && sameTurn && e.at > t.boundaryAt)) return false;
    if (['PreToolUse', 'PermissionRequest'].includes(e.type) && e.callId && t.completed.includes(e.callId)) return false;
    if (e.turnId && t.turnId !== e.turnId) {
      if (t.turnId) t.closedTurns = [...t.closedTurns, t.turnId].slice(-32);
      t.turnId = e.turnId; t.pending = {}; t.approvals = {}; t.completed = [];
    }
    t.lastAt = Math.max(t.lastAt, e.at); t.restored = false;
    if (t.role === 'general' && e.role !== 'general') {
      t.role = e.role; t.title = `${ROLES[e.role]} · ${t.id.slice(0, 4)}`;
    }
    const set = (state, summary) => { t.state = state; t.summary = summary; };
    const clear = () => { t.pending = {}; t.approvals = {}; t.boundaryAt = Math.max(t.boundaryAt, e.at); };
    const work = () => {
      if (Object.keys(t.approvals).length) return set('waiting', '有操作申请审批，等待后续信号');
      const latest = Object.values(t.pending).sort((a, b) => b.at - a.at)[0];
      if (latest) set(latest.state, latest.summary);
      else if (e.failed) set('error', '工具返回失败，等待后续处理');
      else set('thinking', '操作已返回，继续分析');
    };
    switch (e.type) {
      case 'SessionStart':
        if (e.source === 'compact') set('thinking', '上下文整理后继续工作');
        else { clear(); set('unknown', '会话已打开，等待任务活动'); }
        break;
      case 'SubagentStart': clear(); set('thinking', '子任务已启动，等待活动'); break;
      case 'UserPromptSubmit': clear(); t.completed = []; set('thinking', '收到任务，正在分析'); break;
      case 'PreToolUse': {
        const key = e.callId || e.toolKey || e.id;
        t.pending[key] = { state: e.activity, summary: e.summary, at: e.at, toolKey: e.toolKey || '' };
        if (Object.keys(t.pending).length > 128) delete t.pending[Object.keys(t.pending)[0]];
        work(); break;
      }
      case 'PermissionRequest': {
        const key = e.callId || e.toolKey || e.id;
        t.approvals[key] = { toolKey: e.toolKey || '', at: e.at };
        if (Object.keys(t.approvals).length > 128) delete t.approvals[Object.keys(t.approvals)[0]];
        work(); break;
      }
      case 'PostToolUse': {
        if (e.callId) {
          delete t.pending[e.callId]; delete t.approvals[e.callId];
          t.completed.push(e.callId); t.completed = t.completed.slice(-128);
        }
        // PermissionRequest may omit tool_use_id. Clear only its matching fingerprint;
        // an unrelated completed command must not hide another outstanding approval.
        if (e.toolKey) {
          if (t.approvals[e.toolKey]?.at <= e.at) delete t.approvals[e.toolKey];
          if (t.pending[e.toolKey]?.at <= e.at) delete t.pending[e.toolKey];
        }
        work(); break;
      }
      case 'PreCompact': set('thinking', '正在整理上下文'); break;
      case 'PostCompact': set('thinking', '上下文已整理，继续工作'); break;
      case 'Stop':
      case 'SubagentStop': clear(); set('review', '观察到本轮收尾，不代表整个任务完成'); break;
      case 'Interrupt':
      case 'SessionEnd':
        clear();
        if (t.turnId) t.closedTurns = [...t.closedTurns, t.turnId].slice(-32);
        set(e.type === 'Interrupt' ? 'paused' : 'ended', e.type === 'Interrupt' ? '已中断，等待继续' : '会话已关闭'); break;
    }
    t.history.push({ at: e.at, type: e.type, state: t.state, summary: older ? '收到迟到工具事件，已核对并行操作' : t.summary });
    t.history.sort((a, b) => b.at - a.at); t.history = t.history.slice(0, 16);
    return true;
  }
  snapshot(now = Date.now()) {
    return { version: 1, serverTime: now, staleMs: this.staleMs, lastHookAt: this.lastHookAt, eventCount: this.count,
      tasks: [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt).map(t => {
        const stale = t.restored || (ACTIVE.has(t.state) && now - t.lastAt > this.staleMs);
        const { pending, approvals, completed, closedTurns, boundaryAt, restored, ...safe } = t;
        return { ...safe, stale, displayState: stale ? 'unknown' : t.state,
          pendingTools: Object.keys(pending).length, pendingApprovals: Object.keys(approvals).length };
      }) };
  }
  serialize() {
    return JSON.stringify({ version: 1, count: this.count, lastHookAt: this.lastHookAt,
      seen: [...this.seen], tasks: [...this.tasks.values()] });
  }
  restore(data) {
    if (data?.version !== 1 || !Array.isArray(data.tasks)) return;
    for (const t of data.tasks.slice(-this.maxTasks)) {
      if (!ID.test(t?.id) || !ID.test(t?.projectId) || !Object.hasOwn(ROLES, t.role) ||
          !STATES.includes(t.state) || !Number.isSafeInteger(t.lastAt) ||
          !Number.isSafeInteger(t.createdAt) || typeof t.summary !== 'string' || !Array.isArray(t.history)) continue;
      const pending = {}, approvals = {};
      if (t.pending && typeof t.pending === 'object') for (const [key, v] of Object.entries(t.pending).slice(0, 128)) {
        if (/^[a-f0-9-]{20,80}$/.test(key) && v && STATES.includes(v.state) && typeof v.summary === 'string' && Number.isSafeInteger(v.at))
          pending[key] = { state: v.state, summary: v.summary.slice(0, 100), at: v.at, toolKey: ID.test(v.toolKey) ? v.toolKey : '' };
      }
      if (t.approvals && typeof t.approvals === 'object') for (const [key, v] of Object.entries(t.approvals).slice(0, 128)) {
        if (/^[a-f0-9-]{20,80}$/.test(key) && v && Number.isSafeInteger(v.at)) approvals[key] = { at: v.at, toolKey: ID.test(v.toolKey) ? v.toolKey : '' };
      }
      this.tasks.set(t.id, { id: t.id, parentTaskId: ID.test(t.parentTaskId) ? t.parentTaskId : '', projectId: t.projectId, role: t.role,
        title: `${ROLES[t.role]} · ${t.id.slice(0, 4)}`, createdAt: t.createdAt, lastAt: t.lastAt,
        state: t.state, summary: t.summary.slice(0, 100), turnId: ID.test(t.turnId) ? t.turnId : '',
        pending, approvals, completed: (Array.isArray(t.completed) ? t.completed : []).filter(s => ID.test(s)).slice(-128),
        closedTurns: (Array.isArray(t.closedTurns) ? t.closedTurns : []).filter(s => ID.test(s)).slice(-32),
        boundaryAt: Number.isSafeInteger(t.boundaryAt) ? t.boundaryAt : 0,
        history: t.history.filter(h => h && Number.isSafeInteger(h.at) && STATES.includes(h.state) && typeof h.summary === 'string')
          .slice(0, 16).map(h => ({ at: h.at, type: String(h.type).slice(0, 32), state: h.state, summary: h.summary.slice(0, 100) })),
        restored: ACTIVE.has(t.state) });
    }
    this.seen = new Set((Array.isArray(data.seen) ? data.seen : []).filter(s => typeof s === 'string' && s.length <= 80).slice(-4096));
    this.count = Number.isSafeInteger(data.count) && data.count >= 0 ? data.count : 0;
    this.lastHookAt = Number.isSafeInteger(data.lastHookAt) && data.lastHookAt >= 0 ? data.lastHookAt : 0;
  }
}
