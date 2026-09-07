import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { pbkdf2Sync } from 'node:crypto';

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
    external: ['node:crypto'],
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
        compatibilityFlags: ['nodejs_compat'],
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
  expect(stored?.password_hash).toMatch(/^scrypt:16384:8:5:/);
  const login = await post('/api/login', credentials);
  expect(login.status).toBe(200);
  expect(login.headers.get('set-cookie')).toContain('HttpOnly');
  expect(
    (await post('/api/login', { ...credentials, password: 'incorrect-password' })).status,
  ).toBe(401);
}, 30000);

it.each([100000, 600000])(
  'handles legacy %i-iteration credentials without a JavaScript fallback',
  async (iterations) => {
    const db = await mf.getD1Database('DB');
    const id = `legacy-${iterations}`;
    const email = `${id}@example.com`;
    const password = 'legacy-test-password';
    const salt = 'ab'.repeat(32);
    const hash = `pbkdf2-sha256:${iterations}:${salt}:${pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex')}`;
    await db
      .prepare(
        "INSERT INTO users (id,email,name,role,password_hash,created_at) VALUES (?,?,?,'viewer',?,?)",
      )
      .bind(id, email, id, hash, new Date().toISOString())
      .run();
    const response = await post('/api/login', { email, password });
    const stored = await db
      .prepare('SELECT password_hash FROM users WHERE id=?')
      .bind(id)
      .first<{ password_hash: string }>();
    const sessions = await db
      .prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?')
      .bind(id)
      .first<{ count: number }>();
    if (iterations === 100000) {
      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toContain('HttpOnly');
      expect(stored?.password_hash).toMatch(/^scrypt:16384:8:5:/);
      expect(sessions?.count).toBe(1);
      expect((await post('/api/login', { email, password })).status).toBe(200);
    } else {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Email or password is incorrect.' });
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(stored?.password_hash).toBe(hash);
      expect(sessions?.count).toBe(0);
    }
  },
  30000,
);
