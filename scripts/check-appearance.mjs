import { chromium, webkit, expect } from '@playwright/test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPreview } from './local-preview.mjs';

const directory = await mkdtemp(join(tmpdir(), 'mgm-appearance-'));
const fixture = (
  delayed,
) => `<!doctype html><meta name="viewport" content="width=device-width"><style>
#media { background: rgb(255,255,255); } @media (prefers-color-scheme: dark) { #media { background: rgb(0,0,0); } }
</style><body data-fixture="dark"><div id="media">Media appearance</div><input aria-label="Draft"><a href="delayed.html">Navigate inside mock</a><script>
window.messages = [];
window.connectAppearance = () => {
  const origin = new URL(location.href).origin;
  addEventListener('message', event => {
    if (parent === window || event.source !== parent || event.origin !== origin) return;
    const data = event.data;
    if (!data || data.type !== 'mgm:appearance' || data.version !== 1 || !['light','dark'].includes(data.appearance)) return;
    window.messages.push(data);
    document.body.dataset.appearance = data.appearance;
  });
  parent.postMessage({type:'mgm:appearance:ready', version:1}, origin);
};
${delayed ? '' : 'window.connectAppearance();'}
</script>`;
let preview;
try {
  await writeFile(join(directory, 'screen.html'), fixture(false));
  await writeFile(join(directory, 'delayed.html'), fixture(true));
  // The static image represents an explicitly dark review state; MGM must keep its bytes/URL.
  await writeFile(
    join(directory, 'preview.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      project: { id: 'appearance-check', name: 'Appearance check' },
      boards: [
        {
          id: 'review',
          name: 'Dark review',
          frames: [
            {
              id: 'first',
              name: 'Explicit dark fixture',
              entry: 'screen.html',
              preview: 'preview.png',
              width: 390,
              height: 844,
            },
            {
              id: 'delayed',
              name: 'Delayed theme listener',
              entry: 'delayed.html',
              width: 390,
              height: 844,
            },
          ],
        },
      ],
      files: ['screen.html', 'delayed.html', 'preview.png'],
    }),
  );
  preview = await startPreview({ directories: [directory], port: 0, onUpdate() {} });
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [390, 1024, 1440]) {
        const initial = width === 1024 ? 'dark' : 'light';
        const opposite = initial === 'dark' ? 'light' : 'dark';
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          // Disable Playwright’s per-frame override to test native iframe color-scheme inheritance.
          colorScheme: null,
          isMobile: width < 1440,
          hasTouch: width < 1440,
        });
        try {
          const page = await context.newPage();
          const errors = [];
          let documents = 0;
          page.on('pageerror', (e) => errors.push(e.message));
          page.on('request', (r) => {
            if (r.resourceType() === 'document' && r.url().includes('/mocks/')) documents++;
          });
          await page.addInitScript((value) => {
            try {
              localStorage.setItem('mgm-theme', value);
            } catch {}
          }, initial);
          await page.goto(preview.origin);
          await page.getByLabel('Jump to screen').selectOption('first');
          const previewImage = page.locator('[data-frame="first"] img');
          await expect(previewImage).toBeVisible();
          const previewSource = await previewImage.getAttribute('src');
          expect(documents).toBe(0);
          await page.getByRole('button', { name: 'Interact', exact: true }).click();
          const mock = page.frameLocator('.interaction-stage iframe');
          const body = mock.locator('body');
          const verifyAppearance = async (appearance) => {
            await expect(body).toHaveAttribute('data-appearance', appearance);
            await expect(
              page.getByRole('dialog').getByRole('button', {
                name: `Appearance: ${appearance}. Switch to ${appearance === 'light' ? 'dark' : 'light'} appearance`,
                exact: true,
              }),
            ).toHaveText(appearance === 'light' ? 'Light' : 'Dark');
            await expect
              .poll(() => body.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches))
              .toBe(appearance === 'dark');
            await expect(mock.locator('#media')).toHaveCSS(
              'background-color',
              appearance === 'dark' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)',
            );
          };
          await verifyAppearance(initial);
          await expect(body).toHaveAttribute('data-fixture', 'dark');
          const before = documents;
          await mock.getByLabel('Draft').fill('Preserve this draft');
          await page
            .getByRole('dialog')
            .getByRole('button', { name: /^Appearance:/ })
            .click();
          await verifyAppearance(opposite);
          await expect(mock.getByLabel('Draft')).toHaveValue('Preserve this draft');
          expect(documents).toBe(before);
          // Invalid readiness, unrelated sources and forged state messages cannot change the viewer or trigger replies.
          const received = await body.evaluate(() => window.messages.length);
          await page.evaluate(() => {
            const source = document.querySelector('iframe').contentWindow;
            for (const event of [
              {
                origin: 'null',
                source: window,
                data: { type: 'mgm:appearance:ready', version: 1 },
              },
              {
                origin: location.origin,
                source,
                data: { type: 'mgm:appearance:ready', version: 1 },
              },
              { origin: 'null', source, data: { type: 'mgm:appearance:ready', version: 2 } },
              {
                origin: 'null',
                source,
                data: { type: 'mgm:appearance', version: 1, appearance: 'light' },
              },
              { origin: 'null', source, data: null },
            ])
              window.dispatchEvent(new MessageEvent('message', event));
          });
          await page.waitForTimeout(80);
          expect(await body.evaluate(() => window.messages.length)).toBe(received);
          expect(await page.locator('html').getAttribute('data-theme')).toBe(opposite);
          // A newly navigated document registers after load; readiness must supply the current state.
          await mock.getByRole('link', { name: 'Navigate inside mock' }).click();
          await expect(body).not.toHaveAttribute('data-appearance');
          await body.evaluate(() => window.connectAppearance());
          await verifyAppearance(opposite);
          await page.getByRole('button', { name: 'Next screen', exact: true }).click();
          await expect(page.getByRole('dialog')).toHaveAttribute(
            'aria-label',
            'Interact with Delayed theme listener',
          );
          await expect(body).not.toHaveAttribute('data-appearance');
          await body.evaluate(() => window.connectAppearance());
          await verifyAppearance(opposite);
          await page.getByRole('button', { name: 'Back to canvas' }).click();
          await expect(page.locator('iframe')).toHaveCount(0);
          await expect(previewImage).toHaveAttribute('src', previewSource);
          expect(await page.evaluate(() => localStorage.getItem('mgm-theme'))).toBe(opposite);
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
          expect(errors).toEqual([]);
          console.log(
            `${engine.name()} ${width}px: inherited CSS/JS appearance, live toggle without reload, navigation/readiness, message validation, unchanged Pan preview passed`,
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
