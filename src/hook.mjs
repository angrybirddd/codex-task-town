// Read-only telemetry recorder: no network, stdout, approval decisions or context injection.
import { mkdir, readdir, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { normalize } from './normalize.mjs';

const started = Date.now();
const watchdog = setTimeout(() => process.exit(0), 800);
let bytes = 0, chunks = [];
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? '' : process.argv[i + 1]; };
process.stdin.on('error', () => process.exit(0));
process.stdin.on('data', chunk => {
  bytes += chunk.length;
  if (bytes > 1024 * 1024) process.exit(0);
  chunks.push(chunk);
});
process.stdin.on('end', async () => {
  try {
    const event = normalize(JSON.parse(Buffer.concat(chunks).toString('utf8')),
      { now: started, filenames: process.argv.includes('--filenames') });
    chunks = [];
    if (event) {
      const directory = resolve(arg('--data-dir') || process.env.TOWN_DATA_DIR || join(homedir(), '.codex-task-town'));
      const spool = join(directory, 'spool');
      await mkdir(spool, { recursive: true, mode: 0o700 });
      // Bound the offline spool. Drop optional telemetry rather than delay real work.
      if ((await readdir(spool)).length < 2000) {
        const file = `${event.at}-${event.id}.json`;
        const temp = join(spool, `.${file}.tmp`);
        await writeFile(temp, JSON.stringify(event), { flag: 'wx', mode: 0o600 });
        await rename(temp, join(spool, file));
      }
    }
  } catch { /* This observer never makes or overrides a security / approval decision. */ }
  clearTimeout(watchdog);
  process.exit(0);
});
process.stdin.resume();
