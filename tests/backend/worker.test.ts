import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { decodeBundle, validateManifest } from '../../worker/bundle.mjs';

const origin = 'https://design.example.com';
let mf: Miniflare;
let adminCookie = '';
let projectToken = '';
const manifest = {
  schemaVersion: 1,
  project: { id: 'rubber-ducky', name: 'Rubber Ducky' },
  boards: [
    {
      id: 'app',
      name: 'App',
      frames: [{ id: 'home', name: 'Home', entry: 'app/index.html', width: 390, height: 844 }],
    },
  ],
  files: ['app/index.html', 'app/main.js'],
};
const bundle = {
  manifest,
  files: {
    'app/index.html': Buffer.from(
      '<!doctype html><script type="module" src="./main.js"></script>',
    ).toString('base64'),
    'app/main.js': Buffer.from('document.body.textContent="Duck"').toString('base64'),
  },
};
async function request(
  path: string,
  options: {
    method?: string;
    data?: unknown;
    cookie?: string;
    token?: string;
    origin?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (options.data !== undefined) headers['Content-Type'] = 'application/json';
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.origin !== undefined) headers.Origin = options.origin;
  return mf.dispatchFetch(origin + path, {
    method: options.method || 'GET',
    headers,
    body: options.data === undefined ? undefined : JSON.stringify(options.data),
  });
}
async function admin(path: string, method: string, data: unknown) {
  return request(path, { method, data, cookie: adminCookie, origin });
}
async function attempt(id: string, sequence: number) {
  const response = await request('/api/publish/rubber-ducky/attempts', {
    method: 'POST',
    token: projectToken,
    data: {
      id,
      sequence,
      commit: `commit-${id}`,
      runUrl: 'https://github.com/proton-horizon/RubberDucky/actions/runs/123',
    },
  });
  expect(response.status).toBe(201);
}
async function upload(id: string, data: unknown = bundle) {
  return request(`/api/publish/rubber-ducky/attempts/${id}`, {
    method: 'PUT',
    token: projectToken,
    data,
  });
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
    workers: [
      {
        name: 'mgm-test',
        modules: true,
        script: output.outputFiles[0].text,
        compatibilityDate: '2026-07-01',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        r2Buckets: ['MOCKS'],
        bindings: { SETUP_SECRET: 'test-bootstrap-secret-strong', SITE_NAME: 'Proton Horizon' },
        serviceBindings: {
          ASSETS: () =>
            new Response('<!doctype html>viewer', { headers: { 'Content-Type': 'text/html' } }),
        },
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

describe('deployment backend', () => {
  it('requires the setup secret and closes bootstrap atomically', async () => {
    expect((await request('/api/projects')).status).toBe(401);
    const initial = await request('/api/session');
    expect(await initial.json()).toMatchObject({
      user: null,
      setupRequired: true,
      siteName: 'Proton Horizon',
    });
    expect(
      (
        await request('/api/setup', {
          method: 'POST',
          origin,
          data: {
            email: 'owner@example.com',
            name: 'Owner',
            password: 'a-long-test-password',
            setupSecret: 'incorrect',
          },
        })
      ).status,
    ).toBe(403);
    const input = {
      email: 'owner@example.com',
      name: 'Owner',
      password: 'a-long-test-password',
      setupSecret: 'test-bootstrap-secret-strong',
    };
    const setup = await request('/api/setup', { method: 'POST', origin, data: input });
    expect(setup.status).toBe(200);
    adminCookie = setup.headers.get('set-cookie')!.split(';')[0];
    expect(setup.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict; Secure');
    expect((await request('/api/setup', { method: 'POST', origin, data: input })).status).toBe(409);
  });
  it('rejects opaque-origin admin mutations and viewer administration', async () => {
    expect(
      (
        await request('/api/admin/projects', {
          method: 'POST',
          cookie: adminCookie,
          origin: 'null',
          data: { id: 'other', name: 'Other' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await admin('/api/admin/users', 'POST', {
          email: 'viewer@example.com',
          name: 'Viewer',
          password: 'viewer-long-password',
          role: 'viewer',
        })
      ).status,
    ).toBe(201);
    const login = await request('/api/login', {
      method: 'POST',
      origin,
      data: { email: 'viewer@example.com', password: 'viewer-long-password' },
    });
    const viewerCookie = login.headers.get('set-cookie')!.split(';')[0];
    expect((await request('/api/admin/users', { cookie: viewerCookie })).status).toBe(403);
  });
  it('creates a project and enforces token scope', async () => {
    const response = await admin('/api/admin/projects', 'POST', {
      id: 'rubber-ducky',
      name: 'Rubber Ducky',
    });
    expect(response.status).toBe(201);
    projectToken = ((await response.json()) as any).token;
    expect(
      (
        await request('/api/publish/other/attempts', {
          method: 'POST',
          token: projectToken,
          data: {},
        })
      ).status,
    ).toBe(403);
    expect(
      (await request('/api/publish/rubber-ducky/attempts', { method: 'POST', data: {} })).status,
    ).toBe(401);
  });
  it('publishes complete snapshots and keeps successful content after failure', async () => {
    await attempt('first', 1);
    const published = await upload('first');
    expect(await published.json()).toMatchObject({ ok: true, status: 'published' });
    await attempt('invalid', 2);
    expect((await upload('invalid', { ...bundle, files: {} })).status).toBe(400);
    const report = await request('/api/publish/rubber-ducky/attempts/invalid/failure', {
      method: 'POST',
      token: projectToken,
      data: { message: 'secret must never be reflected' },
    });
    expect(report.status).toBe(200);
    const response = await request('/api/projects', { cookie: adminCookie });
    const project = ((await response.json()) as any).projects[0];
    expect(project.activePublication.id).toBe('first');
    expect(project.publication.status).toBe('failed');
    expect(project.publication.message).not.toContain('secret');
    expect(project.boards[0].frames).toHaveLength(1);
  });
  it('rejects stale completion and supports idempotent completed retries', async () => {
    await attempt('old', 3);
    await attempt('new', 4);
    expect((await upload('old')).status).toBe(409);
    expect((await upload('new')).status).toBe(200);
    expect((await upload('new')).status).toBe(200);
    const response = await request('/api/projects', { cookie: adminCookie });
    expect(((await response.json()) as any).projects[0].activePublication.id).toBe('new');
  });
  it('allows exactly one concurrent writer to an immutable attempt', async () => {
    await attempt('race', 5);
    const content = (value: string) => ({
      ...bundle,
      files: {
        'app/index.html': Buffer.from(value).toString('base64'),
        'app/main.js': Buffer.from(value).toString('base64'),
      },
    });
    const responses = await Promise.all([
      upload('race', content('first-writer')),
      upload('race', content('second-writer')),
    ]);
    expect(responses.some((response) => response.status === 200)).toBe(true);
    expect(responses.every((response) => [200, 409].includes(response.status))).toBe(true);
    const bucket = await mf.getR2Bucket('MOCKS');
    const html = await (await bucket.get('rubber-ducky/race/app/index.html'))!.text();
    expect(['first-writer', 'second-writer']).toContain(html);
    expect(await (await bucket.get('rubber-ducky/race/app/main.js'))!.text()).toBe(html);
    expect((await upload('race', content('late-overwrite'))).status).toBe(200);
    expect(await (await bucket.get('rubber-ducky/race/app/index.html'))!.text()).toBe(html);
  });
  it('serves session-scoped assets with enforced direct-navigation sandbox', async () => {
    const response = await request('/api/projects', { cookie: adminCookie });
    const entry = ((await response.json()) as any).projects[0].boards[0].frames[0].entry;
    const document = await request(entry, { origin: 'null' });
    expect(document.status).toBe(200);
    expect(document.headers.get('access-control-allow-origin')).toBe('*');
    expect(document.headers.get('content-security-policy')).toContain('sandbox allow-scripts;');
    expect(document.headers.get('content-security-policy')).not.toContain('allow-same-origin');
    expect(document.headers.get('cache-control')).toBe('no-store');
    const module = await request(entry.replace('index.html', 'main.js'), { origin: 'null' });
    expect(module.status).toBe(200);
    expect(module.headers.get('content-type')).toContain('text/javascript');
    expect(
      (await request(entry.replace(/\/mocks\/[a-f0-9]+\//, `/mocks/${'0'.repeat(64)}/`))).status,
    ).toBe(401);
    await request('/api/logout', { method: 'POST', origin, cookie: adminCookie, data: {} });
    expect((await request(entry)).status).toBe(401);
    const login = await request('/api/login', {
      method: 'POST',
      origin,
      data: { email: 'owner@example.com', password: 'a-long-test-password' },
    });
    adminCookie = login.headers.get('set-cookie')!.split(';')[0];
  });
  it('rotates publishing tokens without affecting existing content', async () => {
    const response = await admin('/api/admin/projects/rubber-ducky/token', 'POST', {});
    const token = ((await response.json()) as any).token;
    expect(
      (
        await request('/api/publish/rubber-ducky/attempts', {
          method: 'POST',
          token: projectToken,
          data: {},
        })
      ).status,
    ).toBe(403);
    projectToken = token;
    await attempt('rotated', 6);
  });
  it('does not let a late registration with an older source sequence become latest', async () => {
    await attempt('latest-source', 10);
    expect((await upload('latest-source')).status).toBe(200);
    await attempt('late-source', 9);
    expect((await upload('late-source')).status).toBe(409);
    const response = await request('/api/projects', { cookie: adminCookie });
    const project = ((await response.json()) as any).projects[0];
    expect(project.publication.id).toBe('latest-source');
    expect(project.activePublication.id).toBe('latest-source');
  });
  it('revokes an account session and its asset grants immediately on disablement', async () => {
    const login = await request('/api/login', {
      method: 'POST',
      origin,
      data: { email: 'viewer@example.com', password: 'viewer-long-password' },
    });
    const viewerCookie = login.headers.get('set-cookie')!.split(';')[0];
    const response = await request('/api/projects', { cookie: viewerCookie });
    const entry = ((await response.json()) as any).projects[0].boards[0].frames[0].entry;
    const users = await request('/api/admin/users', { cookie: adminCookie });
    const viewer = ((await users.json()) as any).users.find(
      (user: any) => user.email === 'viewer@example.com',
    );
    expect((await admin(`/api/admin/users/${viewer.id}`, 'PATCH', { disabled: true })).status).toBe(
      200,
    );
    expect((await request('/api/projects', { cookie: viewerCookie })).status).toBe(401);
    expect((await request(entry)).status).toBe(401);
    expect(
      (
        await request('/api/login', {
          method: 'POST',
          origin,
          data: { email: 'viewer@example.com', password: 'viewer-long-password' },
        })
      ).status,
    ).toBe(401);
  });
  it('handles the complete 20 MiB decoded-file boundary without changing the active set on excess input', async () => {
    const extended = { ...manifest, files: [...manifest.files, 'assets/large.bin'] };
    const htmlBytes = Buffer.from(bundle.files['app/index.html'], 'base64').length;
    const moduleBytes = Buffer.from(bundle.files['app/main.js'], 'base64').length;
    const large = Buffer.alloc(20 * 1024 * 1024 - htmlBytes - moduleBytes);
    await attempt('full-limit', 11);
    expect(
      (
        await upload('full-limit', {
          manifest: extended,
          files: { ...bundle.files, 'assets/large.bin': large.toString('base64') },
        })
      ).status,
    ).toBe(200);
    await attempt('excess-limit', 12);
    expect(
      (
        await upload('excess-limit', {
          manifest: extended,
          files: {
            ...bundle.files,
            'assets/large.bin': Buffer.concat([large, Buffer.from([1])]).toString('base64'),
          },
        })
      ).status,
    ).toBe(400);
    const response = await request('/api/projects', { cookie: adminCookie });
    expect(((await response.json()) as any).projects[0].activePublication.id).toBe('full-limit');
  }, 30000);
  it('rejects path traversal, unexpected files, invalid empty input, and incompatible schemas', () => {
    expect(() => validateManifest({ ...manifest, schemaVersion: 2 }, 'rubber-ducky')).toThrow(
      'schemaVersion',
    );
    expect(() =>
      validateManifest({ ...manifest, files: ['../secret.txt'] }, 'rubber-ducky'),
    ).toThrow('paths');
    expect(() => validateManifest({ ...manifest, boards: [] }, 'rubber-ducky')).toThrow('empty');
    expect(() =>
      validateManifest(
        { ...manifest, privateNotes: 'not part of the public contract' },
        'rubber-ducky',
      ),
    ).toThrow('Unknown');
    expect(() =>
      decodeBundle({ ...bundle, files: { ...bundle.files, 'secret.txt': 'YQ==' } }, 'rubber-ducky'),
    ).toThrow('exactly');
    expect(() =>
      decodeBundle(
        { ...bundle, files: { ...bundle.files, 'app/main.js': '!!!!' } },
        'rubber-ducky',
      ),
    ).toThrow('base64');
  });
  it('accepts optional listed raster previews and rejects executable or unlisted paths', () => {
    const withPreview = (preview: unknown) => ({
      ...manifest,
      files: [...manifest.files, 'preview.jpg', 'preview.svg'],
      boards: [{ ...manifest.boards[0], frames: [{ ...manifest.boards[0].frames[0], preview }] }],
    });
    expect(
      validateManifest(withPreview('preview.jpg'), 'rubber-ducky').boards[0].frames[0].preview,
    ).toBe('preview.jpg');
    for (const path of [
      'missing.png',
      'preview.svg',
      'app/index.html',
      '../preview.jpg',
      'https://example.com/preview.jpg',
      null,
    ])
      expect(() => validateManifest(withPreview(path), 'rubber-ducky')).toThrow('preview');
  });
  it('protects preview images with the same revocable grant as their frame', async () => {
    const imageBundle = structuredClone(bundle);
    Object.assign(imageBundle.manifest.boards[0].frames[0], { preview: 'preview.jpg' });
    imageBundle.manifest.files.push('preview.jpg');
    Object.assign(imageBundle.files, {
      'preview.jpg': Buffer.from('image fixture').toString('base64'),
    });
    await attempt('image-preview', 100);
    expect((await upload('image-preview', imageBundle)).status).toBe(200);
    const { projects } = (await (
      await request('/api/projects', { cookie: adminCookie })
    ).json()) as any;
    const frame = projects[0].boards[0].frames[0];
    expect(frame.preview.split('/').slice(0, 3)).toEqual(frame.entry.split('/').slice(0, 3));
    const response = await request(frame.preview);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('image fixture');
    expect((await request('/mocks/preview.jpg')).status).not.toBe(200);
    await request('/api/logout', { method: 'POST', origin, cookie: adminCookie, data: {} });
    expect((await request(frame.preview)).status).toBe(401);
  });
});
