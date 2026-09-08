import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { MAX_BYTES, validateManifest } from '../worker/bundle.mjs';

/** Reads only the validated manifest whitelist. Rejects escaping symlinks, non-files and oversized content; never builds source. An optional project id enforces destination identity. */
export async function readBundle(directory, projectId) {
  const input = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  const manifest = validateManifest(input, projectId ?? input.project?.id);
  const root = await realpath(directory);
  const files = {};
  let total = 0;
  for (const path of manifest.files) {
    const absolute = await realpath(resolve(root, path));
    if (!absolute.startsWith(root + sep))
      throw new Error('A listed file resolves outside design/.');
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error('Every listed path must resolve to a regular file.');
    if (total + info.size > MAX_BYTES) throw new Error('Bundle exceeds 20 MiB.');
    const bytes = await readFile(absolute);
    total += bytes.length;
    if (total > MAX_BYTES) throw new Error('Bundle exceeds 20 MiB.');
    files[path] = bytes.toString('base64');
  }
  return { manifest, files };
}
