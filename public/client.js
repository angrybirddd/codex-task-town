import { TownScene, avatar } from './scene.js';
import { ACTIVE, LABELS, ROLES, GROUPS, category, presentTask, overview } from './overview.js';
import { StudioLayout, WIDTH, HEIGHT } from './layout.js';
import { DEFAULT_CURRENT_WINDOW_MS } from './lifecycle.js';
const layout = new StudioLayout();
const $ = id => document.getElementById(id);
const scene = new TownScene($('town'), $('portrait'));
let mode = new URLSearchParams(location.search).get('demo') === '1' ? 'demo' : 'live';
let tasks = [], selectedId = '', page = 0, filter = 'all', connected = false, eventCount = 0, lastHookAt = 0;
let events, generation = 0, demoTimer, serverOffset = 0, collectorError = false, connectionText = '正在连接';
let lastSnapshotAt = 0, staleMs = 120000, aliases = {}, token = '', renameTargetId = '';
let realEventCount = 0, lastRealHookAt = 0, currentWindowMs = DEFAULT_CURRENT_WINDOW_MS;
try {
  const saved = JSON.parse(localStorage.getItem('task-town-aliases') || '{}');
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) aliases = saved;
  token = sessionStorage.getItem('task-town-token') || '';
} catch { /* Storage may be disabled. */ }
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('token')) {
  token = fragment.get('token');
  try { sessionStorage.setItem('task-town-token', token); } catch {}
  history.replaceState(null, '', location.pathname + location.search);
}
const speechCache = new Map(), residentNodes = new Map(), listNodes = new Map(), sectionNodes = new Map();
let currentView = { rooms: [], rows: [] };
function node(tag, cls, text) { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; }
function age(at) {
  const seconds = Math.max(0, Math.floor((Date.now() + serverOffset - at) / 1000));
  return !at ? '尚未收到' : seconds < 5 ? '刚刚' : seconds < 60 ? `${seconds} 秒前` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟前` : `${Math.floor(seconds / 3600)} 小时前`;
}
function displayTask(t, index) {
  return presentTask(t, { alias: aliases[t.id] || {}, now: Date.now() + serverOffset,
    connected, collectorError, staleMs, mode, index, currentWindowMs });
}
function focusTask(id, details = false) {
  const room = currentView.rooms.findIndex(r => r.tasks.some(t => t.id === id));
  if (room < 0) return;
  page = room; selectedId = id; render();
  const el = residentNodes.get(id), scroll = document.querySelector('.stage-scroll');
  if (el && scroll) {
    const slot = layout.get(id);
    scroll.scrollLeft = slot.x / WIDTH * $('stage').clientWidth - scroll.clientWidth / 2;
  }
  if (details && !$('detail-dialog').open) $('detail-dialog').showModal();
  // A list click does not cover the selected character with a dialog.
}
function renderRoster(rows, visible) {
  const target = $('task-list'), desired = [], keep = new Set();
  for (const [group, title] of Object.entries(GROUPS)) {
    const members = rows.filter(t => category(t) === group);
    if (!members.length) continue;
    let heading = sectionNodes.get(group);
    if (!heading) { heading = node('h4', 'roster-group'); sectionNodes.set(group, heading); }
    heading.textContent = `${title} · ${members.length}`; desired.push(heading);
    for (const t of members) {
      keep.add(t.id);
      let card = listNodes.get(t.id);
      if (!card) {
        card = node('article', 'task-card'); card.dataset.taskId = t.id;
        const button = node('button', 'task-row'); button.type = 'button';
        const face = node('span', 'roster-face'), canvas = node('canvas', 'roster-avatar');
        canvas.width = 48; canvas.height = 50; canvas.setAttribute('aria-hidden', 'true');
        face.append(canvas, node('b', 'roster-number'));
        const info = node('span', 'roster-info');
        info.append(node('strong', 'roster-name'), node('span', 'roster-project'), node('span', 'roster-status'), node('span', 'roster-action'));
        button.append(face, info); button.onclick = () => focusTask(t.id);
        const footer = node('div', 'roster-footer');
        const detail = node('button', 'task-details', '详情 / 命名 ↗'); detail.type = 'button'; detail.onclick = () => focusTask(t.id, true);
        footer.append(node('small', 'roster-time'), detail);
        card.append(button, footer); listNodes.set(t.id, card);
      }
      card.className = `task-card category-${group}${t.id === selectedId ? ' selected' : ''}`;
      card.dataset.state = t.displayState;
      const button = card.querySelector('.task-row');
      button.setAttribute('aria-pressed', String(t.id === selectedId));
      button.setAttribute('aria-label', `${t.number} 号 ${t.title}，${LABELS[t.displayState]}，${t.activityText}，第 ${t.room} 间`);
      card.querySelector('.roster-number').textContent = t.number;
      card.querySelector('.roster-name').textContent = `${t.synthetic ? '[自检] ' : t.legacy ? '[历史] ' : ''}${t.title}`;
      const parent = tasks.find(p => p.id === t.parentTaskId);
      const parentLabel = parent ? displayTask(parent, tasks.indexOf(parent)).title : '父任务信号未收到';
      card.querySelector('.roster-project').textContent = t.parentTaskId
        ? `${t.projectLabel ? t.projectLabel + ' · ' : ''}子任务 · 属于 ${parentLabel}`
        : `${t.projectLabel ? t.projectLabel + ' · ' : ''}${ROLES[t.role]}`;
      card.querySelector('.roster-status').textContent = `${group === 'active' ? '●' : group === 'waiting' ? '!' : '◇'} ${LABELS[t.displayState]}`;
      card.querySelector('.roster-action').textContent = t.activityText;
      card.querySelector('.roster-time').textContent = `${t.scope === 'archived' ? t.archiveReason === 'session-ended' ? '会话关闭 · ' : t.archiveReason === 'child-turn-ended' ? '子任务本轮收尾 · ' : '超出近期窗口 · ' : ''}最近信号 ${age(t.lastAt)}${t.titleSource === 'browser' ? ' · 本机名称' : t.titleSource === 'shared' ? ' · 共享名称' : ''}`;
      card.querySelector('.roster-time').title = t.signalNote;
      const canvas = card.querySelector('canvas'), key = `${t.id}:${t.role}:${t.displayState}`;
      if (canvas.dataset.key !== key) { canvas.dataset.key = key; const c = canvas.getContext('2d'); c.clearRect(0, 0, 48, 50); c.imageSmoothingEnabled = false; avatar(c, 23, 46, t, 1, 2); }
      desired.push(card);
    }
  }
  // Preserve button nodes and keyboard focus across every-second age updates.
  desired.forEach((el, i) => { if (target.children[i] !== el) target.insertBefore(el, target.children[i] || null); });
  const wanted = new Set(desired);
  for (const child of [...target.children]) if (!wanted.has(child)) child.remove();
  for (const [id] of listNodes) if (!keep.has(id)) listNodes.delete(id);
  $('worklist-scroll-hint').hidden = target.scrollHeight <= target.clientHeight + 1;
}
function render() {
  currentView = overview(tasks.map(displayTask), { filter, query: $('search').value,
    now: Date.now() + serverOffset, currentWindowMs });
  const all = currentView.records;
  const { rooms, rows, counts } = currentView;
  const pages = Math.max(1, rooms.length);
  page = Math.max(0, Math.min(page, pages - 1));
  const group = rooms[page]?.tasks || [];
  if (!all.some(t => t.id === renameTargetId)) { renameTargetId = ''; $('rename-dialog').close(); }
  if (!group.some(t => t.id === selectedId)) { selectedId = ''; $('detail-dialog').close(); }
  layout.update(currentView.stageTasks, currentView.stageTasks);
  const selected = all.find(t => t.id === selectedId);
  $('total').textContent = counts.all;
  $('working').textContent = counts.active;
  $('waiting').textContent = counts.waiting;
  const scopeLabel = filter === 'all' ? '近期主任务与子任务' : GROUPS[filter];
  $('scope-note').textContent = `近 ${Math.round(currentWindowMs / 60000)} 分钟有事件的未关闭主任务；信号过期显示未知，不当作完成。`;
  $('worklist-summary').textContent = filter === 'all' && !$('search').value.trim()
    ? `${counts.all} 个近期主任务 · ${counts.active} 个有工作信号 · ${counts.children} 个子任务` 
    : `${scopeLabel}：显示 ${rows.length} / ${filter === 'all' ? counts.all + counts.children : counts[filter]} 条${$('search').value.trim() ? ' · 已搜索' : ''}`;
  $('history-count').textContent = counts.archived;
  $('children-count').textContent = counts.children;
  $('reference-count').textContent = counts.reference;
  $('worklist-empty').hidden = rows.length > 0;
  $('worklist-empty').textContent = all.length ? '暂无匹配的近期任务。历史记录仍保留，不计入当前主任务数。' : '尚未收到任务事件。演示可预览名单效果。';
  $('room-context').textContent = rooms[page] ? `第 ${rooms[page].number} 间工作室` : '工作室';
  $('scene-count').textContent = `场景可见 ${group.length} / 匹配 ${rows.length} 个 · 名单覆盖所有房间`;
  $('focus-note').textContent = selected ? `已定位 ${selected.number} 号 · ${selected.title} · ${LABELS[selected.displayState]}` : '任务名称、状态和最近活动均常驻显示；详情只用于查看历史。';
  for (const button of document.querySelectorAll('[data-filter], [data-scope]')) {
    const selected = (button.dataset.filter || button.dataset.scope) === filter;
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
  }
  renderRoster(rows, new Set(group.map(t => t.id)));
  $('connection').textContent = mode === 'demo' ? '演示小镇' : connectionText;
  $('connection').classList.toggle('offline', mode === 'live' && !connected);
  $('town-badge').textContent = mode === 'demo' ? 'DEMO' : 'LIVE';
  $('live-mode').setAttribute('aria-pressed', String(mode === 'live'));
  $('demo-mode').setAttribute('aria-pressed', String(mode === 'demo'));
  $('mode-note').textContent = mode === 'demo' ? '模拟居民，不是你的真实任务' : '只读观察，不打扰 Codex 工作';
  $('town-subtitle').textContent = mode === 'demo' ? '午后的工作室，各自忙碌，刚刚好。' : all.length ? `${counts.active} 个主任务有工作信号 · 名单直接显示各自在做什么` : '等待第一位居民到来';
  $('footer-status').textContent = mode === 'demo' ? '演示数据 · 与真实事件完全隔离' :
    !connected ? '采集器未连接 · 仅供参考' : collectorError ? '采集器异常 · 状态待确认' : lastRealHookAt ? `采集器在线 · 非探针事件 ${age(lastRealHookAt)}` : '采集器在线 · 尚无非探针事件';
  $('event-count').textContent = mode === 'demo' ? 'DEMO · NO MODEL CALLS' : `累计 ${realEventCount} 条工作事件 · ${eventCount - realEventCount} 条自检 / 旧版事件（不是任务数）`;
  $('page-label').textContent = `${page + 1} / ${pages}`;
  $('previous').disabled = page === 0; $('next').disabled = page >= pages - 1;
  $('empty').hidden = group.length > 0;
  $('empty').querySelector('h3').textContent = tasks.length ? '这里暂时没有匹配的居民' : '工作室已经准备好了';
  $('empty').querySelector('p').textContent = tasks.length ? '试试其他关键词或任务状态。' : '连接 Codex Hooks，让你的任务住进来。也可以先逛逛演示小镇。';
  $('empty-demo').hidden = tasks.length > 0;
  const keep = new Set();
  group.forEach(t => {
    keep.add(t.id);
    let el = residentNodes.get(t.id);
    if (!el) {
      el = node('button', 'resident'); el.type = 'button';
      el.append(node('span', 'speech'), node('b', 'resident-number'));
      el.dataset.taskId = t.id;
      const name = node('span', 'nameplate'); name.append(node('i', 'state-dot'), node('span', 'name')); el.append(name); el.append(node('span', 'resident-state'));
      el.onclick = () => focusTask(t.id, true);
      residentNodes.set(t.id, el); $('residents').append(el);
    }
    const slot = layout.get(t.id);
    el.style.left = `${slot.x / WIDTH * 100}%`;
    el.style.top = `${(slot.y - 116) / HEIGHT * 100}%`;
    el.className = `resident state-${t.displayState} category-${category(t)}${selectedId === t.id ? ' selected' : ''}`;
    el.dataset.state = t.displayState;
    el.querySelector('.resident-number').textContent = t.number;
    el.querySelector('.resident-state').textContent = `${category(t) === 'active' ? '● ' : ''}${LABELS[t.displayState]}`;
    el.setAttribute('aria-pressed', String(selectedId === t.id));
    el.setAttribute('aria-label', `${t.number} 号 ${t.title}，${LABELS[t.displayState]}，${t.activityText}`);
    const provenance = t.synthetic ? '合成探针 · ' : t.legacy ? '历史记录 · ' : '';
    const unknownNote = t.unknownReason === 'correlation-limit' ? '信号关联待确认' : '信号待确认';
    const desired = provenance + (t.displayState === 'unknown' ? `${unknownNote} · ${t.activityText}` : t.summary);
    const cache = speechCache.get(t.id);
    if (!cache || cache.state !== t.displayState || Date.now() - cache.at >= 2500 || ['waiting', 'unknown', 'error'].includes(t.displayState)) {
      if (cache?.text !== desired) speechCache.set(t.id, { text: desired, at: Date.now(), state: t.displayState });
    }
    el.querySelector('.speech').textContent = speechCache.get(t.id)?.text || desired;
    el.querySelector('.speech').title = desired;
    el.querySelector('.name').textContent = `${t.synthetic ? '[自检] ' : ''}${t.title}`;
    el.querySelector('.name').title = t.title;

  });
  for (const [id, el] of residentNodes) if (!keep.has(id)) { el.remove(); residentNodes.delete(id); }
  for (const id of speechCache.keys()) if (!all.some(t => t.id === id)) speechCache.delete(id);
  scene.update(group, selected, layout);
  $('detail-title').textContent = selected?.title || '选一位小镇居民';
  $('detail-role').textContent = ROLES[selected?.role] || '等待居民入住';
  $('detail-id').textContent = selected ? `任务 ID ${selected.id}` : '每个会话，一个小人';
  $('detail-project').textContent = selected?.projectId ? `项目 ID ${selected.projectId}` : '';
  $('detail-naming').textContent = !selected ? '' : selected.unnamed
    ? '任务目标尚未提供。职业只是装扮，不是任务名称。可设置本机名称，或由管理员配置共享名称。'
    : selected.titleSource === 'browser' ? '名称仅在此浏览器生效，其他查看者不会同步。' : selected.titleSource === 'shared' ? '管理员配置的共享任务名称。' : '';
  $('detail-state').textContent = selected ? LABELS[selected.displayState] : '等待任务信号';
  $('detail-summary').textContent = selected ? selected.activityText : '点击工位，看看它在忙什么。';
  $('detail-time').textContent = selected ? age(selected.lastAt) : '—';
  $('detail-freshness').textContent = selected ? mode === 'demo' || selected.synthetic ? '模拟信号 / 非桌面接入证明' : selected.stale ? '未知 / 信号较旧' : '已观察到事件' : '尚未收到';
  $('rename').disabled = !selected;
  const historyKey = `${selected?.id}:${JSON.stringify(selected?.history)}`;
  if ($('history').dataset.key !== historyKey) {
    $('history').dataset.key = historyKey; $('history').replaceChildren();
    for (const item of selected?.history || []) {
      const li = node('li', '', item.summary), time = node('time', '', new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false }));
      time.dateTime = new Date(item.at).toISOString(); li.append(time); $('history').append(li);
    }
    if (!$('history').children.length) $('history').append(node('li', 'history-empty', '新活动会留在这里。'));
  }
}
function receive(snapshot) {
  const date = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
  const short = (value, max) => typeof value === 'string' && value.length <= max;
  const state = value => typeof value === 'string' && Object.hasOwn(LABELS, value);
  if (!snapshot || !Array.isArray(snapshot.tasks) || snapshot.tasks.length > 200 || !date(snapshot.serverTime) ||
      (snapshot.staleMs !== undefined && (!Number.isFinite(snapshot.staleMs) || snapshot.staleMs <= 0)) ||
      (snapshot.currentWindowMs !== undefined && (!Number.isSafeInteger(snapshot.currentWindowMs) || snapshot.currentWindowMs < (snapshot.staleMs || 1) || snapshot.currentWindowMs > 30 * 86400000)) ||
      snapshot.tasks.some(t => !t || !short(t.id, 80) || !t.id || !state(t.state) ||
        (t.displayState !== undefined && !state(t.displayState)) || !short(t.role, 20) || !Object.hasOwn(ROLES, t.role) ||
        !short(t.title, 128) || !short(t.summary, 100) ||
        (t.projectLabel !== undefined && !short(t.projectLabel, 64)) ||
        (t.projectId !== undefined && !short(t.projectId, 80)) ||
        (t.parentTaskId !== undefined && !short(t.parentTaskId, 80)) ||
        ['synthetic', 'legacy'].some(k => t[k] !== undefined && typeof t[k] !== 'boolean') ||
        (t.titleSource !== undefined && !['generated', 'shared'].includes(t.titleSource)) || !date(t.lastAt) || !date(t.createdAt) ||
        !Array.isArray(t.history) || t.history.length > 16 || t.history.some(h =>
          !h || !date(h.at) || !state(h.state) || !short(h.summary, 100)))) throw new Error('Invalid snapshot');
  if (new Set(snapshot.tasks.map(t => t.id)).size !== snapshot.tasks.length) throw new Error('Duplicate task identities');
  tasks = snapshot.tasks; serverOffset = snapshot.serverTime - Date.now(); eventCount = snapshot.eventCount;
  staleMs = snapshot.staleMs || 120000;
  currentWindowMs = snapshot.currentWindowMs ?? Math.max(DEFAULT_CURRENT_WINDOW_MS, staleMs); lastSnapshotAt = Date.now();
  realEventCount = snapshot.realEventCount || 0; lastRealHookAt = snapshot.lastRealHookAt || 0;
  lastHookAt = snapshot.lastHookAt; collectorError = snapshot.collectorError;
  connected = true; connectionText = '采集器在线'; render();
}
async function connect() {
  const request = ++generation; events?.close();
  const controller = new AbortController();
  events = { close: () => controller.abort() }; lastSnapshotAt = Date.now(); connected = false; connectionText = '正在连接'; render();
  let handshake = setTimeout(() => controller.abort(), 7000);
  try {
    // fetch streaming keeps viewer credentials in a header, not a logged URL query.
    const response = await fetch('/api/events', { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal });
    if (request !== generation) { await response.body?.cancel(); return; }
    if (!response.ok) {
      connectionText = response.status === 401 ? '需要查看令牌' : '连接失败';
      await response.body?.cancel(); events = null; render(); return;
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    try {
      while (request === generation && mode === 'live') {
        const { value, done } = await reader.read();
        if (done) throw new Error('Stream closed');
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 2 * 1024 * 1024) throw new Error('Oversized frame');
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (!frame.includes('event: snapshot')) continue;
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (request === generation && mode === 'live') { receive(JSON.parse(data)); clearTimeout(handshake); }
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  } catch {
    if (request === generation && mode === 'live') { connected = false; connectionText = '连接中断，稍后重试'; events = null; render(); }
  } finally { clearTimeout(handshake); }
}
const demoSpec = [
  ['frontend', '重构后台导航', 'coding', '正在修改侧边栏组件'],
  ['backend', '完善登录接口', 'coding', '正在处理登录校验'],
  ['testing', '验证权限边界', 'testing', '正在运行权限测试'],
  ['docs', '整理项目文档', 'reading', '正在查看接口说明'],
  ['ops', '准备预览环境', 'waiting', '已申请审批，等待后续信号'],
  ['general', '检查构建流程', 'thinking', '正在分析构建结果'],
  ['frontend', '打磨设置页面', 'review', '本轮收尾，等待下一步'],
  ['backend', '数据库小管家', 'idle', '已到工位，等待新任务']
];
function demo() {
  const now = Date.now(); serverOffset = 0;
  tasks = demoSpec.map(([role, title, state, summary], i) => ({ id: `demo-resident-${i}`, role, title, state,
    displayState: state, summary, createdAt: now - 180000 + i, lastAt: now - i * 4000, stale: false,
    history: [{ at: now - i * 4000, type: 'Demo', state, summary },
      { at: now - 42000, type: 'Demo', state: 'thinking', summary: '收到任务，正在分析' },
      { at: now - 85000, type: 'Demo', state: 'idle', summary: '来到小镇，准备开工' }] }));
  render();
  demoTimer = setInterval(() => {
    if (document.hidden) return;
    const task = tasks[5];
    task.state = task.state === 'thinking' ? 'running' : 'thinking'; task.displayState = task.state;
    task.summary = task.state === 'running' ? '正在执行项目构建' : '正在分析构建结果'; task.lastAt = Date.now();
    task.history.unshift({ at: task.lastAt, state: task.state, summary: task.summary }); task.history = task.history.slice(0, 16); render();
  }, 10000);
}
function setMode(next) {
  ++generation; events?.close(); events = null; clearInterval(demoTimer); mode = next;
  tasks = []; page = 0; selectedId = ''; speechCache.clear();
  const url = new URL(location.href); if (mode === 'demo') url.searchParams.set('demo', '1'); else url.searchParams.delete('demo');
  history.replaceState(null, '', url.pathname + url.search);
  mode === 'demo' ? demo() : connect();
}
$('live-mode').onclick = () => setMode('live'); $('demo-mode').onclick = $('empty-demo').onclick = () => setMode('demo');
$('guide').onclick = () => $('guide-dialog').showModal();
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => $(button.dataset.close).close();
function syncAnimation() {
  $('animation').replaceChildren(document.createTextNode(scene.paused ? '▷ ' : 'Ⅱ '), node('span', '', scene.paused ? '播放动画' : '暂停动画'));
  $('animation').title = scene.paused ? '播放动画' : '暂停动画'; $('animation').setAttribute('aria-pressed', String(scene.paused));
}
scene.onPauseChange = syncAnimation;
syncAnimation(); $('animation').onclick = () => { scene.setPaused(!scene.paused); syncAnimation(); };
for (const button of document.querySelectorAll('[data-filter], [data-scope]')) button.onclick = () => {
  filter = button.dataset.filter || button.dataset.scope; page = 0;
  // Global counters are actionable: never leave a hidden search that obscures their count.
  if (button.dataset.scope) $('search').value = '';
  render(); $('task-list').scrollTop = 0;
};
$('search').oninput = () => { page = 0; render(); };
$('previous').onclick = () => { page--; render(); }; $('next').onclick = () => { page++; render(); };
$('save-token').onclick = () => {
  token = $('viewer-token').value.trim(); try { sessionStorage.setItem('task-town-token', token); } catch {}
  $('guide-dialog').close(); setMode('live');
};
$('rename').onclick = () => {
  renameTargetId = selectedId;
  $('nickname').value = aliases[renameTargetId]?.title || ''; $('role-select').value = aliases[selectedId]?.role || '';
  $('rename-dialog').showModal(); $('nickname').focus();
};
$('save-name').onclick = () => {
  if (!renameTargetId || !tasks.some(t => t.id === renameTargetId)) { $('rename-dialog').close(); return; }
  aliases[renameTargetId] = { title: $('nickname').value.trim().slice(0, 64), role: $('role-select').value };
  try { localStorage.setItem('task-town-aliases', JSON.stringify(aliases)); } catch {}
  $('rename-dialog').close(); render();
};
window.addEventListener('resize', render);
setInterval(() => {
  if (mode === 'live' && events && Date.now() - lastSnapshotAt > 45000) {
    connected = false; connectionText = '心跳中断'; events?.close(); events = null;
  }
  if (!document.hidden) render();
}, 1000);
setInterval(() => { if (mode === 'live' && !connected && !events) connect(); }, 10000);
setMode(mode);
