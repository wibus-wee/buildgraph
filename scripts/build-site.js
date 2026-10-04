import { build } from 'esbuild';
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { readWorkflow } from '../src/graph.js';
import { describeWorkflow } from '../site/model.js';

const repository = process.env.GITHUB_REPOSITORY || 'wibus-wee/buildgraph';
const branch = process.env.SITE_BRANCH || 'main';
if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository))
  throw new Error('GITHUB_REPOSITORY must be owner/name');
await mkdir('_site', { recursive: true });
await Promise.all(['index.html', 'style.css'].map((file) => cp(`site/${file}`, `_site/${file}`)));
await cp('node_modules/yaml/LICENSE', '_site/vendor-LICENSE.txt');
await cp('site/fonts', '_site/fonts', { recursive: true });
await build({
  entryPoints: ['site/app.js'],
  outfile: '_site/app.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  minify: true,
});
const workflows = [];
for (const file of (await readdir('.github/workflows')).filter((x) => /\.ya?ml$/.test(x)).sort()) {
  const workflow = await readWorkflow(`.github/workflows/${file}`);
  if (!Object.hasOwn(workflow.on ?? {}, 'workflow_dispatch')) continue;
  workflows.push(describeWorkflow(file, workflow));
}
// Derived display data, rebuilt from native workflows on each Pages deployment.
await writeFile('_site/catalog.json', JSON.stringify({ repository, branch, workflows }));
await writeFile('_site/.nojekyll', '');
