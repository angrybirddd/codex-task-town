import { createHash, randomUUID } from 'node:crypto';

export const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop'];
export const ROLES = { frontend: '前端工程师', backend: '后端工程师', testing: '测试工程师',
  docs: '文档工程师', ops: '运维工程师', general: '工程师' };
export const STATES = ['thinking', 'coding', 'reading', 'testing', 'running', 'waiting',
  'idle', 'review', 'paused', 'ended', 'error', 'unknown'];
const text = (value, limit = 8000) => typeof value === 'string' ? value.slice(0, limit) : '';
export const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 20);

export function inferRole(input) {
  const s = text(input).toLowerCase();
  if (/测试|test|spec|pytest|vitest|playwright/.test(s)) return 'testing';
  if (/前端|页面|界面|布局|样式|frontend|css|tsx|jsx|sidebar|react|vue/.test(s)) return 'frontend';
  if (/后端|数据库|接口|backend|database|sql|api|server/.test(s)) return 'backend';
  if (/文档|说明|readme|docs|documentation/.test(s)) return 'docs';
  if (/部署|运维|docker|deploy|workflow|infra/.test(s)) return 'ops';
  return 'general';
}

/** Raw prompt / command / response data stops here. Nothing executes or forwards it. */
export function normalize(raw, { now = Date.now(), filenames = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const type = raw.hook_event_name;
  const session = text(raw.session_id, 256);
  const agent = text(raw.agent_id, 256);
  if (!EVENTS.includes(type) || !session) return null;
  if (type.startsWith('Subagent') && !agent) return null;
  const input = raw.tool_input && typeof raw.tool_input === 'object' ? raw.tool_input : {};
  const tool = text(raw.tool_name, 160).toLowerCase();
  const command = text(input.command ?? input.cmd);
  const file = text(input.file_path ?? input.path, 500) ||
    command.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m)?.[1] || '';
  const role = inferRole(type === 'UserPromptSubmit' ? raw.prompt : `${file} ${command}`);
  let activity = 'running', summary = '正在运行工具';
  if (/apply_patch|(^|__)(edit|write|write_file|edit_file)$/.test(tool)) {
    activity = 'coding'; summary = '正在修改代码';
  } else if (/\b(pytest|vitest|jest|playwright)\b|\b(npm|pnpm|yarn|bun|cargo|go)\s+(run\s+)?test\b|unittest/.test(command)) {
    activity = 'testing'; summary = '正在运行测试';
  } else if (/read|search|grep|glob|list/.test(tool) || /^(?:\s*)(cat|ls|rg|grep|find|head|tail|sed\s+-n)\b/.test(command)) {
    activity = 'reading'; summary = '正在查看代码';
  } else if (/update_plan|agent/.test(tool)) {
    activity = 'thinking'; summary = '正在整理任务计划';
  } else if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|cargo\s+build/.test(command)) {
    summary = '正在构建项目';
  } else if (/bash|shell|exec/.test(tool)) {
    summary = '正在运行命令';
  }
  if (filenames && file && ['coding', 'reading'].includes(activity)) {
    const base = file.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, 40);
    if (base && !/env|secret|token|credential|password|private|key/i.test(base)) {
      summary = `${activity === 'coding' ? '正在修改' : '正在查看'} ${base}`;
    }
  }
  // Only explicit structured failure information; never copy tool output.
  const response = raw.tool_response;
  const exitCode = response && typeof response === 'object' ? response.exit_code ?? response.exitCode : undefined;
  const failed = response?.isError === true || response?.is_error === true ||
    (typeof exitCode === 'number' && exitCode !== 0);
  return { v: 1, id: randomUUID(), at: now, taskId: agent ? hash(`${session}::agent::${agent}`) : hash(session),
    parentTaskId: agent ? hash(session) : '',
    toolKey: tool ? hash(`${tool}:${JSON.stringify(input)}`) : '',
    turnId: raw.turn_id ? hash(text(raw.turn_id, 256)) : '',
    callId: raw.tool_use_id ? hash(text(raw.tool_use_id, 256)) : '',
    projectId: hash(text(raw.cwd, 1000) || 'unknown'), type, role, activity, summary, failed,
    source: ['startup', 'resume', 'clear', 'compact'].includes(raw.source) ? raw.source : '' };
}

export function validEvent(e) {
  return Boolean(e && e.v === 1 && typeof e.id === 'string' && e.id.length <= 80 &&
    /^[a-f0-9]{20}$/.test(e.taskId) && /^[a-f0-9]{20}$/.test(e.projectId) &&
    STATES.includes(e.activity) && Object.hasOwn(ROLES, e.role) &&
    EVENTS.includes(e.type) && Number.isSafeInteger(e.at) && e.at > 0 &&
    typeof e.summary === 'string' && e.summary.length <= 100 &&
    typeof e.turnId === 'string' && /^(?:[a-f0-9]{20})?$/.test(e.turnId) &&
    (e.parentTaskId === undefined || /^(?:[a-f0-9]{20})?$/.test(e.parentTaskId)) &&
    (e.toolKey === undefined || /^(?:[a-f0-9]{20})?$/.test(e.toolKey)) &&
    typeof e.callId === 'string' && /^(?:[a-f0-9]{20})?$/.test(e.callId) && typeof e.failed === 'boolean');
}
