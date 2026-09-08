#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, stat, realpath, readdir } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { contentType } from '../worker/bundle.mjs';
import { readBundle } from './read-bundle.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage =
  'Usage: node scripts/local-preview.mjs --directory <app/design> [--directory <another/design>] [--port 8790]';

/** Parses caller-relative source directories. Listening is always restricted to 127.0.0.1; no remote, persisted-account or hosting configuration is accepted. */
export function parseOptions(args) {
  const directories = [];
  let port = 8790;
  let hasPort = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--directory' && args[i + 1] && !args[i + 1].startsWith('--'))
      directories.push(resolve(args[++i]));
    else if (args[i] === '--port' && !hasPort && /^\d+$/.test(args[i + 1] ?? '')) {
      port = Number(args[++i]);
      hasPort = true;
      if (port < 1024 || port > 65535) throw new Error(usage);
    } else throw new Error(usage);
  }
  if (!directories.length || new Set(directories).size !== directories.length)
    throw new Error(usage);
  return { directories, port };
}

/** Applies every numbered SQL migration in filename order to the fresh local database. */
export async function applyMigrations(db, directory = resolve(root, 'migrations')) {
  const names = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  if (!names.length) throw new Error('No numbered database migrations were found.');
  for (const name of names) {
    const migration = await readFile(resolve(directory, name), 'utf8');
    const statements = migration
      .split(';')
      .map((sql) => sql.trim())
      .filter(Boolean);
    if (statements.length) await db.batch(statements.map((sql) => db.prepare(sql)));
  }
}

/** Starts an ephemeral local Worker with real publication and preview isolation. The loopback-only proxy supplies a private session for read-only viewing; no login bypass is compiled into the deployed Worker. close() stops polling and disposes all local data. */
export async function startPreview({
  directories,
  port = 8790,
  interval = 1000,
  onUpdate = console.log,
}) {
  const sourceDirectories = await Promise.all(directories.map((path) => realpath(path)));
  const initial = await Promise.all(sourceDirectories.map((path) => readBundle(path)));
  if (new Set(initial.map((bundle) => bundle.manifest.project.id)).size !== initial.length)
    throw new Error('Each source directory must have a different project id.');
  const output = await build({
    entryPoints: [resolve(root, 'worker/index.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: ['node:crypto'],
  });
  const setupSecret = randomBytes(32).toString('hex');
  const mf = new Miniflare({
    host: '127.0.0.1',
    port: 0,
    modules: true,
    script: output.outputFiles[0].text,
    compatibilityDate: '2026-07-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    r2Buckets: ['MOCKS'],
    bindings: { SETUP_SECRET: setupSecret, SITE_NAME: 'MGM Design · Local' },
    serviceBindings: {
      ASSETS: async (request) => {
        const pathname = decodeURIComponent(new URL(request.url).pathname);
        let path = resolve(root, 'dist', '.' + pathname);
        if (!path.startsWith(resolve(root, 'dist') + sep)) path = resolve(root, 'dist/index.html');
        try {
          if (!(await stat(path)).isFile()) throw new Error();
        } catch {
          path = resolve(root, 'dist/index.html');
        }
        return new Response(await readFile(path), {
          headers: { 'Content-Type': contentType(path) ?? 'application/octet-stream' },
        });
      },
    },
  });
  let timer,
    inFlight,
    closed = false,
    revision = 0,
    cookie = '',
    origin;
  const states = new Map();
  const reply = (response, status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (incoming.headers.host !== new URL(origin).host)
        return reply(outgoing, 403, { error: 'Local preview requires its loopback hostname.' });
      const url = new URL(incoming.url, origin);
      const mock = url.pathname.startsWith('/mocks/');
      const requestOrigin = incoming.headers.origin;
      if (requestOrigin && requestOrigin !== origin && !(mock && requestOrigin === 'null'))
        return reply(outgoing, 403, { error: 'Cross-origin local access is not allowed.' });
      if (!['GET', 'HEAD', 'OPTIONS'].includes(incoming.method))
        return reply(outgoing, 403, {
          error: 'Local preview is read-only. Stop the command to close it.',
        });
      if (url.pathname === '/__local/version') return reply(outgoing, 200, { revision });
      if (url.pathname === '/__local/refresh.js') {
        outgoing.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
        outgoing.end(
          `let version=${revision};setInterval(async()=>{try{const r=await fetch('/__local/version');const d=await r.json();if(d.revision!==version)location.reload()}catch{}},1000);`,
        );
        return;
      }
      if (
        url.pathname.startsWith('/api/') &&
        !['/api/session', '/api/projects'].includes(url.pathname)
      )
        return reply(outgoing, 403, { error: 'Local preview is read-only.' });
      const headers = new Headers();
      if (url.pathname.startsWith('/api/')) headers.set('Cookie', cookie);
      if (requestOrigin) headers.set('Origin', requestOrigin);
      const response = await mf.dispatchFetch(url.href, { method: incoming.method, headers });
      const responseHeaders = Object.fromEntries(response.headers);
      delete responseHeaders['set-cookie'];
      delete responseHeaders['content-length'];
      let body;
      if (url.pathname === '/api/session') {
        const session = await response.json();
        if (session.user) session.user.role = 'viewer';
        body = JSON.stringify(session);
      } else if (!mock && response.headers.get('content-type')?.includes('text/html'))
        body = (await response.text()).replace(
          '</body>',
          '<script src="/__local/refresh.js"></script></body>',
        );
      else body = Buffer.from(await response.arrayBuffer());
      outgoing.writeHead(response.status, responseHeaders);
      outgoing.end(incoming.method === 'HEAD' ? undefined : body);
    } catch {
      if (!outgoing.headersSent) reply(outgoing, 500, { error: 'Local preview request failed.' });
      else outgoing.end();
    }
  });
  async function send(path, method, data, token) {
    const response = await mf.dispatchFetch(origin + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: cookie }),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    if (!response.ok) throw new Error(`Local ${method} request failed (${response.status}).`);
    return response;
  }
  async function publish(directory, state, bundle) {
    const base = `/api/publish/${state.id}/attempts`;
    const { attemptId } = await (
      await send(base, 'POST', { id: randomUUID() }, state.token)
    ).json();
    try {
      await send(`${base}/${attemptId}`, 'PUT', bundle, state.token);
    } catch (error) {
      await send(`${base}/${attemptId}/failure`, 'POST', {}, state.token).catch(() => {});
      throw error;
    }
    revision++;
    onUpdate(`Updated ${state.id} from ${directory}.`);
  }
  async function fingerprint(directory) {
    const manifest = await readFile(resolve(directory, 'manifest.json'));
    const input = JSON.parse(manifest);
    const hash = createHash('sha256').update(manifest);
    // Reading/validation still happens through readBundle before publication.
    for (const file of Array.isArray(input.files) ? input.files : []) {
      if (typeof file !== 'string') continue;
      const path = resolve(directory, file);
      if (!path.startsWith(directory + sep)) continue;
      try {
        const info = await stat(path);
        hash.update(`${file}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`);
      } catch {
        hash.update(`${file}:missing`);
      }
    }
    return hash.digest('hex');
  }
  async function scan() {
    for (const [directory, state] of states) {
      try {
        const next = await fingerprint(directory);
        if (next === state.fingerprint) {
          state.error = false;
          continue;
        }
        const bundle = await readBundle(directory, state.id);
        await publish(directory, state, bundle);
        state.fingerprint = next;
        state.error = false;
      } catch {
        if (!state.error)
          onUpdate(
            `Cannot update ${state.id}; fix its manifest/files. Previous designs remain active.`,
          );
        state.error = true;
      }
    }
  }
  const close = async () => {
    closed = true;
    clearInterval(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await inFlight;
    await mf.dispose();
  };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    const db = await mf.getD1Database('DB');
    await applyMigrations(db);
    const setup = await send('/api/setup', 'POST', {
      email: 'preview@example.test',
      name: 'Local preview',
      password: randomBytes(32).toString('hex'),
      setupSecret,
    });
    cookie = setup.headers.get('set-cookie').split(';')[0];
    for (let i = 0; i < sourceDirectories.length; i++) {
      const directory = sourceDirectories[i],
        project = initial[i].manifest.project;
      const { token } = await (await send('/api/admin/projects', 'POST', project)).json();
      const fingerprintBeforeRead = await fingerprint(directory);
      const bundle = await readBundle(directory, project.id);
      const state = { id: project.id, token, fingerprint: fingerprintBeforeRead };
      states.set(directory, state);
      await publish(directory, state, bundle);
    }
    timer = setInterval(() => {
      if (inFlight || closed) return;
      inFlight = scan().finally(() => {
        inFlight = undefined;
      });
    }, interval);
    return { origin, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length || (args.length === 1 && args[0] === '--help')) console.log(usage);
  else {
    try {
      const preview = await startPreview(parseOptions(args));
      console.log(`Local preview: ${preview.origin} (temporary data; no sign-in required).`);
      for (const signal of ['SIGINT', 'SIGTERM'])
        process.once(signal, async () => {
          await preview.close();
          process.exit(0);
        });
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
