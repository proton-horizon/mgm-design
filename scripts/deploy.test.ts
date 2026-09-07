import { describe, expect, it } from 'vitest';
import { createConfig, runDeployment } from './deploy.mjs';

const env = {
  MGM_WORKER_NAME: 'example-design',
  MGM_D1_DATABASE_NAME: 'example-design-db',
  MGM_D1_DATABASE_ID: '00000000-0000-0000-0000-000000000001',
  MGM_R2_BUCKET_NAME: 'example-design-mocks',
  MGM_SITE_URL: 'https://design.example.com',
  MGM_SITE_NAME: 'Example Design',
};

describe('instance deployment', () => {
  it('keeps destinations separate and excludes credentials and local auth settings', () => {
    const first = createConfig({
      ...env,
      SETUP_SECRET: 'never-copy',
      CLOUDFLARE_API_TOKEN: 'never-copy',
      LOCAL_AUTH_BYPASS: 'true',
    });
    const second = createConfig({
      ...env,
      MGM_WORKER_NAME: 'other-design',
      MGM_SITE_URL: 'https://design.other.com',
      MGM_D1_DATABASE_ID: '00000000-0000-0000-0000-000000000002',
      MGM_R2_BUCKET_NAME: 'other-mocks',
    });
    expect(first.assets.run_worker_first).toBe(true);
    expect(first.vars).toEqual({ SITE_NAME: env.MGM_SITE_NAME, SITE_URL: env.MGM_SITE_URL });
    expect(JSON.stringify(first)).not.toContain('never-copy');
    expect(first.d1_databases[0].database_id).not.toBe(second.d1_databases[0].database_id);
    expect(first.r2_buckets[0].bucket_name).not.toBe(second.r2_buckets[0].bucket_name);
    expect(first.routes).not.toEqual(second.routes);
  });

  it.each(Object.keys(env))('rejects missing %s', (key) => {
    expect(() => createConfig({ ...env, [key]: '' })).toThrow();
  });

  it.each([
    'http://design.example.com',
    'https://user:pass@design.example.com',
    'https://design.example.com/app',
    'https://design.example.com?token=x',
    'https://design.example.com#app',
    'https://design.example.com:444',
    'https://other.example.workers.dev',
  ])('rejects unsuitable canonical URL %s', (url) => {
    expect(() => createConfig({ ...env, MGM_SITE_URL: url })).toThrow();
  });

  it('supports a workers.dev installation and switching to a custom domain without changing storage identity', () => {
    const worker = createConfig({
      ...env,
      MGM_SITE_URL: 'https://example-design.owner.workers.dev',
    });
    const custom = createConfig(env);
    expect(worker.workers_dev).toBe(true);
    expect(worker.routes).toEqual([]);
    expect(custom.workers_dev).toBe(false);
    expect(worker.d1_databases).toEqual(custom.d1_databases);
    expect(worker.r2_buckets).toEqual(custom.r2_buckets);
  });

  it.each([0, 1])('stops on a failed preflight or migration (step %i)', (failAt) => {
    const calls: string[][] = [];
    expect(() =>
      runDeployment((args: string[]) => {
        calls.push(args);
        if (calls.length - 1 === failAt) throw new Error('failure');
      }),
    ).toThrow('failure');
    expect(calls).toHaveLength(failAt + 1);
    expect(calls.some((args) => args[0] === 'deploy' && !args.includes('--dry-run'))).toBe(false);
  });

  it('deploys only after preflight and migration succeed', () => {
    const calls: string[][] = [];
    runDeployment((args: string[]) => calls.push(args));
    expect(calls.map((args) => args.slice(0, 3))).toEqual([
      ['deploy', '--dry-run', '--config'],
      ['d1', 'migrations', 'apply'],
      ['deploy', '--config', 'wrangler.instance.json'],
    ]);
  });

  it('records the source commit supplied by Workers Builds', () => {
    expect(createConfig({ ...env, WORKERS_CI_COMMIT_SHA: 'a'.repeat(40) }).vars.BUILD_COMMIT).toBe(
      'a'.repeat(40),
    );
    expect(() => createConfig({ ...env, WORKERS_CI_COMMIT_SHA: 'not-a-commit' })).toThrow();
  });
});
