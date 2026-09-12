#!/usr/bin/env node
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readBundle } from './read-bundle.mjs';

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
const site = option('--site', process.env.MGM_SITE_URL);
const project = option('--project', process.env.MGM_PROJECT_ID);
const token = process.env.MGM_PUBLISH_TOKEN;
const directory = resolve(option('--directory', 'design'));
if (!site || !project || !token) {
  console.error(
    'Set MGM_SITE_URL, MGM_PROJECT_ID and MGM_PUBLISH_TOKEN (or use --site / --project).',
  );
  process.exit(1);
}
const url = new URL(site);
if (
  url.protocol !== 'https:' &&
  !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
)
  throw new Error('Publishing requires HTTPS, except localhost.');
if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
  throw new Error('Site must be an origin URL without credentials, path, query or fragment.');
const base = `${url.origin}/api/publish/${encodeURIComponent(project)}/attempts`;
async function send(path, method, value) {
  const response = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(value),
    redirect: 'error',
    signal: AbortSignal.timeout(120000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      `Publish request failed (${response.status}): ${result.error || result.status || 'unknown error'}`,
    );
  return result;
}
let attemptId;
try {
  const sequenceText = process.env.MGM_PUBLISH_SEQUENCE;
  const metadata = {
    id: randomUUID(),
    commit: process.env.GITHUB_SHA,
    ref: process.env.GITHUB_REF,
    runUrl:
      process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : undefined,
    sequence: sequenceText ? Number(sequenceText) : undefined,
  };
  // Register first so missing files and local validation failures appear on the destination site.
  ({ attemptId } = await send(base, 'POST', metadata));
  let bundle = await readBundle(directory, project);
  if (args.includes('--previews')) {
    const { generatePreviews } = await import('./generate-previews.mjs');
    bundle = await generatePreviews(bundle);
  }
  const { manifest, files } = bundle;
  await send(`${base}/${attemptId}`, 'PUT', { manifest, files });
  console.log(
    `Published ${project}: ${manifest.boards.length} boards, ${manifest.files.length} files to ${url.origin}.`,
  );
} catch (error) {
  if (attemptId) {
    try {
      await send(`${base}/${attemptId}/failure`, 'POST', {
        message: 'Publication failed; inspect the source workflow.',
      });
    } catch {
      console.error('The site could not receive the failure report; check this workflow result.');
    }
  }
  console.error(error instanceof Error ? error.message : 'Publication failed.');
  process.exitCode = 1;
}
