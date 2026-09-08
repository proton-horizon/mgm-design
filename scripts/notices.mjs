import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seen = new Set();
const sections = [];

async function collect(name, from) {
  const manifestPath = createRequire(from).resolve(`${name}/package.json`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const identity = `${manifest.name}@${manifest.version}`;
  if (seen.has(identity)) return;
  seen.add(identity);
  // Fail the build when a changed dependency needs a different notice source.
  const license = await readFile(resolve(dirname(manifestPath), 'LICENSE'), 'utf8');
  sections.push(`${identity}\n${'='.repeat(identity.length)}\n\n${license.trim()}`);
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort())
    await collect(dependency, manifestPath);
}

const manifestPath = resolve(root, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
for (const name of Object.keys(manifest.dependencies).sort()) await collect(name, manifestPath);
// Lucide's notice identifies inherited Feather icons under MIT.
sections.push(
  `Feather portions of Lucide\nhttps://github.com/feathericons/feather/blob/master/LICENSE\n\n${(await readFile(resolve(root, 'scripts/licenses/feather.txt'), 'utf8')).trim()}`,
);
await mkdir(resolve(root, 'public'), { recursive: true });
await writeFile(
  resolve(root, 'public/third-party-notices.txt'),
  `MGM Design — third-party notices\n\nThese components retain their own licenses. MGM Design's license does not replace them.\nDesign content published to an installation carries its own notices.\n\n${sections.join('\n\n')}\n`,
);
