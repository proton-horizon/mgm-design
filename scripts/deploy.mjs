import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
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

/** Creates a production config from instance settings, rebasing source paths against the output file. Never copies credentials or local auth overrides. Throws on incomplete or invalid settings. */
export function createConfig(env, outputPath = resolve(root, configFile)) {
  const sourcePath = (path) => {
    if (dirname(resolve(outputPath)) === root) return path;
    return relative(dirname(resolve(outputPath)), resolve(root, path))
      .split(sep)
      .join('/');
  };
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
    $schema: sourcePath('./node_modules/wrangler/config-schema.json'),
    name,
    ...(env.CLOUDFLARE_ACCOUNT_ID
      ? { account_id: required(env, 'CLOUDFLARE_ACCOUNT_ID', /^[a-f0-9]{32}$/i) }
      : {}),
    main: sourcePath('worker/index.ts'),
    compatibility_date: '2026-09-07',
    compatibility_flags: ['nodejs_compat'],
    workers_dev: workersDev,
    preview_urls: false,
    routes: workersDev ? [] : [{ pattern: site.hostname, custom_domain: true }],
    assets: {
      directory: sourcePath('./dist'),
      binding: 'ASSETS',
      run_worker_first: true,
      not_found_handling: 'single-page-application',
    },
    d1_databases: [
      {
        binding: 'DB',
        database_name: databaseName,
        database_id: databaseId,
        migrations_dir: sourcePath('migrations'),
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

/** Checks bundling, applies migrations, then deploys using the same config path throughout. Any failure stops later steps; migrations must remain compatible with the running Worker. */
export function runDeployment(run, configPath = configFile) {
  run(['deploy', '--dry-run', '--config', configPath]);
  run(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath]);
  run(['deploy', '--config', configPath]);
}

function main(args) {
  const usage =
    'Usage: node scripts/deploy.mjs (--config-only | --dry-run | --deploy) [--output <path>]';
  if (!args.length || (args.length === 1 && args[0] === '--help')) {
    console.log(usage);
    return;
  }
  let mode;
  let output;
  for (let i = 0; i < args.length; i++) {
    if (['--config-only', '--dry-run', '--deploy'].includes(args[i]) && !mode) mode = args[i];
    else if (args[i] === '--output' && !output && args[i + 1] && !args[i + 1].startsWith('--'))
      output = args[++i];
    else throw new Error(usage);
  }
  if (!mode) throw new Error(usage);
  const configPath = output ? resolve(output) : resolve(root, configFile);
  const config = createConfig(process.env, configPath);
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(configPath, 0o600);
  console.log(`Generated ${configPath} for ${config.name} (${config.vars.SITE_URL}).`);
  const run = (wranglerArgs) => {
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.resolve('wrangler')), ...wranglerArgs],
      {
        cwd: dirname(configPath),
        stdio: 'inherit',
        shell: false,
      },
    );
    if (child.error) throw new Error(`Cannot start Wrangler: ${child.error.message}`);
    if (child.status !== 0)
      throw new Error(
        `Wrangler ${wranglerArgs.slice(0, 3).join(' ')} failed; remaining steps skipped.`,
      );
  };
  if (mode === '--dry-run') run(['deploy', '--dry-run', '--config', configPath]);
  if (mode === '--deploy') runDeployment(run, configPath);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
