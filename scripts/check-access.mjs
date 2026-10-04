import { chromium, webkit, expect } from '@playwright/test';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { applyMigrations } from './local-preview.mjs';

// Isolated real Worker and database: no deployed accounts, cookies, or invitation links.
const compiled = await build({
  entryPoints: ['worker/index.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  external: ['node:crypto'],
});
const assets = new Map();
for (const name of await readdir('dist', { recursive: true })) {
  if (name.endsWith('.html') || name.endsWith('.js') || name.endsWith('.css')) {
    assets.set('/' + name, await readFile(resolve('dist', name)));
  }
}
const mf = new Miniflare({
  host: '127.0.0.1',
  port: 0,
  modules: true,
  script: compiled.outputFiles[0].text,
  compatibilityDate: '2026-07-01',
  compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'],
  r2Buckets: ['MOCKS'],
  bindings: { SETUP_SECRET: 'local-browser-test-setup' },
  serviceBindings: {
    ASSETS: (request) => {
      const path = new URL(request.url).pathname;
      const content = assets.get(path === '/' ? '/index.html' : path);
      return new Response(content ?? 'Not found', {
        status: content ? 200 : 404,
        headers: {
          'Content-Type': path.endsWith('.js')
            ? 'text/javascript'
            : path.endsWith('.css')
              ? 'text/css'
              : 'text/html',
        },
      });
    },
  },
});
const password = 'browser-test-password';
if (process.env.MGM_ACCESS_SCREENSHOTS) await mkdir('artifacts/access', { recursive: true });
try {
  await applyMigrations(await mf.getD1Database('DB'));
  const origin = (await mf.ready).origin;
  const setup = await mf.dispatchFetch(origin + '/api/setup', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'owner@example.com',
      name: 'Owner',
      password,
      setupSecret: 'local-browser-test-setup',
    }),
  });
  expect(setup.status).toBe(200);
  const ownerSession = setup.headers.get('set-cookie').split(';')[0].split('=')[1];
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch();
    try {
      for (const width of [390, 1440]) {
        await (await mf.getD1Database('DB')).prepare('DELETE FROM login_limits').run();
        const options = {
          viewport: { width, height: 900 },
          isMobile: width === 390,
          hasTouch: width === 390,
        };
        const owner = await browser.newContext(options);
        const recipient = await browser.newContext(options);
        try {
          const errors = [];
          await owner.addCookies([{ name: 'mgm_session', value: ownerSession, url: origin }]);
          const page = await owner.newPage();
          page.on('pageerror', (e) => errors.push(e.message));
          const openMenu = async (p) => {
            if (width === 390)
              await p.getByRole('button', { name: 'Open projects', exact: true }).click();
          };
          await page.goto(origin);
          await openMenu(page);
          await page.getByRole('button', { name: 'Site administration', exact: true }).click();
          await page.getByRole('button', { name: 'People', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: 'Site administration' });
          if (process.env.MGM_ACCESS_SCREENSHOTS)
            await page.screenshot({
              path: `artifacts/access/${engine.name()}-${width}-people.png`,
            });
          expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
          const email = `${engine.name()}-${width}@example.com`;
          await dialog.getByLabel('Name', { exact: true }).fill('Invited person');
          await dialog.getByLabel('Email', { exact: true }).fill(email);
          await dialog.getByLabel('Role', { exact: true }).selectOption('admin');
          await dialog.getByRole('button', { name: 'Create invite', exact: true }).click();
          await expect(dialog.getByRole('status')).toContainText(email);
          const link = await dialog.getByRole('status').locator('code').textContent();
          await dialog.getByRole('button', { name: 'Done', exact: true }).click();
          const guest = await recipient.newPage();
          guest.on('pageerror', (e) => errors.push(e.message));
          await guest.goto(link);
          await expect(guest.getByRole('heading', { name: 'You’re invited.' })).toBeVisible();
          expect(new URL(guest.url()).hash).toBe('');
          if (process.env.MGM_ACCESS_SCREENSHOTS)
            await guest.screenshot({
              path: `artifacts/access/${engine.name()}-${width}-invite.png`,
            });
          await expect(guest.locator('main')).toContainText('Site admin');
          await guest.getByLabel('New password', { exact: true }).fill(password);
          await guest.getByLabel('Confirm new password').fill(password + 'mismatch');
          await guest.getByRole('button', { name: 'Save password' }).click();
          await expect(guest.getByRole('alert')).toContainText('do not match');
          await guest.getByLabel('Confirm new password').fill(password);
          await guest.getByRole('button', { name: 'Save password' }).click();
          await guest.getByRole('button', { name: 'Continue to sign in' }).click();
          const signIn = async (chosen) => {
            await guest.getByLabel('Email', { exact: true }).fill(email);
            await guest.getByLabel('Password', { exact: true }).fill(chosen);
            await guest.getByRole('button', { name: 'Sign in', exact: true }).click();
            await expect(guest.locator('.workspace')).toBeVisible();
          };
          await signIn(password);
          await openMenu(guest);
          await expect(
            guest.getByRole('button', { name: 'Site administration', exact: true }),
          ).toBeVisible();
          await page.getByRole('button', { name: 'Close administration' }).click();
          await page.getByRole('button', { name: 'Site administration', exact: true }).click();
          await page.getByRole('button', { name: 'People', exact: true }).click();
          await page.getByLabel(`Role for ${email}`).selectOption('viewer');
          await expect(page.getByLabel(`Role for ${email}`)).toBeEnabled();
          await guest.reload();
          await signIn(password);
          await openMenu(guest);
          await expect(
            guest.getByRole('button', { name: 'Site administration', exact: true }),
          ).toHaveCount(0);
          await guest.getByRole('button', { name: 'Change password', exact: true }).click();
          await guest.getByLabel('Current password').fill(password);
          await guest.getByLabel('New password', { exact: true }).fill(password + '-changed');
          await guest.getByLabel('Confirm new password').fill(password + '-changed');
          await guest.getByRole('button', { name: 'Save password' }).click();
          await signIn(password + '-changed');
          const row = page
            .locator('.admin-row')
            .filter({ has: page.getByLabel(`Role for ${email}`) });
          await row.getByRole('button', { name: 'Create reset link' }).click();
          const reset = await page.getByRole('status').locator('code').textContent();
          // Follow another link in the same open tab; hash navigation must also show account access.
          await guest.goto(reset);
          await expect(guest.getByRole('heading', { name: 'Choose your password.' })).toBeVisible();
          await guest.getByLabel('New password', { exact: true }).fill(password + '-reset');
          await guest.getByLabel('Confirm new password').fill(password + '-reset');
          await guest.getByRole('button', { name: 'Save password' }).click();
          await guest.getByRole('button', { name: 'Continue to sign in' }).click();
          await signIn(password + '-reset');
          expect(
            await guest.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          ).toBe(true);
          expect(errors).toEqual([]);
          console.log(
            `${engine.name()} ${width}px: invitation, role change, password change, reset passed`,
          );
        } finally {
          await owner.close();
          await recipient.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await mf.dispose();
}
