import { mkdir, readFile, writeFile, rename, lstat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EVENTS } from '../src/normalize.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = '--codex-task-town';
const quote = s => `'${s.replace(/'/g, `'"'"'`)}'`;

export function mergeHooks(original, command, remove = false) {
  if (!original || typeof original !== 'object' || Array.isArray(original) ||
      (original.hooks !== undefined && (!original.hooks || typeof original.hooks !== 'object' || Array.isArray(original.hooks)))) {
    throw new Error('Invalid hooks.json: refusing to overwrite it.');
  }
  const result = structuredClone(original); result.hooks ??= {};
  for (const event of EVENTS) {
    const groups = result.hooks[event] || [];
    if (!Array.isArray(groups)) throw new Error(`Invalid hook groups: ${event}`);
    result.hooks[event] = groups.flatMap(group => {
      if (!Array.isArray(group.hooks)) throw new Error(`Invalid hook handlers: ${event}`);
      const hooks = group.hooks.filter(h => !(h.type === 'command' && h.command?.includes(` ${MARKER} `)));
      // Preserve existing empty groups as well as all unrelated handlers.
      return hooks.length || group.hooks.length === 0 ? [{ ...group, hooks }] : [];
    });
    if (!remove) result.hooks[event].push({ hooks: [{ type: 'command', command, timeout: 1 }] });
    if (!result.hooks[event].length) delete result.hooks[event];
  }
  return result;
}

export async function configure({ write = false, remove = false, filenames = false,
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
  dataDir = process.env.TOWN_DATA_DIR || join(homedir(), '.codex-task-town') } = {}) {
  if (process.platform === 'win32') throw new Error('Installer targets macOS/Linux; use WSL on Windows.');
  codexHome = resolve(codexHome); dataDir = resolve(dataDir);
  const config = join(codexHome, 'hooks.json');
  const files = await Promise.all(['hook.mjs', 'normalize.mjs'].map(async name => [name, await readFile(join(ROOT, 'src', name))]));
  // A code update changes the command path, so Codex asks to trust the new definition.
  const version = createHash('sha256').update(Buffer.concat(files.map(([, bytes]) => bytes))).digest('hex').slice(0, 16);
  const integration = join(dataDir, 'integration', version);
  let original = {}, old = '';
  try {
    if ((await lstat(config)).isSymbolicLink()) throw new Error('hooks.json is a symlink; refusing to overwrite.');
    old = await readFile(config, 'utf8'); original = JSON.parse(old);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const command = [quote(process.execPath), quote(join(integration, 'hook.mjs')), MARKER,
    '--data-dir', quote(dataDir), ...(filenames ? ['--filenames'] : [])].join(' ');
  const next = JSON.stringify(mergeHooks(original, command, remove), null, 2) + '\n';
  if (!write) return { config, preview: next, changed: next !== old };
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const lock = `${config}.task-town.lock`;
  await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  let backup;
  try {
    const current = await readFile(config, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
    if (current !== old) throw new Error('hooks.json changed during setup; please rerun.');
    if (!remove) {
      await mkdir(integration, { recursive: true, mode: 0o700 });
      for (const [name, bytes] of files) {
        const target = join(integration, name);
        let existing;
        try { existing = await readFile(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (existing && !existing.equals(bytes)) throw new Error('Installed script differs from its fingerprint. Review the data directory.');
        if (!existing) await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      }
    }
    if (next !== old) {
      if (old) { backup = `${config}.backup-${Date.now()}`; await writeFile(backup, old, { flag: 'wx', mode: 0o600 }); }
      await writeFile(`${config}.task-town.tmp`, next, { mode: 0o600 });
      await rename(`${config}.task-town.tmp`, config);
    }
  } finally { await unlink(lock).catch(() => {}); }
  return { config, backup, changed: next !== old, removed: remove };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await configure({ write: process.argv.includes('--write'), remove: process.argv.includes('--remove'),
      filenames: process.argv.includes('--filenames') });
    if (result.preview) console.log(`Preview only — no files changed.\n${result.config}\n${result.preview}`);
    else {
      console.log(`${result.removed ? 'Removed' : 'Installed'} Task Town hooks: ${result.config}`);
      if (result.backup) console.log(`Backup: ${result.backup}`);
      console.log('Review and trust the hooks in Codex Desktop, then start a NEW task or turn.');
      console.log('This observer returns no approval decisions, tool changes or model context.');
    }
  } catch (e) { console.error(`Setup failed: ${e.message}`); process.exitCode = 1; }
}
