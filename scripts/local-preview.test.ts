import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyMigrations, parseOptions, startPreview } from './local-preview.mjs';

const runtimes = vi.hoisted(() => ({ instances: [] as import('miniflare').Miniflare[] }));
vi.mock('miniflare', async (importOriginal) => {
  const actual = await importOriginal<typeof import('miniflare')>();
  return {
    ...actual,
    Miniflare: class extends actual.Miniflare {
      constructor(options: ConstructorParameters<typeof actual.Miniflare>[0]) {
        super(options);
        runtimes.instances.push(this);
      }
    },
  };
});

let temporary: string;
let alpha: string;
let beta: string;
let preview: { origin: string; close(): Promise<void> } | undefined;
const updates: string[] = [];

function manifest(id: string) {
  return {
    schemaVersion: 1,
    project: { id, name: id },
    boards: [
      {
        id: 'app',
        name: 'App',
        frames: [{ id: 'home', name: 'Home', entry: 'home.html', width: 390, height: 844 }],
      },
    ],
    files: ['home.html', 'style.css'],
  };
}

async function fixture(id: string, folder = id) {
  const directory = join(temporary, folder);
  await mkdir(directory);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest(id)));
  await writeFile(join(directory, 'home.html'), `<p>${id}:initial</p>`);
  await writeFile(join(directory, 'style.css'), 'p { color: teal; }');
  await writeFile(join(directory, 'unlisted.txt'), 'Unlisted source file');
  return directory;
}

async function projects() {
  const response = await fetch(`${preview!.origin}/api/projects`);
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toBeNull();
  return (await response.json()).projects;
}

async function project(id: string) {
  const found = (await projects()).find((project: { id: string }) => project.id === id);
  expect(found).toBeDefined();
  return found;
}

async function content(id: string) {
  const selected = await project(id);
  const response = await fetch(preview!.origin + selected.boards[0].frames[0].entry);
  expect(response.status).toBe(200);
  return response.text();
}

function withHost(host: string) {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      `${preview!.origin}/api/session`,
      { headers: { Host: host } },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode!));
      },
    );
    request.once('error', reject);
    request.end();
  });
}

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'mgm-local-preview-'));
  alpha = await fixture('alpha');
  beta = await fixture('beta');
  preview = await startPreview({
    directories: [alpha, beta],
    port: 0,
    interval: 25,
    onUpdate: (message: string) => updates.push(message),
  });
}, 30000);
afterAll(async () => {
  await preview?.close();
  await rm(temporary, { recursive: true, force: true });
});

describe('ephemeral local preview', () => {
  it('uses a hidden local session for read-only viewing without exposing account or publishing credentials', async () => {
    expect(new URL(preview!.origin).hostname).toBe('127.0.0.1');
    const response = await fetch(`${preview!.origin}/api/session`, {
      headers: { Cookie: 'mgm_session=untrusted-client-cookie' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    const session = await response.json();
    expect(session).toMatchObject({
      setupRequired: false,
      user: { role: 'viewer', email: 'preview@example.test' },
    });
    const visible = await projects();
    expect(visible.map((project: { id: string }) => project.id).sort()).toEqual(['alpha', 'beta']);
    expect(JSON.stringify({ session, visible })).not.toMatch(
      /password_hash|token_hash|mgm_session|setupSecret/,
    );
    await expect(content('alpha')).resolves.toBe('<p>alpha:initial</p>');
    await expect(content('beta')).resolves.toBe('<p>beta:initial</p>');
  });

  it('rejects hostile Host/Origin headers and all hosted administration or mutation requests', async () => {
    expect(await withHost('attacker.example')).toBe(403);
    expect(await withHost(`127.0.0.1.attacker.example:${new URL(preview!.origin).port}`)).toBe(403);
    for (const origin of ['https://attacker.example', 'null']) {
      expect(
        (await fetch(`${preview!.origin}/api/projects`, { headers: { Origin: origin } })).status,
      ).toBe(403);
    }
    expect((await fetch(`${preview!.origin}/api/admin/users`)).status).toBe(403);
    for (const [method, path] of [
      ['POST', '/api/logout'],
      ['POST', '/api/setup'],
      ['PUT', '/api/publish/alpha/attempts/anything'],
      ['DELETE', '/__local/version'],
    ]) {
      expect(
        (await fetch(preview!.origin + path, { method, headers: { Origin: preview!.origin } }))
          .status,
      ).toBe(403);
    }
    expect(
      (await fetch(`${preview!.origin}/api/session`, { headers: { Origin: preview!.origin } }))
        .status,
    ).toBe(200);
  });

  it('serves only published assets with the real preview CSP and scoped noncredentialed CORS', async () => {
    const entry = (await project('alpha')).boards[0].frames[0].entry;
    const document = await fetch(preview!.origin + entry, { headers: { Origin: 'null' } });
    expect(document.status).toBe(200);
    expect(document.headers.get('content-security-policy')).toContain('sandbox allow-scripts;');
    expect(document.headers.get('content-security-policy')).not.toContain('allow-same-origin');
    expect(document.headers.get('access-control-allow-origin')).toBe('*');
    expect(document.headers.get('access-control-allow-credentials')).toBeNull();
    expect(document.headers.get('set-cookie')).toBeNull();
    expect(
      (await fetch(preview!.origin + entry, { headers: { Origin: 'https://attacker.example' } }))
        .status,
    ).toBe(403);
    const style = await fetch(preview!.origin + entry.replace('home.html', 'style.css'), {
      headers: { Origin: 'null' },
    });
    expect(style.status).toBe(200);
    expect(style.headers.get('content-type')).toContain('text/css');
    expect((await fetch(preview!.origin + entry.replace('home.html', 'unlisted.txt'))).status).toBe(
      404,
    );
    expect((await fetch(preview!.origin + entry, { method: 'HEAD' })).status).toBe(200);
    expect(
      (await fetch(preview!.origin + entry, { method: 'OPTIONS', headers: { Origin: 'null' } }))
        .status,
    ).toBe(204);
  });

  it('refreshes edited files, preserves invalid updates, and recovers without affecting another directory', async () => {
    const initialAlpha = await project('alpha');
    const betaPublication = (await project('beta')).activePublication.id;
    const initialVersion = await (await fetch(`${preview!.origin}/__local/version`)).json();
    await writeFile(join(alpha, 'home.html'), '<p>alpha:updated</p>');
    await expect
      .poll(() => content('alpha'), { timeout: 5000, interval: 25 })
      .toBe('<p>alpha:updated</p>');
    const successfulAlpha = (await project('alpha')).activePublication.id;
    expect((await project('beta')).activePublication.id).toBe(betaPublication);
    const newVersion = await (await fetch(`${preview!.origin}/__local/version`)).json();
    expect(newVersion.revision).toBeGreaterThan(initialVersion.revision);
    const messagesBeforeError = updates.length;
    await writeFile(join(alpha, 'manifest.json'), '{ invalid JSON');
    await expect
      .poll(
        () =>
          updates
            .slice(messagesBeforeError)
            .some((message) => message.includes('Cannot update alpha')),
        { timeout: 5000, interval: 25 },
      )
      .toBe(true);
    await writeFile(join(beta, 'home.html'), '<p>beta:independent update</p>');
    await expect
      .poll(() => content('beta'), { timeout: 5000, interval: 25 })
      .toBe('<p>beta:independent update</p>');
    expect((await project('alpha')).activePublication.id).toBe(successfulAlpha);
    await expect(content('alpha')).resolves.toBe('<p>alpha:updated</p>');
    await writeFile(join(alpha, 'home.html'), '<p>alpha:recovered</p>');
    await writeFile(join(alpha, 'manifest.json'), JSON.stringify(manifest('alpha')));
    await expect
      .poll(() => content('alpha'), { timeout: 5000, interval: 25 })
      .toBe('<p>alpha:recovered</p>');
    await expect(content('beta')).resolves.toBe('<p>beta:independent update</p>');
    const oldGrant = await fetch(preview!.origin + initialAlpha.boards[0].frames[0].entry);
    expect(await oldGrant.text()).toBe('<p>alpha:initial</p>');
    const refresh = await fetch(`${preview!.origin}/__local/refresh.js`);
    expect(refresh.headers.get('set-cookie')).toBeNull();
    expect(await refresh.text()).toContain('location.reload()');
  });

  it('rejects source identity changes and duplicate project directories', async () => {
    const messagesBeforeError = updates.length;
    const active = (await project('alpha')).activePublication.id;
    await writeFile(join(alpha, 'manifest.json'), JSON.stringify(manifest('renamed-project')));
    await expect
      .poll(
        () =>
          updates
            .slice(messagesBeforeError)
            .some((message) => message.includes('Cannot update alpha')),
        { timeout: 5000, interval: 25 },
      )
      .toBe(true);
    expect((await project('alpha')).activePublication.id).toBe(active);
    expect(
      (await projects()).some((project: { id: string }) => project.id === 'renamed-project'),
    ).toBe(false);
    await writeFile(join(alpha, 'manifest.json'), JSON.stringify(manifest('alpha')));
    const duplicate = await fixture('alpha', 'duplicate-alpha');
    await expect(
      startPreview({ directories: [alpha, duplicate], port: 0, onUpdate: () => {} }),
    ).rejects.toThrow('different project id');
  });

  it('parses explicit loopback ports and rejects unsupported or duplicate options', () => {
    expect(parseOptions(['--directory', 'design', '--port', '8791'])).toEqual({
      directories: [resolve('design')],
      port: 8791,
    });
    for (const args of [
      [],
      ['--directory'],
      ['--directory', 'design', '--host', '0.0.0.0'],
      ['--directory', 'design', '--directory', 'design'],
      ['--directory', 'design', '--port', '80'],
      ['--directory', 'design', '--port', '70000'],
      ['--directory', 'design', '--port', '8790', '--port', '8791'],
    ])
      expect(() => parseOptions(args)).toThrow('Usage:');
  });

  it('loads all numbered migrations in filename order', async () => {
    const migrations = join(temporary, 'migrations');
    await mkdir(migrations);
    await writeFile(
      join(migrations, '0002_add_name.sql'),
      'ALTER TABLE sample ADD COLUMN name TEXT;',
    );
    await writeFile(join(migrations, '0001_create.sql'), 'CREATE TABLE sample (id TEXT);');
    await writeFile(join(migrations, 'README.md'), 'Not a migration');
    const calls: string[][] = [];
    await applyMigrations(
      {
        prepare: (sql: string) => sql,
        batch: vi.fn(async (statements: string[]) => calls.push(statements)),
      },
      migrations,
    );
    expect(calls).toEqual([
      ['CREATE TABLE sample (id TEXT)'],
      ['ALTER TABLE sample ADD COLUMN name TEXT'],
    ]);
  });

  it('includes source edits made during Worker initialization in the first published set', async () => {
    const first = await fixture('startup-first');
    const second = await fixture('startup-second');
    const started = await startPreview({
      directories: [first, second],
      port: 0,
      interval: 60000,
      onUpdate(message: string) {
        if (message.startsWith('Updated startup-first '))
          writeFileSync(join(second, 'home.html'), '<p>Edited during startup</p>');
      },
    });
    try {
      const response = await fetch(`${started.origin}/api/projects`);
      const { projects } = await response.json();
      const entry = projects.find((project: { id: string }) => project.id === 'startup-second')
        .boards[0].frames[0].entry;
      expect(await (await fetch(started.origin + entry)).text()).toBe(
        '<p>Edited during startup</p>',
      );
    } finally {
      await started.close();
    }
  });

  it('retries a transient publication failure without requiring another source edit', async () => {
    const directory = await fixture('retry-preview');
    const started = await startPreview({
      directories: [directory],
      port: 0,
      interval: 25,
      onUpdate: () => {},
    });
    const runtime = runtimes.instances.at(-1)!;
    const original = runtime.dispatchFetch;
    let failedOnce = false;
    let activeAtFailure: string | undefined;
    const dispatch = vi
      .spyOn(runtime, 'dispatchFetch')
      .mockImplementation(async function (input, init) {
        if (
          !failedOnce &&
          init?.method === 'PUT' &&
          String(input).includes('/api/publish/retry-preview/attempts/')
        ) {
          failedOnce = true;
          const { projects } = await (await fetch(`${started.origin}/api/projects`)).json();
          const entry = projects[0].boards[0].frames[0].entry;
          activeAtFailure = await (await fetch(started.origin + entry)).text();
          return new Response('{}', { status: 503 }) as Awaited<ReturnType<typeof original>>;
        }
        return original.call(this, input, init);
      });
    try {
      await writeFile(join(directory, 'home.html'), '<p>Recovered without a second edit</p>');
      await expect
        .poll(
          async () => {
            const { projects } = await (await fetch(`${started.origin}/api/projects`)).json();
            return (await fetch(started.origin + projects[0].boards[0].frames[0].entry)).text();
          },
          { timeout: 5000, interval: 25 },
        )
        .toBe('<p>Recovered without a second edit</p>');
      expect(failedOnce).toBe(true);
      expect(activeAtFailure).toBe('<p>retry-preview:initial</p>');
    } finally {
      dispatch.mockRestore();
      await started.close();
    }
  });

  it('closes the listener and destroys access to its ephemeral site', async () => {
    const origin = preview!.origin;
    await preview!.close();
    preview = undefined;
    await expect(fetch(`${origin}/api/session`)).rejects.toThrow();
  });
});
