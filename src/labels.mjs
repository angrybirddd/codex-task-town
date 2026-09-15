// Explicitly approved, public display labels; never read prompts or transcripts.
import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isId } from './normalize.mjs';
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const label = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 64 &&
  !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(v);
export function validateLabels(data) {
  if (!object(data) || data.version !== 1 || Object.keys(data).some(k => !['version', 'tasks', 'projects'].includes(k)))
    throw new Error('labels.json must have version: 1 and optional tasks/projects maps');
  const result = { version: 1, tasks: {}, projects: {} };
  for (const kind of ['tasks', 'projects']) {
    const map = data[kind] ?? {};
    if (!object(map) || Object.keys(map).length > 1000) throw new Error(`Invalid labels.json ${kind} map`);
    for (const [id, title] of Object.entries(map)) {
      if (!isId(id) || !label(title)) throw new Error(`Invalid labels.json ${kind} entry: expected a 20-character ID and a 1–64 character label`);
      result[kind][id] = title.trim();
    }
  }
  return result;
}
export async function loadLabels(directory) {
  const file = join(directory, 'labels.json');
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 256 * 1024) throw new Error('labels.json must be a regular file under 256 KiB');
    return validateLabels(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return validateLabels({ version: 1 });
    throw new Error('Cannot load shared labels; fix labels.json before starting', { cause: error });
  }
}
export function applyLabels(snapshot, labels) {
  return { ...snapshot, tasks: snapshot.tasks.map(t => ({ ...t,
    title: labels.tasks[t.id] ?? t.title,
    titleSource: Object.hasOwn(labels.tasks, t.id) ? 'shared' : 'generated',
    projectLabel: labels.projects[t.projectId] ?? '' })) };
}
