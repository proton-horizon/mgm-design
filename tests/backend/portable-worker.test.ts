import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

let mf: Miniflare;
const origin = 'https://portable.example.com';
const credentials = { email: 'owner@example.com', password: 'long-portable-test-password' };

beforeAll(async () => {
  const bundled = await build({
    entryPoints: ['worker/index.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });
  const cappedNative = `
    const originalDeriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);
    Object.defineProperty(crypto.subtle, 'deriveBits', { value: async (algorithm, key, length) => {
      if (algorithm.name === 'PBKDF2' && algorithm.iterations > 100000) {
        throw new DOMException('Pbkdf2 failed: iteration counts above 100000 are not supported', 'NotSupportedError');
      }
      return originalDeriveBits(algorithm, key, length);
    }});
  `;
  mf = new Miniflare({
    workers: [
      {
        name: 'portable-auth',
        modules: true,
        script: cappedNative + bundled.outputFiles[0].text,
        compatibilityDate: '2026-07-01',
        d1Databases: ['DB'],
        r2Buckets: ['MOCKS'],
        bindings: { SETUP_SECRET: 'portable-setup-secret' },
        serviceBindings: { ASSETS: () => new Response('viewer') },
      },
    ],
  });
  const db = await mf.getD1Database('DB');
  const migration = await readFile('migrations/0001_initial.sql', 'utf8');
  await db.batch(
    migration
      .split(';')
      .map((sql) => sql.trim())
      .filter(Boolean)
      .map((sql) => db.prepare(sql)),
  );
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

async function post(path: string, data: unknown) {
  return mf.dispatchFetch(origin + path, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

it('creates and authenticates accounts when the deployed-style native limit rejects 600,000 iterations', async () => {
  const missing = await post('/api/login', {
    email: 'missing@example.com',
    password: 'nonexistent-password',
  });
  expect(missing.status).toBe(401);
  const setup = await post('/api/setup', {
    ...credentials,
    name: 'Owner',
    setupSecret: 'portable-setup-secret',
  });
  expect(setup.status).toBe(200);
  const db = await mf.getD1Database('DB');
  const stored = await db
    .prepare('SELECT password_hash FROM users WHERE email=?')
    .bind(credentials.email)
    .first<{ password_hash: string }>();
  expect(stored?.password_hash).toMatch(/^pbkdf2-sha256:600000:/);
  const login = await post('/api/login', credentials);
  expect(login.status).toBe(200);
  expect(login.headers.get('set-cookie')).toContain('HttpOnly');
  expect(
    (await post('/api/login', { ...credentials, password: 'incorrect-password' })).status,
  ).toBe(401);
}, 30000);
