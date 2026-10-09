import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readBundle } from './read-bundle.mjs';
import { generatePreviews } from './generate-previews.mjs';
import { startPreview } from './local-preview.mjs';
import { decodeBundle, MAX_BYTES, MAX_FILES, MAX_UPLOAD_BYTES } from '../worker/bundle.mjs';

// Real preview generation and publication near both limits; no hosted credentials or resources.
const directory = await mkdtemp(join(tmpdir(), 'mgm-capacity-'));
let preview;
try {
  const html =
    '<!doctype html><meta name="viewport" content="width=device-width"><h1>Capacity study</h1><p>Generated preview and binary assets</p>';
  const files = ['index.html', 'model.bin'];
  await writeFile(join(directory, 'index.html'), html);
  await writeFile(join(directory, 'model.bin'), randomBytes(MAX_BYTES - 1024 * 1024));
  for (let i = files.length; i < MAX_FILES - 2; i++) {
    const path = `asset-${i}.bin`;
    files.push(path);
    await writeFile(join(directory, path), randomBytes(64));
  }
  const manifest = {
    schemaVersion: 1,
    project: { id: 'capacity-probe', name: 'Capacity \u96ea' },
    boards: [
      {
        id: 'app',
        name: 'App',
        frames: [
          { id: 'phone', name: 'Phone', entry: 'index.html', width: 390, height: 844 },
          { id: 'tablet', name: 'Tablet', entry: 'index.html', width: 1024, height: 768 },
        ],
      },
    ],
    files,
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  const source = await readBundle(directory);
  const bundle = await generatePreviews(source, { onProgress() {} });
  assert.equal(source.manifest.files.length, MAX_FILES - 2);
  assert.equal(bundle.manifest.files.length, MAX_FILES);
  assert(bundle.manifest.boards[0].frames.every((frame) => frame.preview));
  const decoded = decodeBundle(bundle, manifest.project.id);
  assert(decoded.total > 23 * 1024 * 1024 && decoded.total <= MAX_BYTES);
  assert(Buffer.byteLength(JSON.stringify(bundle)) < MAX_UPLOAD_BYTES);
  const excessCount = structuredClone(source);
  excessCount.manifest.files.push('extra.bin');
  excessCount.files['extra.bin'] = '';
  await assert.rejects(generatePreviews(excessCount, { onProgress() {} }), /400-file/);
  const excessSize = structuredClone(source);
  const rest =
    decodeBundle(source, manifest.project.id).total -
    Buffer.from(source.files['model.bin'], 'base64').length;
  excessSize.files['model.bin'] = Buffer.alloc(MAX_BYTES - rest).toString('base64');
  await assert.rejects(
    generatePreviews(excessSize, { onProgress() {} }),
    /previews exceed the 24 MiB/,
  );
  for (const [path, value] of Object.entries(bundle.files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), Buffer.from(value, 'base64'));
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(bundle.manifest));
  preview = await startPreview({ directories: [directory], port: 0, onUpdate() {} });
  const { projects } = await (await fetch(`${preview.origin}/api/projects`)).json();
  assert.equal(projects[0].activePublication.status, 'published');
  for (const frame of projects[0].boards[0].frames) {
    const image = await fetch(new URL(frame.preview, preview.origin));
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/jpeg');
    await image.arrayBuffer();
  }
  if (process.env.CAPACITY_BUNDLE_OUTPUT)
    await writeFile(process.env.CAPACITY_BUNDLE_OUTPUT, JSON.stringify(bundle));
  console.log(
    `${decoded.total} decoded bytes, ${MAX_FILES} files including generated previews: capture, publication, envelope, and overflow checks passed`,
  );
} finally {
  await preview?.close();
  await rm(directory, { recursive: true, force: true });
}
