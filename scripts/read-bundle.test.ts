import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBundle } from './read-bundle.mjs';

let temporary: string;
let directory: string;
const manifest = {
  schemaVersion: 1,
  project: { id: 'sample', name: 'Sample' },
  boards: [
    {
      id: 'app',
      name: 'App',
      frames: [{ id: 'home', name: 'Home', entry: 'home.html', width: 390, height: 844 }],
    },
  ],
  files: ['home.html'],
};
async function saveManifest(value: unknown = manifest) {
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(value));
}

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'mgm-read-bundle-'));
  directory = join(temporary, 'design');
  await mkdir(directory);
  await saveManifest();
  await writeFile(join(directory, 'home.html'), '<p>Sample</p>');
});
afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});

describe('source bundle reading', () => {
  it('reads only the explicit whitelist and enforces destination identity', async () => {
    await writeFile(join(directory, '.env'), 'DO_NOT_PUBLISH=this-is-not-a-real-secret');
    await writeFile(join(directory, 'unlisted.html'), 'Unlisted mock');
    const bundle = await readBundle(directory, 'sample');
    expect(bundle.manifest).toEqual(manifest);
    expect(Object.keys(bundle.files)).toEqual(['home.html']);
    expect(Buffer.from(bundle.files['home.html'], 'base64').toString()).toBe('<p>Sample</p>');
    await expect(readBundle(directory, 'another-project')).rejects.toThrow('registered project');
  });

  it('rejects files and directory symlinks that escape the source root', async () => {
    const sibling = join(temporary, 'design-other');
    await mkdir(sibling);
    await writeFile(join(sibling, 'private.html'), 'Outside source root');
    await symlink(join(sibling, 'private.html'), join(directory, 'linked.html'));
    await saveManifest({ ...manifest, files: [...manifest.files, 'linked.html'] });
    await expect(readBundle(directory)).rejects.toThrow('outside design/');
    await symlink(sibling, join(directory, 'external'));
    await saveManifest({ ...manifest, files: [...manifest.files, 'external/private.html'] });
    await expect(readBundle(directory)).rejects.toThrow('outside design/');
  });

  it('allows aliases that resolve inside the selected source root', async () => {
    await symlink(join(directory, 'home.html'), join(directory, 'linked.html'));
    await saveManifest({ ...manifest, files: [...manifest.files, 'linked.html'] });
    const alias = join(temporary, 'source-alias');
    await symlink(directory, alias);
    const bundle = await readBundle(alias);
    expect(bundle.files['linked.html']).toBe(bundle.files['home.html']);
  });

  it('rejects missing files, non-files, duplicate paths, and missing manifests', async () => {
    await mkdir(join(directory, 'directory.html'));
    await saveManifest({ ...manifest, files: [...manifest.files, 'directory.html'] });
    await expect(readBundle(directory)).rejects.toThrow('regular file');
    await saveManifest({ ...manifest, files: [...manifest.files, 'missing.html'] });
    await expect(readBundle(directory)).rejects.toThrow();
    await saveManifest({ ...manifest, files: [...manifest.files, ...manifest.files] });
    await expect(readBundle(directory)).rejects.toThrow('unique');
    await rm(join(directory, 'manifest.json'));
    await expect(readBundle(directory)).rejects.toThrow();
  });

  it('rejects oversized files before buffering and accepts deliberate empty publications', async () => {
    await writeFile(join(directory, 'oversized.bin'), '');
    await truncate(join(directory, 'oversized.bin'), 20 * 1024 * 1024 + 1);
    await saveManifest({ ...manifest, files: [...manifest.files, 'oversized.bin'] });
    await expect(readBundle(directory)).rejects.toThrow('20 MiB');
    await saveManifest({
      schemaVersion: 1,
      project: manifest.project,
      boards: [],
      files: [],
      empty: true,
    });
    expect((await readBundle(directory)).files).toEqual({});
    expect(await readFile(join(directory, 'home.html'), 'utf8')).toBe('<p>Sample</p>');
  });
});
