import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { applyMigrations } from '../../scripts/local-preview.mjs';

const origin = 'https://access.example.com';
const password = 'my-original-password';
const replacement = 'my-replacement-password';
let mf: Miniflare;
let ownerCookie: string;
let ownerId: string;
let sequence = 0;
const cookie = (response: Response) => response.headers.get('set-cookie')!.split(';')[0];
async function call(
  path: string,
  data?: unknown,
  session?: string,
  method = 'POST',
  source = origin,
) {
  return mf.dispatchFetch(origin + path, {
    method,
    headers: {
      Origin: source,
      'Content-Type': 'application/json',
      ...(session ? { Cookie: session } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
async function invite(role = 'viewer', email = `person-${++sequence}@example.com`) {
  const response = await call('/api/admin/invites', { email, name: 'Person', role }, ownerCookie);
  expect(response.status).toBe(201);
  const value = (await response.json()) as any;
  return { ...value, token: new URL(value.url).hash.slice('#account='.length) };
}
async function accept(token: string, chosen = password) {
  return call('/api/account-link/accept', { token, password: chosen });
}
async function login(email: string, chosen = password) {
  return call('/api/login', { email, password: chosen });
}
async function account(role = 'viewer') {
  const link = await invite(role);
  expect((await accept(link.token)).status).toBe(200);
  const signedIn = await login(link.email);
  expect(signedIn.status).toBe(200);
  const { user } = (await signedIn.json()) as any;
  return { ...user, cookie: cookie(signedIn) };
}
async function reset(userId: string) {
  const response = await call(`/api/admin/users/${userId}/reset-link`, {}, ownerCookie);
  expect(response.status).toBe(201);
  return new URL(((await response.json()) as any).url).hash.slice('#account='.length);
}

beforeAll(async () => {
  const output = await build({
    entryPoints: ['worker/index.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: ['node:crypto'],
  });
  mf = new Miniflare({
    modules: true,
    script: output.outputFiles[0].text,
    compatibilityDate: '2026-07-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    r2Buckets: ['MOCKS'],
    bindings: { SETUP_SECRET: 'local-test-setup-secret' },
    serviceBindings: { ASSETS: () => new Response('viewer') },
  });
  await applyMigrations(await mf.getD1Database('DB'));
  const response = await call('/api/setup', {
    email: 'owner@example.com',
    name: 'Owner',
    password,
    setupSecret: 'local-test-setup-secret',
  });
  expect(response.status).toBe(200);
  ownerCookie = cookie(response);
  ownerId = ((await response.json()) as any).user.id;
}, 30000);
beforeEach(async () => {
  const db = await mf.getD1Database('DB');
  await db.prepare('DELETE FROM login_limits').run();
});
afterAll(async () => {
  await mf?.dispose();
});

it('invites both roles without exposing token hashes or creating an account before acceptance', async () => {
  for (const role of ['viewer', 'admin']) {
    const link = await invite(role);
    expect(link.url).toMatch(/^https:\/\/access.example.com\/#account=[a-f0-9]{64}$/);
    expect(Date.parse(link.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86400000);
    const db = await mf.getD1Database('DB');
    expect(
      await db.prepare('SELECT id FROM users WHERE email=?').bind(link.email).first(),
    ).toBeNull();
    const stored = await db
      .prepare('SELECT hash FROM account_links WHERE email=?')
      .bind(link.email)
      .first<any>();
    expect(stored.hash).not.toBe(link.token);
    const details = await call('/api/account-link', { token: link.token });
    expect(await details.json()).toMatchObject({ email: link.email, role, kind: 'invite' });
    const listed = await call('/api/admin/invites', undefined, ownerCookie, 'GET');
    const listing = await listed.text();
    expect(listing).not.toContain(link.token);
    expect(listing).not.toContain(stored.hash);
    expect((await accept(link.token, 'short')).status).toBe(400);
    expect((await accept(link.token)).status).toBe(200);
    expect((await accept(link.token)).status).toBe(410);
    const signedIn = await login(link.email);
    expect(((await signedIn.json()) as any).user.role).toBe(role);
    expect((await call('/api/admin/users', undefined, cookie(signedIn), 'GET')).status).toBe(
      role === 'admin' ? 200 : 403,
    );
  }
});

it('replaces and revokes invites, rejects invalid roles and existing accounts', async () => {
  const first = await invite();
  const second = await invite('admin', first.email);
  expect((await accept(first.token)).status).toBe(410);
  expect(await (await call('/api/account-link', { token: second.token })).json()).toMatchObject({
    role: 'admin',
  });
  const pending = await call('/api/admin/invites', undefined, ownerCookie, 'GET');
  const target = ((await pending.json()) as any).invites.find((x: any) => x.email === first.email);
  expect(
    (await call(`/api/admin/invites/${target.id}`, undefined, ownerCookie, 'DELETE')).status,
  ).toBe(200);
  expect((await accept(second.token)).status).toBe(410);
  expect(
    (
      await call(
        '/api/admin/invites',
        { email: 'x@example.com', name: 'X', role: 'root' },
        ownerCookie,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await call(
        '/api/admin/invites',
        { email: 'owner@example.com', name: 'Owner', role: 'admin' },
        ownerCookie,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await call(
        '/api/admin/users',
        { email: 'x@example.com', name: 'X', password, role: 'admin' },
        ownerCookie,
      )
    ).status,
  ).toBe(404);
});

it('enforces expiry and allows exactly one concurrent redemption', async () => {
  const expired = await invite();
  const db = await mf.getD1Database('DB');
  await db.prepare('UPDATE account_links SET expires_at=0 WHERE email=?').bind(expired.email).run();
  expect((await accept(expired.token)).status).toBe(410);
  const link = await invite();
  const responses = await Promise.all([
    accept(link.token, password),
    accept(link.token, replacement),
  ]);
  expect(responses.map((x) => x.status).sort()).toEqual([200, 410]);
  const winningPassword = responses[0].status === 200 ? password : replacement;
  expect((await login(link.email, winningPassword)).status).toBe(200);
});

it('limits link attempts and rejects opaque-origin and viewer account administration', async () => {
  const user = await account();
  expect(
    (
      await call(
        '/api/admin/invites',
        { email: 'no@example.com', name: 'No', role: 'admin' },
        user.cookie,
      )
    ).status,
  ).toBe(403);
  expect((await call(`/api/admin/users/${user.id}/reset-link`, {}, user.cookie)).status).toBe(403);
  expect(
    (await call(`/api/admin/users/${ownerId}`, { role: 'viewer' }, user.cookie, 'PATCH')).status,
  ).toBe(403);
  expect((await call('/api/admin/invites', {}, ownerCookie, 'POST', 'null')).status).toBe(403);
  expect((await call('/api/account-link/accept', {}, undefined, 'POST', 'null')).status).toBe(403);
  expect(
    (
      await call(
        '/api/account/password',
        { currentPassword: password, password: replacement },
        user.cookie,
        'POST',
        'null',
      )
    ).status,
  ).toBe(403);
  for (let i = 0; i < 31; i++) {
    const response = await call('/api/account-link', { token: '0'.repeat(64) });
    if (i === 30) expect(response.status).toBe(429);
  }
});

it('lets viewers change their password and invalidates every session, grant, and reset link', async () => {
  const user = await account();
  const otherSession = cookie(await login(user.email));
  const resetToken = await reset(user.id);
  const db = await mf.getD1Database('DB');
  const sessionHash = await db
    .prepare('SELECT hash FROM sessions WHERE user_id=? LIMIT 1')
    .bind(user.id)
    .first<any>();
  await db
    .prepare(
      'INSERT INTO grants(hash,session_hash,project_id,publication_id,expires_at) VALUES(?,?,?,?,?)',
    )
    .bind('grant', sessionHash.hash, 'project', 'publication', Date.now() + 3600000)
    .run();
  expect(
    (
      await call(
        '/api/account/password',
        { currentPassword: 'incorrect', password: replacement },
        user.cookie,
      )
    ).status,
  ).toBe(400);
  const changed = await call(
    '/api/account/password',
    { currentPassword: password, password: replacement },
    user.cookie,
  );
  expect(changed.status).toBe(200);
  expect(changed.headers.get('set-cookie')).toContain('Max-Age=0');
  for (const session of [user.cookie, otherSession])
    expect((await call('/api/projects', undefined, session, 'GET')).status).toBe(401);
  expect(await db.prepare('SELECT hash FROM grants WHERE hash=?').bind('grant').first()).toBeNull();
  expect((await accept(resetToken)).status).toBe(410);
  expect((await login(user.email)).status).toBe(401);
  expect((await login(user.email, replacement)).status).toBe(200);
});

it('reset links expire, supersede older links, are single-use, and preserve the account role', async () => {
  const user = await account('admin');
  const first = await reset(user.id);
  const second = await reset(user.id);
  expect((await accept(first)).status).toBe(410);
  const details = (await (await call('/api/account-link', { token: second })).json()) as any;
  expect(Date.parse(details.expiresAt) - Date.now()).toBeLessThanOrEqual(3600000);
  expect((await accept(second, replacement)).status).toBe(200);
  expect((await accept(second, password)).status).toBe(410);
  expect((await call('/api/projects', undefined, user.cookie, 'GET')).status).toBe(401);
  expect((await login(user.email)).status).toBe(401);
  expect(((await (await login(user.email, replacement)).json()) as any).user.role).toBe('admin');
  const third = await reset(user.id);
  const db = await mf.getD1Database('DB');
  await db.prepare('UPDATE account_links SET expires_at=0 WHERE user_id=?').bind(user.id).run();
  expect((await accept(third)).status).toBe(410);
});

it('changes permissions, revokes affected links, and prevents self-demotion or direct password resets', async () => {
  const user = await account();
  const token = await reset(user.id);
  expect(
    (await call(`/api/admin/users/${user.id}`, { role: 'admin' }, ownerCookie, 'PATCH')).status,
  ).toBe(200);
  expect((await accept(token)).status).toBe(410);
  expect((await call('/api/projects', undefined, user.cookie, 'GET')).status).toBe(401);
  const promoted = await login(user.email);
  expect(
    ((await (await call('/api/session', undefined, cookie(promoted), 'GET')).json()) as any).user
      .role,
  ).toBe('admin');
  const invitation = await call(
    '/api/admin/invites',
    { name: 'Future', email: 'future@example.com', role: 'admin' },
    cookie(promoted),
  );
  const pendingToken = new URL(((await invitation.json()) as any).url).hash.slice(
    '#account='.length,
  );
  expect(
    (await call(`/api/admin/users/${user.id}`, { role: 'viewer' }, ownerCookie, 'PATCH')).status,
  ).toBe(200);
  expect((await accept(pendingToken)).status).toBe(410);
  expect(
    (await call(`/api/admin/users/${ownerId}`, { role: 'viewer' }, ownerCookie, 'PATCH')).status,
  ).toBe(400);
  expect(
    (await call(`/api/admin/users/${ownerId}`, { disabled: true }, ownerCookie, 'PATCH')).status,
  ).toBe(400);
  expect(
    (await call(`/api/admin/users/${user.id}`, { password: replacement }, ownerCookie, 'PATCH'))
      .status,
  ).toBe(400);
});

it('disabled accounts cannot get or redeem reset links even after re-enabling', async () => {
  const user = await account();
  const token = await reset(user.id);
  expect(
    (await call(`/api/admin/users/${user.id}`, { disabled: true }, ownerCookie, 'PATCH')).status,
  ).toBe(200);
  expect((await call(`/api/admin/users/${user.id}/reset-link`, {}, ownerCookie)).status).toBe(404);
  expect((await accept(token)).status).toBe(410);
  expect(
    (await call(`/api/admin/users/${user.id}`, { disabled: false }, ownerCookie, 'PATCH')).status,
  ).toBe(200);
  expect((await accept(token)).status).toBe(410);
});
