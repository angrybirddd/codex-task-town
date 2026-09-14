// Synthetic diagnostic: verifies recorder persistence, not Desktop hook trust.
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from '../src/normalize.mjs';
const hook = fileURLToPath(new URL('../src/hook.mjs', import.meta.url));
const session_id = 'task-town-probe', taskId = hash(session_id), began = Date.now();
const dataDir = process.env.TOWN_DATA_DIR || join(homedir(), '.codex-task-town');
try {
  for (const hook_event_name of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
    const child = spawnSync(process.execPath, [hook, '--data-dir', dataDir], { timeout: 2000, encoding: 'utf8',
      input: JSON.stringify({ session_id, hook_event_name, cwd: 'probe', turn_id: `probe-${process.pid}-${began}`,
        tool_use_id: 'probe-call', prompt: '测试看板连接', tool_name: 'Bash',
        tool_input: { command: 'npm test' }, tool_response: { exit_code: 0 } }) });
    if (child.error || child.status !== 0) throw new Error('Probe recorder failed.');
    await new Promise(r => setTimeout(r, 150));
  }
  let found = false;
  try {
    const state = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'));
    found = state.tasks?.some(t => t.id === taskId && t.lastAt >= began);
  } catch {}
  if (!found) {
    for (const name of (await readdir(join(dataDir, 'spool'))).filter(n => /^\d+-[a-f0-9-]+\.json$/.test(n))) {
      try { const e = JSON.parse(await readFile(join(dataDir, 'spool', name), 'utf8')); if (e.taskId === taskId && e.at >= began) { found = true; break; } } catch {}
    }
    // The collector may have moved the last queue event into state during the scan.
    if (!found) { const state = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8')); found = state.tasks?.some(t => t.id === taskId && t.lastAt >= began); }
  }
  if (!found) throw new Error('No persisted probe event found. Check the data directory and queue capacity.');
  console.log('Synthetic event persistence verified. This checks the recorder, not Codex Desktop hook trust.');
} catch (e) { console.error(`Probe failed: ${e.message}`); process.exitCode = 1; }
