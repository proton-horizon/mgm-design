import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const origin = 'https://publication.example.com';
let mf: Miniflare;
let cookie: string;
const writeControls = new Map<string, () => Promise<Response>>();

interface ProjectView {
  id: string;
  publication: { id: string; status: string };
  activePublication: { id: string; status: string };
  boards: { frames: { entry: string }[] }[];
}

function pauseWrite(key: string) {
  let entered!: () => void;
  let release!: (success: boolean) => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resumed = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  writeControls.set(key, async () => {
    entered();
    return new Response(null, { status: (await resumed) ? 204 : 503 });
  });
  return { reached, release };
}

async function atWrite(gate: ReturnType<typeof pauseWrite>, upload: Promise<Response>) {
  await Promise.race([
    gate.reached,
    upload.then((response) => {
      throw new Error(`Upload finished before reaching its storage barrier (${response.status}).`);
    }),
  ]);
}

async function request(path: string, method = 'GET', data?: unknown, token?: string) {
  const headers: Record<string, string> = { Origin: origin };
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  return mf.dispatchFetch(origin + path, {
    method,
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

function bundle(project: string, label: string) {
  return {
    manifest: {
      schemaVersion: 1,
      project: { id: project, name: project },
      boards: [
        {
          id: 'app',
          name: 'App',
          frames: [{ id: 'home', name: 'Home', entry: 'app/index.html', width: 390, height: 844 }],
        },
      ],
      files: ['app/index.html', 'app/main.js'],
    },
    files: {
      'app/index.html': Buffer.from(`<!doctype html><p>${label}</p>`).toString('base64'),
      'app/main.js': Buffer.from(`window.fixture = ${JSON.stringify(label)};`).toString('base64'),
    },
  };
}

async function register(project: string, token: string, attempt: string, sequence: number) {
  expect(
    (await request(`/api/publish/${project}/attempts`, 'POST', { id: attempt, sequence }, token))
      .status,
  ).toBe(201);
}

function upload(project: string, token: string, attempt: string, label: string) {
  return request(
    `/api/publish/${project}/attempts/${attempt}`,
    'PUT',
    bundle(project, label),
    token,
  );
}

async function projectView(id: string) {
  const response = await request('/api/projects');
  expect(response.status).toBe(200);
  const { projects } = (await response.json()) as { projects: ProjectView[] };
  const project = projects.find((project) => project.id === id);
  expect(project).toBeDefined();
  return project!;
}

async function createProject(id: string) {
  const created = await request('/api/admin/projects', 'POST', { id, name: id });
  expect(created.status).toBe(201);
  const { token } = (await created.json()) as { token: string };
  await register(id, token, `${id}-initial`, 1);
  expect((await upload(id, token, `${id}-initial`, `${id}:initial`)).status).toBe(200);
  return { id, token, initial: await projectView(id) };
}

async function expectPreview(project: ProjectView, label: string) {
  const entry = project.boards[0].frames[0].entry;
  const html = await request(entry);
  expect(html.status).toBe(200);
  expect(await html.text()).toBe(`<!doctype html><p>${label}</p>`);
  const script = await request(entry.replace('index.html', 'main.js'));
  expect(script.status).toBe(200);
  expect(await script.text()).toBe(`window.fixture = ${JSON.stringify(label)};`);
}

beforeAll(async () => {
  const built = await build({
    entryPoints: ['tests/backend/publication-worker.ts'],
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
        name: 'publication-integrity',
        modules: true,
        script: built.outputFiles[0].text,
        compatibilityDate: '2026-07-01',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        r2Buckets: ['MOCKS'],
        bindings: { SETUP_SECRET: 'publication-test-setup-secret' },
        serviceBindings: {
          ASSETS: () => new Response('viewer'),
          WRITE_CONTROL: async (request) => {
            const { key } = (await request.json()) as { key: string };
            return writeControls.get(key)?.() ?? new Response(null, { status: 204 });
          },
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
  const setup = await request('/api/setup', 'POST', {
    email: 'owner@example.com',
    name: 'Owner',
    password: 'publication-test-password',
    setupSecret: 'publication-test-setup-secret',
  });
  expect(setup.status).toBe(200);
  cookie = setup.headers.get('set-cookie')!.split(';')[0];
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

describe('publication integrity under storage interruptions', () => {
  it('preserves the complete active snapshot after a real partial R2 write, timeout and failed retry', async () => {
    const { id, token, initial } = await createProject('interrupted');
    const attempt = `${id}-partial`;
    await register(id, token, attempt, 2);
    const gate = pauseWrite(`${id}/${attempt}/app/main.js`);
    const pending = upload(id, token, attempt, `${id}:partial`);
    try {
      await atWrite(gate, pending);
      const bucket = await mf.getR2Bucket('MOCKS');
      expect(await (await bucket.get(`${id}/${attempt}/app/index.html`))!.text()).toContain(
        `${id}:partial`,
      );
      expect(await bucket.get(`${id}/${attempt}/app/main.js`)).toBeNull();
      const during = await projectView(id);
      expect(during.publication).toMatchObject({ id: attempt, status: 'uploading' });
      expect(during.activePublication.id).toBe(`${id}-initial`);
      await expectPreview(during, `${id}:initial`);
    } finally {
      gate.release(false);
    }
    const failed = await pending;
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      error: 'The request could not be completed. Please try again.',
    });
    expect((await upload(id, token, attempt, `${id}:retry`)).status).toBe(409);
    const db = await mf.getD1Database('DB');
    await db
      .prepare('UPDATE attempts SET updated_at=? WHERE id=?')
      .bind(new Date(Date.now() - 31 * 60000).toISOString(), attempt)
      .run();
    expect((await projectView(id)).publication).toMatchObject({ id: attempt, status: 'unknown' });
    expect(
      (
        await request(
          `/api/publish/${id}/attempts/${attempt}/failure`,
          'POST',
          { message: 'Source workflow received an upload error.' },
          token,
        )
      ).status,
    ).toBe(200);
    const reported = await projectView(id);
    expect(reported.publication.status).toBe('failed');
    expect(reported.activePublication.id).toBe(`${id}-initial`);
    await expectPreview(initial, `${id}:initial`);
    await register(id, token, `${id}-recovered`, 3);
    expect((await upload(id, token, `${id}-recovered`, `${id}:recovered`)).status).toBe(200);
    await expectPreview(await projectView(id), `${id}:recovered`);
    await expectPreview(initial, `${id}:initial`);
  });

  it.each(['succeeds', 'fails'] as const)(
    'keeps simultaneous projects independent when the delayed upload %s',
    async (outcome) => {
      const succeeds = outcome === 'succeeds';
      const left = await createProject(`parallel-${outcome}-left`);
      const right = await createProject(`parallel-${outcome}-right`);
      const leftAttempt = `${left.id}-next`;
      const rightAttempt = `${right.id}-next`;
      await Promise.all([
        register(left.id, left.token, leftAttempt, 2),
        register(right.id, right.token, rightAttempt, 2),
      ]);
      const leftGate = pauseWrite(`${left.id}/${leftAttempt}/app/main.js`);
      const rightGate = pauseWrite(`${right.id}/${rightAttempt}/app/main.js`);
      const leftPending = upload(left.id, left.token, leftAttempt, 'left:new');
      const rightPending = upload(right.id, right.token, rightAttempt, 'right:new');
      try {
        await Promise.all([atWrite(leftGate, leftPending), atWrite(rightGate, rightPending)]);
        await expectPreview(await projectView(left.id), `${left.id}:initial`);
        await expectPreview(await projectView(right.id), `${right.id}:initial`);
        rightGate.release(true);
        expect((await rightPending).status).toBe(200);
        const rightPublished = await projectView(right.id);
        expect(rightPublished.publication).toMatchObject({ id: rightAttempt, status: 'published' });
        await expectPreview(rightPublished, 'right:new');
        const leftUnfinished = await projectView(left.id);
        expect(leftUnfinished.publication).toMatchObject({ id: leftAttempt, status: 'uploading' });
        expect(leftUnfinished.activePublication.id).toBe(`${left.id}-initial`);
      } finally {
        leftGate.release(succeeds);
        rightGate.release(true);
      }
      expect((await leftPending).status).toBe(succeeds ? 200 : 500);
      if (!succeeds)
        expect(
          (
            await request(
              `/api/publish/${left.id}/attempts/${leftAttempt}/failure`,
              'POST',
              {},
              left.token,
            )
          ).status,
        ).toBe(200);
      expect((await projectView(left.id)).publication.status).toBe(
        succeeds ? 'published' : 'failed',
      );
      expect((await projectView(right.id)).publication).toMatchObject({
        id: rightAttempt,
        status: 'published',
      });
      await expectPreview(await projectView(left.id), succeeds ? 'left:new' : `${left.id}:initial`);
      await expectPreview(await projectView(right.id), 'right:new');
      expect(
        (
          await request(
            `/api/publish/${right.id}/attempts/${rightAttempt}/failure`,
            'POST',
            {},
            left.token,
          )
        ).status,
      ).toBe(403);
    },
  );

  it('cannot activate an older upload that finishes its R2 writes after a newer publication', async () => {
    const { id, token, initial } = await createProject('superseded-upload');
    const older = `${id}-older`;
    const newer = `${id}-newer`;
    await register(id, token, older, 2);
    const gate = pauseWrite(`${id}/${older}/app/main.js`);
    const pending = upload(id, token, older, 'older upload');
    try {
      await atWrite(gate, pending);
      await register(id, token, newer, 3);
      expect((await upload(id, token, newer, 'newer upload')).status).toBe(200);
      await expectPreview(await projectView(id), 'newer upload');
    } finally {
      gate.release(true);
    }
    const late = await pending;
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({
      ok: false,
      publicationId: older,
      status: 'superseded',
    });
    const active = await projectView(id);
    expect(active.publication.id).toBe(newer);
    expect(active.activePublication.id).toBe(newer);
    await expectPreview(active, 'newer upload');
    await expectPreview(initial, `${id}:initial`);
  });
});
