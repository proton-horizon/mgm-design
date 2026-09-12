import { chromium, webkit, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startPreview } from './local-preview.mjs';
import { readBundle } from './read-bundle.mjs';
import { generatePreviews } from './generate-previews.mjs';

// Real Worker/sandbox fixture; run after building with installed Playwright Chromium and WebKit.
const directory = await mkdtemp(join(tmpdir(), 'mgm-canvas-check-'));
let preview;
try {
  await writeFile(
    join(directory, 'screen.html'),
    `<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><button id="counter">0</button><script>let count=0;document.querySelector('button').onclick=e=>e.target.textContent=++count;</script></body></html>`,
  );
  const frames = Array.from({ length: 75 }, (_, i) => ({
    id: `screen-${i}`,
    name: `Screen ${i + 1}`,
    entry: 'screen.html',
    width: 390,
    height: 844,
    x: (i % 8) * 470,
    y: Math.floor(i / 8) * 1000,
  }));
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      project: { id: 'canvas-check', name: 'Canvas check' },
      boards: [{ id: 'large', name: 'Large board', frames: [frames[0]] }],
      files: ['screen.html'],
    }),
  );
  const source = await readBundle(directory);
  const bundle = await generatePreviews(source, { onProgress() {} });
  expect(source.manifest.boards[0].frames[0].preview).toBeUndefined();
  const thumbnail = bundle.manifest.boards[0].frames[0].preview;
  expect(thumbnail).toBe('mgm-previews/large/screen-0.jpg');
  expect(await generatePreviews(bundle)).toEqual(bundle);
  const broken = structuredClone(source);
  broken.files['screen.html'] = Buffer.from('<script src="missing.js"></script>').toString(
    'base64',
  );
  await expect(generatePreviews(broken, { onProgress() {} })).rejects.toThrow(
    'Could not capture preview for large/screen-0',
  );
  expect(broken.manifest.boards[0].frames[0].preview).toBeUndefined();
  for (const [path, content] of Object.entries(bundle.files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), Buffer.from(content, 'base64'));
  }
  bundle.manifest.boards[0].frames = frames.map((frame, index) =>
    index === 74 ? frame : { ...frame, preview: thumbnail },
  );
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(bundle.manifest));
  preview = await startPreview({ directories: [directory], port: 0, onUpdate() {} });
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      for (const width of [390, 1024, 1440]) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          hasTouch: width < 1440,
          isMobile: width < 1440,
        });
        try {
          const page = await context.newPage();
          await page.addInitScript(() => {
            const NativeResizeObserver = window.ResizeObserver;
            window.ResizeObserver = class extends NativeResizeObserver {
              constructor(callback) {
                super((entries, observer) => setTimeout(() => callback(entries, observer), 350));
              }
            };
          });
          const errors = [];
          let mockRequests = 0;
          page.on('pageerror', (error) => errors.push(error.name));
          page.on('request', (request) => {
            if (request.url().includes('/mocks/') && request.resourceType() === 'document')
              mockRequests++;
          });
          await page.goto(preview.origin);
          await expect(page.locator('[data-frame]')).toHaveCount(75);
          await expect(page.locator('.zoom-value')).toHaveText('8%');
          await page.waitForTimeout(400);
          await expect(page.locator('iframe')).toHaveCount(0);
          expect(mockRequests).toBe(0);
          await expect(page.locator('.frame-preview').first()).toBeVisible();
          await expect
            .poll(() =>
              page
                .locator('.frame-preview')
                .evaluateAll((images) =>
                  images.every(
                    (image) =>
                      image.complete && image.naturalWidth > 0 && image.naturalHeight === 640,
                  ),
                ),
            )
            .toBe(true);
          await page.evaluate(() => {
            window.maxLiveFrames = 0;
            new MutationObserver(
              () =>
                (window.maxLiveFrames = Math.max(
                  window.maxLiveFrames,
                  document.querySelectorAll('iframe').length,
                )),
            ).observe(document.querySelector('.canvas-container'), {
              childList: true,
              subtree: true,
            });
          });
          await page.getByLabel('Jump to screen').selectOption('screen-0');
          await expect(page.locator('[data-frame="screen-0"] .frame-preview')).toBeVisible();
          await page.locator('.canvas').press('1');
          await expect(page.locator('.zoom-value')).toHaveText('100%');
          const canvas = await page.locator('.canvas').boundingBox();
          await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
          for (const delta of [80, -80, 120, -120]) {
            await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
            await page.mouse.down();
            await page.mouse.move(
              canvas.x + canvas.width / 2 + delta,
              canvas.y + canvas.height / 2,
              { steps: 6 },
            );
            await page.mouse.up();
            await page.waitForTimeout(400);
            await expect(page.locator('iframe')).toHaveCount(0);
          }
          expect(mockRequests).toBe(0);
          await page.getByRole('button', { name: 'Interact', exact: true }).click();
          await expect(page.locator('iframe')).toHaveCount(1);
          const iframe = page.locator('.interaction-stage iframe');
          expect(await iframe.getAttribute('sandbox')).toBe('allow-scripts');
          const mock = page.frameLocator('.interaction-stage iframe');
          await mock.locator('button').click();
          await expect(mock.locator('button')).toHaveText('1');
          expect(
            await mock.locator('body').evaluate(() => {
              let parentBlocked = false,
                storageBlocked = false;
              try {
                parent.document.title;
              } catch {
                parentBlocked = true;
              }
              try {
                localStorage.getItem('test');
              } catch {
                storageBlocked = true;
              }
              return { parentBlocked, storageBlocked };
            }),
          ).toEqual({ parentBlocked: true, storageBlocked: true });
          await page.getByRole('button', { name: 'Next screen', exact: true }).click();
          await expect(page.getByRole('dialog')).toHaveAttribute(
            'aria-label',
            'Interact with Screen 2',
          );
          await expect(page.locator('iframe')).toHaveCount(1);
          await page.getByRole('button', { name: 'Back to canvas', exact: true }).click();
          await expect(page.locator('.interaction-stage iframe')).toHaveCount(0);
          // Rapid camera movement must not load each intermediate selection.
          await page.getByRole('button', { name: 'Fit all screens', exact: true }).click();
          await expect(page.locator('iframe')).toHaveCount(0);
          const before = mockRequests;
          await page.evaluate(async () => {
            const select = document.querySelector('select[aria-label="Jump to screen"]');
            for (let i = 5; i < 20; i++) {
              select.value = `screen-${i}`;
              select.dispatchEvent(new Event('change', { bubbles: true }));
              await new Promise((resolve) => setTimeout(resolve, 16));
            }
          });
          await page.waitForTimeout(400);
          await expect(page.locator('[data-frame="screen-19"] .frame-preview')).toBeVisible();
          await expect(page.locator('iframe')).toHaveCount(0);
          expect(mockRequests).toBe(before);
          expect(await page.evaluate(() => window.maxLiveFrames)).toBe(1);
          await page.getByRole('button', { name: 'Fit all screens', exact: true }).click();
          await expect(page.locator('iframe')).toHaveCount(0);
          await page.getByLabel('Jump to screen').selectOption('screen-74');
          await expect(page.locator('iframe')).toHaveCount(0);
          await expect(page.locator('[data-frame="screen-74"] .frame-placeholder')).toContainText(
            'Open this screen',
          );
          await page.getByRole('button', { name: 'Interact', exact: true }).click();
          await expect(page.frameLocator('.interaction-stage iframe').locator('button')).toHaveText(
            '0',
          );
          await expect(page.locator('iframe')).toHaveCount(1);
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
          expect(errors).toEqual([]);
          console.log(
            `${engine.name()} ${width}px: 75 frames, static pan/zoom with zero document requests, one live Interact screen, old-bundle interaction and sandbox passed`,
          );
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await preview?.close();
  await rm(directory, { recursive: true, force: true });
}
