import { ROLES, STATES, validEvent, isId } from './normalize.mjs';
const ACTIVE = new Set(['thinking', 'coding', 'reading', 'testing', 'running', 'waiting', 'review', 'error']);
const ID = { test: isId };
const TOOL = new Set(['PreToolUse', 'PermissionRequest', 'PostToolUse']);

export class TownStore {
  constructor({ staleMs = 120000, maxTasks = 200 } = {}) {
    if (!Number.isFinite(staleMs) || staleMs <= 0 || !Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 200)
      throw new Error('Invalid store limits');
    this.staleMs = staleMs; this.maxTasks = maxTasks;
    this.tasks = new Map(); this.seen = new Set(); this.count = 0; this.lastHookAt = 0; this.realCount = 0; this.lastRealHookAt = 0;
  }
  ingest(e) {
    if (!validEvent(e) || this.seen.has(e.id) || e.at > Date.now() + 60000) return false;
    this.seen.add(e.id);
    if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value);
    this.count++; this.lastHookAt = Math.max(this.lastHookAt, e.at);
    if (e.synthetic === false) { this.realCount++; this.lastRealHookAt = Math.max(this.lastRealHookAt, e.at); }
    let t = this.tasks.get(e.taskId);
    if (!t) {
      if (this.tasks.size >= this.maxTasks) {
        const oldest = [...this.tasks.values()].sort((a, b) => a.lastAt - b.lastAt)[0];
        this.tasks.delete(oldest.id);
      }
      t = { id: e.taskId, parentTaskId: e.parentTaskId || '', projectId: e.projectId, role: e.role, synthetic: e.synthetic === true, legacy: e.synthetic === undefined,
        title: `${ROLES[e.role]} · ${e.taskId.slice(0, 4)}`, createdAt: e.at, lastAt: 0,
        state: 'unknown', summary: '等待任务信号', turnId: '', pending: {}, approvals: {},
        completed: [], results: [], closedTurns: [], boundaryAt: 0, fenced: false, uncertain: false, history: [], restored: false };
      this.tasks.set(t.id, t);
    }
    // A result from a previous turn must never revive the current one.
    if (e.type !== 'SessionEnd' && e.turnId && t.closedTurns.includes(e.turnId)) return false;
    if (TOOL.has(e.type) && !e.turnId && ['paused', 'ended'].includes(t.state)) return false;
    if (TOOL.has(e.type) && !e.turnId && t.turnId && !(e.callId && Object.hasOwn(t.pending, e.callId))) {
      t.uncertain = true; return true;
    }
    const older = e.at < t.lastAt;
    const previousLastAt = t.lastAt, wasRestored = t.restored;
    const sameTurn = !e.turnId || !t.turnId || e.turnId === t.turnId;
    // Delayed parallel tool events still reconcile their own call, but not across a lifecycle boundary.
    if (older && !(TOOL.has(e.type) && sameTurn && e.at >= t.boundaryAt)) return false;
    if (['PreToolUse', 'PermissionRequest'].includes(e.type) && e.callId && t.completed.includes(e.callId)) return false;
    const newTurn = Boolean(e.turnId && t.turnId !== e.turnId);
    if (newTurn && t.turnId && !['UserPromptSubmit', 'SubagentStart', 'SessionEnd'].includes(e.type)) {
      t.uncertain = true; return true; // A missing turn-start is not permission to rewind another turn.
    }
    if (newTurn) {
      if (t.turnId) t.closedTurns = [...t.closedTurns, t.turnId].slice(-32);
      t.turnId = e.turnId; t.pending = {}; t.approvals = {}; t.completed = []; t.results = []; t.fenced = false; t.uncertain = false;
    }
    t.lastAt = Math.max(t.lastAt, e.at); t.restored = false;
    t.synthetic = e.synthetic === true; t.legacy = e.synthetic === undefined;
    if (t.role === 'general' && e.role !== 'general') {
      t.role = e.role; t.title = `${ROLES[e.role]} · ${t.id.slice(0, 4)}`;
    }
    const set = (state, summary) => { t.state = state; t.summary = summary; };
    const clear = () => { t.pending = {}; t.approvals = {}; t.boundaryAt = Math.max(t.boundaryAt, e.at); };
    const work = () => {
      if (t.fenced) return set('unknown', '收尾后的事件可能迟到，等待新回合确认');
      if (Object.keys(t.approvals).length) return set('waiting', '有操作申请审批，等待后续信号');
      const latest = Object.values(t.pending).sort((a, b) => b.at - a.at)[0];
      if (latest) set(latest.state, latest.summary);
      else if (e.failed) set('error', '工具返回失败，等待后续处理');
      else set('thinking', '操作已返回，继续分析');
    };
    switch (e.type) {
      case 'SessionStart':
        if (e.source === 'compact') set('thinking', '上下文整理后继续工作');
        else {
          if (t.turnId && (Object.keys(t.pending).length || Object.keys(t.approvals).length)) {
            t.lastAt = previousLastAt; t.restored = wasRestored; break;
          }
          clear(); set('unknown', '会话已打开，等待任务活动');
        }
        break;
      case 'SubagentStart':
      case 'UserPromptSubmit':
        // A queued prompt/start from this SAME turn may arrive after its tools.
        if (!newTurn && !t.fenced && (Object.keys(t.pending).length || Object.keys(t.approvals).length || t.completed.length)) break;
        clear(); t.completed = []; t.results = []; t.fenced = false; t.uncertain = false;
        set('thinking', e.type === 'SubagentStart' ? '子任务已启动，等待活动' : '收到任务，正在分析'); break;
      case 'PreToolUse': {
        const key = e.callId || e.id;
        t.pending[key] = { state: e.activity, summary: e.summary, at: e.at, toolKey: e.toolKey || '' };
        if (Object.keys(t.pending).length > 128) { delete t.pending[Object.keys(t.pending)[0]]; t.uncertain = true; }
        work(); break;
      }
      case 'PermissionRequest': {
        const candidates = Object.entries(t.pending).filter(([, v]) => e.toolKey && v.toolKey === e.toolKey);
        if (!e.callId && !candidates.length && t.results.some(r => r.toolKey === e.toolKey && e.at <= r.at)) break;
        if (!e.callId && (candidates.length > 1 || (!candidates.length && t.results.some(r => r.toolKey === e.toolKey)))) t.uncertain = true;
        const key = e.callId || (candidates.length === 1 ? candidates[0][0] : e.id);
        t.approvals[key] = { toolKey: e.toolKey || '', at: e.at };
        if (Object.keys(t.approvals).length > 128) { delete t.approvals[Object.keys(t.approvals)[0]]; t.uncertain = true; }
        work(); break;
      }
      case 'PostToolUse': {
        if (e.callId) {
          delete t.pending[e.callId]; delete t.approvals[e.callId];
          if (!t.completed.includes(e.callId)) t.completed.push(e.callId);
          if (t.completed.length > 128) { t.completed = t.completed.slice(-128); t.uncertain = true; }
        }
        // Only resolve one unambiguous orphan. Identical concurrent commands do not
        // provide enough evidence to clear each other's approvals.
        if (e.toolKey) {
          const stillRunning = Object.values(t.pending).some(v => v.toolKey === e.toolKey);
          const orphans = Object.entries(t.approvals).filter(([key, v]) =>
            !Object.hasOwn(t.pending, key) && v.toolKey === e.toolKey && v.at <= e.at);
          if (!stillRunning && orphans.length === 1) delete t.approvals[orphans[0][0]];
          const anonymous = Object.entries(t.pending).filter(([key, v]) => key.includes('-') && v.toolKey === e.toolKey && v.at <= e.at);
          if (!e.callId && anonymous.length === 1) delete t.pending[anonymous[0][0]];
          t.results.push({ toolKey: e.toolKey, at: e.at }); t.results = t.results.slice(-128);
        }
        work(); break;
      }
      case 'PreCompact':
        if (Object.keys(t.approvals).length || Object.keys(t.pending).length) work();
        else set('thinking', '正在整理上下文'); break;
      case 'PostCompact':
        if (Object.keys(t.approvals).length || Object.keys(t.pending).length) work();
        else set('thinking', '上下文已整理，继续工作'); break;
      case 'Stop':
      case 'SubagentStop': clear(); t.fenced = true; set('review', '观察到本轮收尾，不代表整个任务完成'); break;
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
    return { version: 1, serverTime: now, staleMs: this.staleMs, lastHookAt: this.lastHookAt, eventCount: this.count, realEventCount: this.realCount, lastRealHookAt: this.lastRealHookAt,
      tasks: [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt).map(t => {
        const stale = t.uncertain || t.restored || (ACTIVE.has(t.state) && now - t.lastAt > this.staleMs);
        const { pending, approvals, completed, results, closedTurns, boundaryAt, fenced, uncertain, restored, ...safe } = t;
        return { ...safe, stale, unknownReason: t.uncertain ? 'correlation-limit' : t.restored ? 'restart' : stale ? 'stale' : '', displayState: stale ? 'unknown' : t.state,
          pendingTools: Object.keys(pending).length, pendingApprovals: Object.keys(approvals).length };
      }) };
  }
  serialize() {
    return JSON.stringify({ version: 1, count: this.count, lastHookAt: this.lastHookAt, realCount: this.realCount, lastRealHookAt: this.lastRealHookAt,
      seen: [...this.seen], tasks: [...this.tasks.values()] });
  }
  restore(data) {
    if (data?.version !== 1 || !Array.isArray(data.tasks)) return;
    for (const t of data.tasks.slice(-this.maxTasks)) {
      if (!ID.test(t?.id) || !ID.test(t?.projectId) || (typeof t.role !== 'string' || !Object.hasOwn(ROLES, t.role)) ||
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
      this.tasks.set(t.id, { id: t.id, parentTaskId: ID.test(t.parentTaskId) ? t.parentTaskId : '', projectId: t.projectId, role: t.role, synthetic: t.synthetic === true, legacy: t.legacy !== false,
        title: `${ROLES[t.role]} · ${t.id.slice(0, 4)}`, createdAt: t.createdAt, lastAt: t.lastAt,
        state: t.state, summary: t.summary.slice(0, 100), turnId: ID.test(t.turnId) ? t.turnId : '',
        pending, approvals, completed: (Array.isArray(t.completed) ? t.completed : []).filter(s => ID.test(s)).slice(-128),
        results: (Array.isArray(t.results) ? t.results : []).filter(r => r && isId(r.toolKey) && Number.isSafeInteger(r.at)).slice(-128),
        fenced: t.fenced === true || t.state === 'review', uncertain: t.uncertain === true,
        closedTurns: (Array.isArray(t.closedTurns) ? t.closedTurns : []).filter(s => ID.test(s)).slice(-32),
        boundaryAt: Number.isSafeInteger(t.boundaryAt) ? t.boundaryAt : 0,
        history: t.history.filter(h => h && Number.isSafeInteger(h.at) && STATES.includes(h.state) && typeof h.summary === 'string')
          .slice(0, 16).map(h => ({ at: h.at, type: String(h.type).slice(0, 32), state: h.state, summary: h.summary.slice(0, 100) })),
        restored: ACTIVE.has(t.state) });
    }
    this.realCount = Number.isSafeInteger(data.realCount) && data.realCount >= 0 ? data.realCount : 0;
    this.lastRealHookAt = Number.isSafeInteger(data.lastRealHookAt) && data.lastRealHookAt >= 0 ? data.lastRealHookAt : 0;
    this.seen = new Set((Array.isArray(data.seen) ? data.seen : []).filter(s => typeof s === 'string' && s.length <= 80).slice(-4096));
    this.count = Number.isSafeInteger(data.count) && data.count >= 0 ? data.count : 0;
    this.lastHookAt = Number.isSafeInteger(data.lastHookAt) && data.lastHookAt >= 0 ? data.lastHookAt : 0;
  }
}
