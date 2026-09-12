import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { startPreview } from './local-preview.mjs';
import { decodeBundle, MAX_BYTES, MAX_FILES } from '../worker/bundle.mjs';

/** Adds missing frame previews to a new bundle without editing source files. Captures one isolated document at a time through the real local Worker; browser requests are limited to that publication. Images are JPEGs with a 640-pixel longest edge. Existing previews are preserved. Any capture or bundle-limit failure rejects the publication. */
export async function generatePreviews(input, { onProgress = console.log } = {}) {
  const validated = decodeBundle(input, input.manifest.project.id);
  const bundle = structuredClone(input);
  const pending = bundle.manifest.boards.flatMap((board) =>
    board.frames.filter((frame) => !frame.preview).map((frame) => ({ board, frame })),
  );
  if (!pending.length) return bundle;
  if (bundle.manifest.files.length + pending.length > MAX_FILES)
    throw new Error('Generated previews would exceed the 300-file publication limit.');
  const directory = await mkdtemp(join(tmpdir(), 'mgm-previews-'));
  let preview, browser;
  let total = validated.total;
  try {
    for (const file of validated.files) {
      const path = join(directory, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.bytes);
    }
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(bundle.manifest));
    preview = await startPreview({ directories: [directory], port: 0, onUpdate() {} });
    const response = await fetch(`${preview.origin}/api/projects`);
    if (!response.ok) throw new Error('Could not prepare local preview publication.');
    const { projects } = await response.json();
    const project = projects.find((project) => project.id === bundle.manifest.project.id);
    browser = await chromium.launch({
      headless: true,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: directory,
        TMPDIR: directory,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      },
    });
    for (const [index, { board, frame }] of pending.entries()) {
      const path = `mgm-previews/${board.id}/${frame.id}.jpg`;
      if (bundle.manifest.files.includes(path))
        throw new Error(`Generated preview path already exists: ${path}`);
      const published = project.boards
        .find((b) => b.id === board.id)
        .frames.find((f) => f.id === frame.id);
      const entry = new URL(published.entry, preview.origin).href;
      const prefix = preview.origin + new URL(entry).pathname.match(/^\/mocks\/[^/]+\//)[0];
      const context = await browser.newContext({
        viewport: { width: frame.width, height: frame.height },
        deviceScaleFactor: Math.min(1, 640 / Math.max(frame.width, frame.height)),
        reducedMotion: 'reduce',
        // The response CSP disables workers. Playwright's blocker throws when reading this opaque origin's navigator.serviceWorker.
        acceptDownloads: false,
      });
      try {
        const failures = [];
        await context.route('**/*', (route) => {
          if (route.request().url().startsWith(prefix)) return route.continue();
          failures.push(
            `Blocked ${route.request().resourceType()} request outside the publication.`,
          );
          return route.abort();
        });
        const page = await context.newPage();
        page.on('pageerror', (error) => {
          failures.push(error.message);
        });
        page.on('response', (response) => {
          if (response.status() >= 400)
            failures.push(`Resource returned HTTP ${response.status()}.`);
        });
        page.on('requestfailed', () => failures.push('A publication resource did not load.'));
        await page.goto(entry, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForFunction(
          () =>
            !document.querySelector('[data-mgm-preview-ready="false"]') &&
            document.fonts.status === 'loaded' &&
            [...document.images].every((image) => {
              const rect = image.getBoundingClientRect();
              const visible =
                rect.bottom > 0 &&
                rect.right > 0 &&
                rect.top < innerHeight &&
                rect.left < innerWidth;
              return !visible || (image.complete && image.naturalWidth > 0);
            }),
          undefined,
          { timeout: 15000 },
        );
        await page.waitForTimeout(250);
        if (failures.length) throw new Error(failures.join(' '));
        const bytes = await page.screenshot({
          type: 'jpeg',
          quality: 70,
          scale: 'device',
          timeout: 15000,
        });
        total += bytes.length;
        if (total > MAX_BYTES)
          throw new Error(
            'Generated previews exceed the 20 MiB publication limit; reduce source asset sizes.',
          );
        frame.preview = path;
        bundle.manifest.files.push(path);
        bundle.files[path] = bytes.toString('base64');
        onProgress(`Preview ${index + 1}/${pending.length}: ${board.id}/${frame.id}`);
      } catch (error) {
        // Browser errors can contain grant URLs; only expose the source identifiers.
        const reason = String(error.message).replace(/\/mocks\/[^/\s]+/g, '/mocks/[redacted]');
        throw new Error(`Could not capture preview for ${board.id}/${frame.id}: ${reason}`);
      } finally {
        await context.close();
      }
    }
    decodeBundle(bundle, bundle.manifest.project.id);
    return bundle;
  } finally {
    await browser?.close();
    await preview?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
