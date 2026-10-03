import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { schema } from '../src/schema.js';

await build({ entryPoints: ['src/action.js'], outfile: 'dist/action.cjs', bundle: true, platform: 'node', target: 'node24', format: 'cjs', minify: false, legalComments: 'eof' });
await writeFile('schema.json', JSON.stringify(schema, null, 2) + '\n');

const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const notices = ['Third-party notices for the Buildgraph Action bundle.\n'];
for (const [path, metadata] of Object.entries(lock.packages)) {
  if (!path || metadata.dev) continue;
  let license;
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    try { license = await readFile(`${path}/${name}`, 'utf8'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!license && path === 'node_modules/require-from-string') {
    license = 'MIT License\n\nCopyright Vsevolod Strukchinsky\n\nPermission is hereby granted' + (await readFile('LICENSE', 'utf8')).split('Permission is hereby granted')[1];
  }
  if (!license) throw new Error(`Missing third-party license: ${path}`);
  notices.push(`${path.replace('node_modules/', '')} ${metadata.version} (${metadata.license})\n\n${license}`);
}
await writeFile('dist/licenses.txt', notices.join('\n\n-----\n\n'));
