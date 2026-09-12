import { contentType, decodeBundle, safePath, type Manifest } from './bundle.mjs';
import { passwordHasher, DUMMY_PASSWORD_HASH, PasswordCompatibilityError } from './passwords';

export interface Env {
  DB: D1Database;
  MOCKS: R2Bucket;
  ASSETS: Fetcher;
  SETUP_SECRET: string;
  SITE_NAME?: string;
  BUILD_COMMIT?: string;
}
interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'viewer';
  disabled: number;
  password_hash: string;
}
interface Session {
  hash: string;
  user: User;
}
interface Project {
  id: string;
  name: string;
  description: string;
  active_publication: string | null;
  latest_attempt: string | null;
  token_hash: string;
}
interface Attempt {
  id: string;
  project_id: string;
  sequence: number;
  status: string;
  created_at: string;
  updated_at: string;
  source_commit: string | null;
  source_ref: string | null;
  run_url: string | null;
  message: string | null;
  manifest: string | null;
}
/** Storage boundary for parameterized persistence; Cloudflare D1 supplies transactional batch execution. */
export interface MutationResult {
  changes: number;
}
export interface Store {
  one<T>(sql: string, ...args: unknown[]): Promise<T | null>;
  all<T>(sql: string, ...args: unknown[]): Promise<T[]>;
  run(sql: string, ...args: unknown[]): Promise<MutationResult>;
  batch(statements: [string, unknown[]][]): Promise<MutationResult[]>;
}
export class D1Store implements Store {
  constructor(private db: D1Database) {}
  one<T>(sql: string, ...args: unknown[]) {
    return this.db
      .prepare(sql)
      .bind(...args)
      .first<T>();
  }
  async all<T>(sql: string, ...args: unknown[]) {
    return (
      await this.db
        .prepare(sql)
        .bind(...args)
        .all<T>()
    ).results;
  }
  async run(sql: string, ...args: unknown[]) {
    const result = await this.db
      .prepare(sql)
      .bind(...args)
      .run();
    return { changes: result.meta.changes };
  }
  async batch(statements: [string, unknown[]][]) {
    const results = await this.db.batch(
      statements.map(([sql, args]) => this.db.prepare(sql).bind(...args)),
    );
    return results.map((result) => ({ changes: result.meta.changes }));
  }
}
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const encoder = new TextEncoder();
const now = () => Date.now();
const iso = () => new Date().toISOString();
const random = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) =>
    x.toString(16).padStart(2, '0'),
  ).join('');
async function hash(value: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))),
    (x) => x.toString(16).padStart(2, '0'),
  ).join('');
}
function equal(a: string, b: string) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...headers,
    },
  });
}
function publicUser(user: User) {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}
function requireText(value: unknown, label: string, max = 100): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new HttpError(400, `Invalid ${label}.`);
  return value.trim();
}
function email(value: unknown) {
  const result = requireText(value, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new HttpError(400, 'Invalid email.');
  return result;
}
function password(value: unknown) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256)
    throw new HttpError(400, 'Password must contain 12–256 characters.');
  return value;
}
function projectId(value: unknown) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value))
    throw new HttpError(
      400,
      'Project id must use lowercase letters, numbers, underscores or hyphens.',
    );
  return value;
}
async function body(request: Request, max = 65536): Promise<Record<string, any>> {
  if (!request.headers.get('content-type')?.includes('application/json'))
    throw new HttpError(415, 'Send application/json.');
  if (Number(request.headers.get('content-length')) > max)
    throw new HttpError(413, 'Request too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Missing body.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new HttpError(413, 'Request too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}
function sameOrigin(request: Request) {
  if (request.headers.get('origin') !== new URL(request.url).origin)
    throw new HttpError(403, 'Same-origin request required.');
}
function cookie(request: Request, value: string, clear = false) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `mgm_session=${value}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${clear ? 0 : 604800}`;
}
async function session(request: Request, db: Store): Promise<Session | null> {
  const token = request.headers
    .get('cookie')
    ?.match(/(?:^|;\s*)mgm_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!token) return null;
  const tokenHash = await hash(token);
  const user = await db.one<User>(
    'SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.hash=? AND s.expires_at>? AND u.disabled=0',
    tokenHash,
    now(),
  );
  return user ? { hash: tokenHash, user } : null;
}
async function requireSession(request: Request, db: Store, admin = false) {
  const value = await session(request, db);
  if (!value) throw new HttpError(401, 'Sign in to continue.');
  if (admin && value.user.role !== 'admin') throw new HttpError(403, 'Site admin access required.');
  return value;
}
async function loginResponse(request: Request, db: Store, user: User) {
  const token = random();
  // A concurrent password reset or account disablement must win over an in-flight login.
  const result = await db.run(
    'INSERT INTO sessions(hash,user_id,expires_at) SELECT ?,id,? FROM users WHERE id=? AND password_hash=? AND disabled=0',
    await hash(token),
    now() + 604800000,
    user.id,
    user.password_hash,
  );
  if (!result.changes) throw new HttpError(401, 'Account credentials changed. Sign in again.');
  return json({ user: publicUser(user) }, 200, { 'Set-Cookie': cookie(request, token) });
}
async function throttle(request: Request, db: Store, scope: string, limit: number) {
  const key = await hash(`${scope}:${request.headers.get('CF-Connecting-IP') || 'local'}`);
  const time = now();
  await db.run(
    'INSERT INTO login_limits(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<? THEN 1 ELSE count+1 END, reset_at=CASE WHEN reset_at<? THEN excluded.reset_at ELSE reset_at END',
    key,
    time + 900000,
    time,
    time,
  );
  const result = await db.one<{ count: number }>('SELECT count FROM login_limits WHERE key=?', key);
  if ((result?.count || 0) > limit)
    throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
}
async function publishProject(request: Request, db: Store, id: string) {
  const token = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) throw new HttpError(401, 'Publishing credential required.');
  const project = await db.one<Project>(
    'SELECT * FROM projects WHERE id=? AND token_hash=?',
    id,
    await hash(token),
  );
  if (!project) throw new HttpError(403, 'Invalid project publishing credential.');
  return project;
}
function sourceText(value: unknown, max = 200) {
  return value === undefined ? null : requireText(value, 'source metadata', max);
}
function runUrl(value: unknown) {
  if (value === undefined) return null;
  const text = requireText(value, 'run URL', 500);
  try {
    const url = new URL(text);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hostname !== 'github.com' ||
      !/^\/[^/]+\/[^/]+\/actions\/runs\/\d+(?:\/attempts\/\d+)?$/.test(url.pathname) ||
      url.search ||
      url.hash
    )
      throw new Error();
    return text;
  } catch {
    throw new HttpError(400, 'Run URL must link directly to a GitHub Actions run.');
  }
}
function publication(attempt: Attempt | null) {
  if (!attempt) return undefined;
  const timedOut =
    ['pending', 'uploading'].includes(attempt.status) &&
    Date.parse(attempt.updated_at) < now() - 1800000;
  return {
    id: attempt.id,
    status: timedOut ? 'unknown' : attempt.status,
    createdAt: attempt.created_at,
    commit: attempt.source_commit,
    runUrl: attempt.run_url,
    message: timedOut
      ? 'No completion report received. Check the source workflow.'
      : attempt.message,
  };
}

async function api(request: Request, env: Env, db: Store, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;
  if (path === '/api/session' && method === 'GET') {
    const current = await session(request, db);
    const setup = await db.one('SELECT value FROM settings WHERE key=?', 'bootstrap');
    return json({
      user: current ? publicUser(current.user) : null,
      setupRequired: !setup,
      siteName: env.SITE_NAME || 'MGM Design',
      buildCommit: env.BUILD_COMMIT || null,
    });
  }
  if (path === '/api/setup' && method === 'POST') {
    sameOrigin(request);
    await throttle(request, db, 'setup', 10);
    const input = await body(request);
    if (await db.one('SELECT value FROM settings WHERE key=?', 'bootstrap'))
      throw new HttpError(409, 'Setup is already complete.');
    if (
      !env.SETUP_SECRET ||
      typeof input.setupSecret !== 'string' ||
      !equal(await hash(input.setupSecret), await hash(env.SETUP_SECRET))
    )
      throw new HttpError(403, 'Invalid setup secret.');
    const userId = crypto.randomUUID();
    const userEmail = email(input.email);
    const userName = requireText(input.name, 'name');
    const digest = await passwordHasher.hash(password(input.password));
    await db.batch([
      [
        'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING',
        ['bootstrap', userId],
      ],
      [
        'INSERT INTO users(id,email,name,role,password_hash,created_at) SELECT ?,?,?,?,?,? WHERE (SELECT value FROM settings WHERE key=?)=?',
        [userId, userEmail, userName, 'admin', digest, iso(), 'bootstrap', userId],
      ],
    ]);
    const user = await db.one<User>('SELECT * FROM users WHERE id=?', userId);
    if (!user) throw new HttpError(409, 'Setup is already complete.');
    return loginResponse(request, db, user);
  }
  if (path === '/api/login' && method === 'POST') {
    sameOrigin(request);
    await throttle(request, db, 'login', 30);
    const input = await body(request);
    const userEmail = email(input.email);
    await throttle(request, db, `account:${await hash(userEmail)}`, 10);
    const user = await db.one<User>('SELECT * FROM users WHERE email=?', userEmail);
    const candidate =
      typeof input.password === 'string' && input.password.length <= 256 ? input.password : '';
    let verification;
    try {
      verification = await passwordHasher.verify(
        candidate,
        user?.password_hash ?? DUMMY_PASSWORD_HASH,
      );
    } catch (error) {
      if (!(error instanceof PasswordCompatibilityError)) throw error;
      console.warn('Stored password requires an administrator reset on this runtime');
      await passwordHasher.verify(candidate, DUMMY_PASSWORD_HASH);
      throw new HttpError(401, 'Email or password is incorrect.');
    }
    if (!user || user.disabled || !verification.valid)
      throw new HttpError(401, 'Email or password is incorrect.');
    if (verification.needsRehash) {
      const upgraded = await passwordHasher.hash(candidate);
      const result = await db.run(
        'UPDATE users SET password_hash=? WHERE id=? AND password_hash=? AND disabled=0',
        upgraded,
        user.id,
        user.password_hash,
      );
      if (!result.changes) throw new HttpError(401, 'Credentials changed. Please sign in again.');
      user.password_hash = upgraded;
    }
    return loginResponse(request, db, user);
  }
  if (path === '/api/logout' && method === 'POST') {
    sameOrigin(request);
    const current = await session(request, db);
    if (current) await db.run('DELETE FROM sessions WHERE hash=?', current.hash);
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, '', true) });
  }
  if (path === '/api/projects' && method === 'GET') {
    const current = await requireSession(request, db);
    const projects = await db.all<Project>('SELECT * FROM projects ORDER BY created_at,id');
    const result = [];
    for (const project of projects) {
      const active = project.active_publication
        ? await db.one<Attempt>('SELECT * FROM attempts WHERE id=?', project.active_publication)
        : null;
      const latest = project.latest_attempt
        ? await db.one<Attempt>('SELECT * FROM attempts WHERE id=?', project.latest_attempt)
        : null;
      const manifest: Manifest | null = active?.manifest ? JSON.parse(active.manifest) : null;
      let prefix = '';
      if (active) {
        const token = random();
        await db.run(
          'INSERT INTO grants(hash,session_hash,project_id,publication_id,expires_at) VALUES(?,?,?,?,?)',
          await hash(token),
          current.hash,
          project.id,
          active.id,
          now() + 3600000,
        );
        prefix = `/mocks/${token}/`;
      }
      result.push({
        id: project.id,
        name: project.name,
        description: project.description,
        boards:
          manifest?.boards.map((board) => ({
            ...board,
            frames: board.frames.map((frame) => ({
              ...frame,
              entry: prefix + frame.entry,
              ...(frame.preview ? { preview: prefix + frame.preview } : {}),
            })),
          })) || [],
        publication: publication(latest),
        activePublication: publication(active),
        previewExpiresAt: active ? new Date(now() + 3600000).toISOString() : null,
      });
    }
    return json({ projects: result });
  }
  if (path.startsWith('/api/admin/')) {
    const current = await requireSession(request, db, true);
    if (method !== 'GET') sameOrigin(request);
    if (path === '/api/admin/users' && method === 'GET')
      return json({
        users: await db.all(
          'SELECT id,email,name,role,disabled,created_at AS createdAt FROM users ORDER BY created_at',
        ),
      });
    if (path === '/api/admin/users' && method === 'POST') {
      const input = await body(request);
      const id = crypto.randomUUID();
      const userEmail = email(input.email);
      const name = requireText(input.name, 'name');
      const role = input.role === 'admin' ? 'admin' : 'viewer';
      const digest = await passwordHasher.hash(password(input.password));
      if (await db.one('SELECT id FROM users WHERE email=?', userEmail))
        throw new HttpError(409, 'An account with this email already exists.');
      await db.run(
        'INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)',
        id,
        userEmail,
        name,
        role,
        digest,
        iso(),
      );
      return json({ user: { id, email: userEmail, name, role, disabled: 0 } }, 201);
    }
    const userMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (userMatch && method === 'PATCH') {
      const input = await body(request);
      const target = await db.one<User>('SELECT * FROM users WHERE id=?', userMatch[1]);
      if (!target) throw new HttpError(404, 'Account not found.');
      if (input.role !== undefined && !['admin', 'viewer'].includes(input.role))
        throw new HttpError(400, 'Invalid account role.');
      if (input.disabled !== undefined && typeof input.disabled !== 'boolean')
        throw new HttpError(400, 'disabled must be a boolean.');
      const role = input.role ?? target.role;
      const disabled = input.disabled === undefined ? target.disabled : input.disabled ? 1 : 0;
      if (target.id === current.user.id && (disabled || role !== 'admin'))
        throw new HttpError(400, 'You cannot disable or demote your own admin account.');
      const name = input.name === undefined ? target.name : requireText(input.name, 'name');
      const digest =
        input.password === undefined
          ? target.password_hash
          : await passwordHasher.hash(password(input.password));
      const results = await db.batch([
        [
          "UPDATE users SET name=?,role=?,disabled=?,password_hash=? WHERE id=? AND ((?='admin' AND ?=0) OR role!='admin' OR disabled=1 OR (SELECT COUNT(*) FROM users WHERE role='admin' AND disabled=0)>1)",
          [name, role, disabled, digest, target.id, role, disabled],
        ],
        ['DELETE FROM sessions WHERE user_id=?', [target.id]],
      ]);
      if (!results[0].changes)
        throw new HttpError(409, 'At least one enabled site admin must remain.');
      return json({ ok: true });
    }
    if (path === '/api/admin/projects' && method === 'POST') {
      const input = await body(request);
      const id = projectId(input.id);
      const name = requireText(input.name, 'project name');
      const description = input.description
        ? requireText(input.description, 'description', 1000)
        : '';
      const token = random();
      if (await db.one('SELECT id FROM projects WHERE id=?', id))
        throw new HttpError(409, 'This project id already exists.');
      await db.run(
        'INSERT INTO projects(id,name,description,token_hash,created_at) VALUES(?,?,?,?,?)',
        id,
        name,
        description,
        await hash(token),
        iso(),
      );
      return json({ project: { id, name, description, boards: [] }, token }, 201);
    }
    const tokenMatch = path.match(/^\/api\/admin\/projects\/([^/]+)\/token$/);
    if (tokenMatch && method === 'POST') {
      const token = random();
      const result = await db.run(
        'UPDATE projects SET token_hash=? WHERE id=?',
        await hash(token),
        tokenMatch[1],
      );
      if (!result.changes) throw new HttpError(404, 'Project not found.');
      return json({ token });
    }
  }
  const publishMatch = path.match(
    /^\/api\/publish\/([a-z0-9_-]+)\/attempts(?:\/([a-zA-Z0-9_-]+)(\/failure)?)?$/,
  );
  if (publishMatch) {
    const project = await publishProject(request, db, publishMatch[1]);
    const attemptId = publishMatch[2];
    if (!attemptId && method === 'POST') {
      const input = await body(request);
      const id =
        input.id === undefined ? crypto.randomUUID() : requireText(input.id, 'attempt id', 100);
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new HttpError(400, 'Invalid attempt id.');
      const existing = await db.one<Attempt>(
        'SELECT * FROM attempts WHERE id=? AND project_id=?',
        id,
        project.id,
      );
      if (existing) return json({ attemptId: existing.id, status: existing.status });
      if (
        input.sequence !== undefined &&
        (!Number.isSafeInteger(input.sequence) || input.sequence < 1)
      )
        throw new HttpError(400, 'sequence must be a positive integer.');
      const sourceCommit = sourceText(input.commit);
      const sourceRef = sourceText(input.ref);
      const sourceRun = runUrl(input.runUrl);
      const timestamp = iso();
      if (
        input.sequence !== undefined &&
        (await db.one(
          'SELECT id FROM attempts WHERE project_id=? AND sequence=?',
          project.id,
          input.sequence,
        ))
      )
        throw new HttpError(
          409,
          'This source sequence is already registered. Use a newer sequence for a new attempt.',
        );
      await db.batch([
        [
          'INSERT INTO attempts(id,project_id,sequence,status,created_at,updated_at,source_commit,source_ref,run_url) VALUES(?,?,COALESCE(?,(SELECT COALESCE(MAX(sequence),0)+1 FROM attempts WHERE project_id=?)),?,?,?,?,?,?)',
          [
            id,
            project.id,
            input.sequence ?? null,
            project.id,
            'pending',
            timestamp,
            timestamp,
            sourceCommit,
            sourceRef,
            sourceRun,
          ],
        ],
        [
          'UPDATE projects SET latest_attempt=? WHERE id=? AND (latest_attempt IS NULL OR (SELECT sequence FROM attempts WHERE id=latest_attempt)<(SELECT sequence FROM attempts WHERE id=?))',
          [id, project.id, id],
        ],
      ]);
      return json({ attemptId: id }, 201);
    }
    const attempt = await db.one<Attempt>(
      'SELECT * FROM attempts WHERE id=? AND project_id=?',
      attemptId || '',
      project.id,
    );
    if (!attempt) throw new HttpError(404, 'Publication attempt not found.');
    if (publishMatch[3] && method === 'POST') {
      await body(request);
      await db.run(
        "UPDATE attempts SET status='failed',message=?,updated_at=? WHERE id=? AND status IN ('pending','uploading')",
        'Publication failed. Open the source workflow for details.',
        iso(),
        attempt.id,
      );
      return json({ ok: true });
    }
    if (!publishMatch[3] && method === 'PUT') {
      if (attempt.status === 'published') return json({ ok: true, publicationId: attempt.id });
      if (attempt.status !== 'pending')
        throw new HttpError(409, 'This attempt is already finished. Register a new attempt.');
      let bundle;
      try {
        bundle = decodeBundle(await body(request, 29 * 1024 * 1024), project.id);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid bundle.');
      }
      const claimed = await db.run(
        "UPDATE attempts SET status='uploading',updated_at=? WHERE id=? AND status='pending' AND (SELECT latest_attempt FROM projects WHERE id=project_id AND token_hash=?)=id",
        iso(),
        attempt.id,
        project.token_hash,
      );
      if (!claimed.changes)
        throw new HttpError(
          409,
          'This attempt was superseded or is already uploading. Register a new attempt.',
        );
      // A single uploader owns immutable attempt paths, including during retries and concurrent requests.
      for (const file of bundle.files)
        await env.MOCKS.put(`${project.id}/${attempt.id}/${file.path}`, file.bytes, {
          httpMetadata: { contentType: file.contentType },
        });
      const manifest = JSON.stringify(bundle.manifest);
      await db.batch([
        [
          "UPDATE attempts SET status=CASE WHEN (SELECT latest_attempt FROM projects WHERE id=project_id AND token_hash=?)=id THEN 'published' ELSE 'superseded' END,manifest=?,updated_at=? WHERE id=? AND status='uploading'",
          [project.token_hash, manifest, iso(), attempt.id],
        ],
        [
          "UPDATE projects SET active_publication=? WHERE id=? AND latest_attempt=? AND (SELECT status FROM attempts WHERE id=?)='published'",
          [attempt.id, project.id, attempt.id, attempt.id],
        ],
      ]);
      const finished = await db.one<Attempt>('SELECT * FROM attempts WHERE id=?', attempt.id);
      return json(
        {
          ok: finished?.status === 'published',
          publicationId: attempt.id,
          status: finished?.status,
        },
        finished?.status === 'published' ? 200 : 409,
      );
    }
  }
  throw new HttpError(404, 'Endpoint not found.');
}

async function mock(request: Request, env: Env, db: Store, url: URL): Promise<Response> {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method))
    throw new HttpError(405, 'Method not allowed.');
  const match = url.pathname.match(/^\/mocks\/([a-f0-9]{64})\/(.+)$/);
  if (!match || !safePath(match[2])) throw new HttpError(404, 'Preview not found.');
  const grant = await db.one<{ project_id: string; publication_id: string }>(
    'SELECT g.project_id,g.publication_id FROM grants g JOIN sessions s ON s.hash=g.session_hash JOIN users u ON u.id=s.user_id WHERE g.hash=? AND g.expires_at>? AND s.expires_at>? AND u.disabled=0',
    await hash(match[1]),
    now(),
    now(),
  );
  if (!grant) throw new HttpError(401, 'Preview expired. Refresh the design viewer.');
  const prefix = `${url.origin}/mocks/${match[1]}/`;
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Content-Security-Policy': `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' ${prefix} blob:; style-src 'unsafe-inline' ${prefix}; img-src ${prefix} data: blob:; font-src ${prefix} data:; connect-src ${prefix} blob:; media-src ${prefix} blob:; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  const file = await env.MOCKS.get(`${grant.project_id}/${grant.publication_id}/${match[2]}`);
  if (!file) throw new HttpError(404, 'Preview resource not found.');
  headers['Content-Type'] = contentType(match[2]) || 'application/octet-stream';
  headers['Content-Length'] = String(file.size);
  return new Response(request.method === 'HEAD' ? null : file.body, { headers });
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const db = new D1Store(env.DB);
    try {
      if (url.pathname.startsWith('/api/')) return await api(request, env, db, url);
      if (url.pathname.startsWith('/mocks/')) return await mock(request, env, db, url);
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'no-referrer');
      headers.set(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      );
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error('Request failed', error instanceof Error ? error.name : 'unknown');
      return json({ error: 'The request could not be completed. Please try again.' }, 500);
    }
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const db = new D1Store(env.DB);
    const time = now();
    await db.run('DELETE FROM grants WHERE expires_at<?', time);
    await db.run('DELETE FROM sessions WHERE expires_at<?', time);
    await db.run('DELETE FROM login_limits WHERE reset_at<?', time);
    // Keep old immutable snapshots for a day, beyond every preview grant's one-hour lifetime.
    const obsolete = await db.all<{ id: string; project_id: string }>(
      'SELECT a.id,a.project_id FROM attempts a JOIN projects p ON p.id=a.project_id WHERE a.id IS NOT p.active_publication AND a.updated_at<? AND a.cleaned_at IS NULL LIMIT 100',
      new Date(time - 86400000).toISOString(),
    );
    for (const attempt of obsolete) {
      const claimed = await db.run(
        "UPDATE attempts SET status=CASE WHEN status IN ('pending','uploading') THEN 'unknown' ELSE status END WHERE id=? AND NOT EXISTS(SELECT 1 FROM projects WHERE active_publication=?)",
        attempt.id,
        attempt.id,
      );
      if (!claimed.changes) continue;
      let cursor: string | undefined;
      do {
        const listed = await env.MOCKS.list({
          prefix: `${attempt.project_id}/${attempt.id}/`,
          cursor,
        });
        if (listed.objects.length)
          await env.MOCKS.delete(listed.objects.map((object) => object.key));
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
      await db.run('UPDATE attempts SET manifest=NULL,cleaned_at=? WHERE id=?', iso(), attempt.id);
    }
  },
};
