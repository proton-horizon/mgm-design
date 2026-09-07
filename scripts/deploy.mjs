import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configFile = 'wrangler.instance.json';

function required(env, key, pattern) {
  const value = env[key]?.trim();
  if (!value || (pattern && !pattern.test(value))) {
    throw new Error(`Missing or invalid ${key}`);
  }
  return value;
}

/** Creates a production config from instance settings; never copies credentials or local auth overrides. Throws on incomplete or invalid settings. */
export function createConfig(env) {
  const name = required(env, 'MGM_WORKER_NAME', /^[a-z0-9][a-z0-9_-]{0,62}$/);
  const databaseName = required(env, 'MGM_D1_DATABASE_NAME', /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
  const databaseId = required(
    env,
    'MGM_D1_DATABASE_ID',
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
  );
  const bucketName = required(env, 'MGM_R2_BUCKET_NAME', /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/);
  const siteName = required(env, 'MGM_SITE_NAME');
  let site;
  try {
    site = new URL(required(env, 'MGM_SITE_URL'));
  } catch {
    throw new Error('MGM_SITE_URL must be an HTTPS origin');
  }
  if (
    site.protocol !== 'https:' ||
    site.username ||
    site.password ||
    site.port ||
    site.pathname !== '/' ||
    site.search ||
    site.hash ||
    !site.hostname.includes('.')
  ) {
    throw new Error(
      'MGM_SITE_URL must be an HTTPS origin without credentials, port, path, query, or fragment',
    );
  }
  const workersDev = site.hostname.endsWith('.workers.dev');
  if (
    workersDev &&
    (site.hostname.split('.').length !== 4 || !site.hostname.startsWith(`${name}.`))
  ) {
    throw new Error('MGM_SITE_URL must use the configured Worker name on workers.dev');
  }
  const sourceCommit = env.WORKERS_CI_COMMIT_SHA?.trim();
  if (sourceCommit && !/^[a-f0-9]{40,64}$/i.test(sourceCommit))
    throw new Error('Invalid WORKERS_CI_COMMIT_SHA');
  return {
    $schema: './node_modules/wrangler/config-schema.json',
    name,
    ...(env.CLOUDFLARE_ACCOUNT_ID
      ? { account_id: required(env, 'CLOUDFLARE_ACCOUNT_ID', /^[a-f0-9]{32}$/i) }
      : {}),
    main: 'worker/index.ts',
    compatibility_date: '2026-09-07',
    workers_dev: workersDev,
    preview_urls: false,
    routes: workersDev ? [] : [{ pattern: site.hostname, custom_domain: true }],
    assets: {
      directory: './dist',
      binding: 'ASSETS',
      run_worker_first: true,
      not_found_handling: 'single-page-application',
    },
    d1_databases: [
      {
        binding: 'DB',
        database_name: databaseName,
        database_id: databaseId,
        migrations_dir: 'migrations',
      },
    ],
    r2_buckets: [{ binding: 'MOCKS', bucket_name: bucketName }],
    vars: {
      SITE_NAME: siteName,
      SITE_URL: site.origin,
      ...(sourceCommit ? { BUILD_COMMIT: sourceCommit } : {}),
    },
    triggers: { crons: ['0 3 * * *'] },
    secrets: { required: ['SETUP_SECRET'] },
  };
}

/** Checks bundling, applies migrations, then deploys. Any failure stops later steps; migrations must remain compatible with the running Worker. */
export function runDeployment(run) {
  run(['deploy', '--dry-run', '--config', configFile]);
  run(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', configFile]);
  run(['deploy', '--config', configFile]);
}

function main(args) {
  if (args.length !== 1 || !['--config-only', '--dry-run', '--deploy'].includes(args[0])) {
    console.log('Usage: node scripts/deploy.mjs --config-only | --dry-run | --deploy');
    if (args.length && args[0] !== '--help') process.exitCode = 1;
    return;
  }
  const config = createConfig(process.env);
  writeFileSync(resolve(root, configFile), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`Generated ${configFile} for ${config.name} (${config.vars.SITE_URL}).`);
  const run = (wranglerArgs) => {
    const child = spawnSync('pnpm', ['exec', 'wrangler', ...wranglerArgs], {
      cwd: root,
      stdio: 'inherit',
      shell: false,
    });
    if (child.error) throw new Error(`Cannot start pnpm: ${child.error.message}`);
    if (child.status !== 0)
      throw new Error(
        `Wrangler ${wranglerArgs.slice(0, 3).join(' ')} failed; remaining steps skipped.`,
      );
  };
  if (args[0] === '--dry-run') run(['deploy', '--dry-run', '--config', configFile]);
  if (args[0] === '--deploy') runDeployment(run);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
