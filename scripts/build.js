import { build } from 'esbuild';
import { readFile, readdir, writeFile } from 'node:fs/promises';

await build({ entryPoints: ['src/action.js'], outfile: 'dist/action.cjs', bundle: true, platform: 'node', target: 'node24', format: 'cjs', minify: false, legalComments: 'eof' });

const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const notices = ['Third-party notices for the Buildgraph Action bundle.\n'];
for (const [path, metadata] of Object.entries(lock.packages)) {
  if (!path || metadata.dev) continue;
  const filename = (await readdir(path)).sort().find(name => /^licen[sc]e(\.md|\.txt)?$/i.test(name));
  if (!filename) throw new Error(`Missing third-party license: ${path}`);
  const license = (await readFile(`${path}/${filename}`, 'utf8')).replace(/\r\n/g, '\n');
  notices.push(`${path.replace('node_modules/', '')} ${metadata.version} (${metadata.license})\n\n${license}`);
}
await writeFile('dist/licenses.txt', notices.join('\n\n-----\n\n'));
