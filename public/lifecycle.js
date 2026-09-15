// A roster is a time-bounded view of evidence, NOT a lifetime task counter.
// Shared by the collector and browser so expiry requires neither a new event nor deletion.
export const DEFAULT_CURRENT_WINDOW_MS = 30 * 60 * 1000;
export const WORKING_STATES = ['thinking', 'coding', 'reading', 'testing', 'running'];
export const ATTENTION_STATES = ['waiting', 'unknown', 'error'];
export function validateWindow(value, staleMs = 0) {
  if (!Number.isSafeInteger(value) || value < Math.max(1, staleMs) || value > 30 * 86400000)
    throw new Error('currentWindowMs must be an integer between staleMs and 30 days');
  return value;
}
export function rosterScope(t, now, windowMs, familyLastAt = t.lastAt) {
  if (t.synthetic || t.legacy) return { scope: 'reference', archiveReason: '' };
  if (t.state === 'ended') return { scope: 'archived', archiveReason: 'session-ended' };
  // A subagent's stop is advisory: archive its observed turn, never claim the requirement is done.
  if (t.parentTaskId && t.state === 'review') return { scope: 'archived', archiveReason: 'child-turn-ended' };
  if (now - familyLastAt > windowMs) return { scope: 'archived', archiveReason: 'outside-window' };
  return { scope: t.parentTaskId ? 'children' : 'current', archiveReason: '' };
}
export function scopeTasks(tasks, { now = Date.now(), currentWindowMs = DEFAULT_CURRENT_WINDOW_MS } = {}) {
  validateWindow(currentWindowMs);
  const family = new Map(tasks.map(t => [t.id, t.lastAt]));
  // Hook child identity points to a root session. Do not invent a missing parent,
  // merge tasks by titles/cwd, or let probes make an old real session look recent.
  for (const t of tasks) {
    if (t.parentTaskId && !t.synthetic && !t.legacy && !['ended', 'review'].includes(t.state) && family.has(t.parentTaskId))
      family.set(t.parentTaskId, Math.max(family.get(t.parentTaskId), t.lastAt));
  }
  return tasks.map(t => ({ ...t, ...rosterScope(t, now, currentWindowMs, family.get(t.id)) }));
}
export function rosterCounts(tasks) {
  const counts = { current: 0, working: 0, attention: 0, quiet: 0, children: 0, archived: 0, reference: 0, retained: tasks.length };
  for (const t of tasks) {
    if (t.scope === 'current') {
      counts.current++;
      if (WORKING_STATES.includes(t.displayState || t.state)) counts.working++;
      else if (ATTENTION_STATES.includes(t.displayState || t.state)) counts.attention++;
      else counts.quiet++;
    } else if (['children', 'archived', 'reference'].includes(t.scope)) counts[t.scope]++;
  }
  return counts;
}
// At the storage cap, keep recent main tasks ahead of churn from probes and child runs.
export function retentionRank(t, now, windowMs) {
  const scope = t.scope || rosterScope(t, now, windowMs).scope;
  return scope === 'reference' ? 0 : scope === 'archived' ? 1 : scope === 'children' ? 2 : 3;
}
