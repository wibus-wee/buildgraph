import { build } from 'esbuild';
import { readFile, readdir, writeFile } from 'node:fs/promises';

const result = await build({ entryPoints: ['src/action.js'], outfile: 'dist/api.cjs', bundle: true, platform: 'node', target: 'node24', format: 'cjs', minify: false, legalComments: 'eof', metafile: true });
await writeFile('dist/action.cjs', "require('./api.cjs').run();\n");

const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const notices = ['Third-party notices for the Buildgraph Action bundle.\n'];
for (const [path, metadata] of Object.entries(lock.packages)) {
  if (!path || metadata.dev || !Object.keys(result.metafile.inputs).some(input => input.startsWith(`${path}/`))) continue;
  const filename = (await readdir(path)).sort().find(name => /^licen[sc]e(?:-MIT)?(\.md|\.txt)?$/i.test(name));
  const licensePath = filename ? `${path}/${filename}` : path.endsWith('/isarray') ? `${path}/README.md` : `licenses/${path.replaceAll('node_modules/', '').replaceAll('/', '__')}.txt`;
  let license = (await readFile(licensePath, 'utf8')).replace(/\r\n/g, '\n');
  if (path.endsWith('/isarray')) license = license.slice(license.indexOf('## License'));
  license = license.split('\n').map(line => line.trimEnd()).join('\n');
  notices.push(`${path.replace('node_modules/', '')} ${metadata.version} (${metadata.license})\n\n${license}`);
}
await writeFile('dist/licenses.txt', notices.join('\n\n-----\n\n'));
