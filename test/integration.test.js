import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { pack, unpack, plan, readManifest } from '../src/index.js';

const exec = promisify(execFile);
test('real demo build scripts consume restored upstream outputs across a diamond graph', async t => {
  const root = await mkdtemp(join(tmpdir(), 'buildgraph-chain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = await readManifest('buildgraph.json');
  const selected = plan(manifest).selected;
  const archives = new Map();
  const key = randomBytes(32).toString('hex');
  for (const id of selected) {
    const node = manifest.nodes[id];
    const inputs = join(root, id, 'inputs');
    const output = join(root, id, 'output');
    await mkdir(inputs, { recursive: true });
    for (const dep of node.needs ?? []) {
      await unpack({ archive: archives.get(dep), directory: join(inputs, dep), key, context: dep, tempRoot: root });
    }
    await exec(process.execPath, [resolve('examples/demo/build.mjs'), id], { env: { ...process.env, BUILDGRAPH_INPUTS: inputs, BUILDGRAPH_OUTPUT: output, BUILD_FLAVOR: 'integration' } });
    archives.set(id, await pack({ directory: output, visibility: node.output.visibility ?? 'encrypted', key, context: id, tempRoot: root }));
  }
  const destination = join(root, 'distribution');
  await unpack({ archive: archives.get('bundle'), directory: destination, visibility: 'public', tempRoot: root });
  assert.match(await readFile(join(destination, 'index.html'), 'utf8'), /Built from a shared dependency/);
  assert.equal((await exec(process.execPath, [join(destination, 'hello.mjs')])).stdout.trim(), 'Built from a shared dependency');
  assert.equal(archives.has('independent'), false);
});

test('bundled action rejects a stale generated workflow before returning a build selection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'buildgraph-action-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(exec(process.execPath, ['dist/action.cjs'], { env: {
    ...process.env, INPUT_OPERATION: 'plan', INPUT_MANIFEST: 'buildgraph.json', INPUT_TARGET: 'bundle',
    'INPUT_EXPECTED-DIGEST': 'stale', GITHUB_STEP_SUMMARY: join(root, 'summary'), GITHUB_OUTPUT: join(root, 'outputs'),
  } }), error => /Recompile and commit/.test(error.stdout));
});
