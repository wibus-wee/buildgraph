import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { dependencies, pack, unpack, plan, readWorkflow } from '../src/index.js';

const exec = promisify(execFile);
test('real demo build scripts consume restored upstream outputs across a diamond graph', async t => {
  const root = await mkdtemp(join(tmpdir(), 'buildgraph-chain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflow = await readWorkflow('.github/workflows/build.yml');
  const selected = plan(workflow).selected;
  const archives = new Map();
  const key = randomBytes(32).toString('hex');
  for (const id of selected) {
    const job = workflow.jobs[id];
    const inputs = join(root, id, 'inputs');
    const output = join(root, id, 'output');
    await mkdir(inputs, { recursive: true });
    for (const dep of dependencies(workflow, id).filter(dep => dep !== 'plan')) {
      await unpack({ archive: archives.get(dep), directory: join(inputs, dep), key, context: dep, tempRoot: root });
    }
    await exec(process.execPath, [resolve('examples/demo/build.mjs'), id], { env: { ...process.env, BUILDGRAPH_INPUTS: inputs, BUILDGRAPH_OUTPUT: output, BUILD_FLAVOR: 'integration' } });
    const visibility = job.steps.find(step => step.id === 'pack').with.visibility ?? 'encrypted';
    archives.set(id, await pack({ directory: output, visibility, key, context: id, tempRoot: root }));
  }
  const destination = join(root, 'distribution');
  await unpack({ archive: archives.get('bundle'), directory: destination, visibility: 'public', tempRoot: root });
  assert.match(await readFile(join(destination, 'index.html'), 'utf8'), /Built from a shared dependency/);
  assert.equal((await exec(process.execPath, [join(destination, 'hello.mjs')])).stdout.trim(), 'Built from a shared dependency');
  assert.equal(archives.has('independent'), false);
});

test('bundled planner reads the workflow itself and produces the selected job output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'buildgraph-action-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'summary'), '');
  await writeFile(join(root, 'outputs'), '');
  const env = {
    ...process.env, INPUT_OPERATION: 'plan', INPUT_WORKFLOW: '.github/workflows/build.yml', INPUT_TARGET: 'cli',
    GITHUB_STEP_SUMMARY: join(root, 'summary'), GITHUB_OUTPUT: join(root, 'outputs'),
  };
  await exec(process.execPath, ['dist/action.cjs'], { env });
  assert.match(await readFile(join(root, 'outputs'), 'utf8'), /\["core","cli"\]/);
  assert.doesNotMatch(await readFile(join(root, 'summary'), 'utf8'), /bundle|independent/);
  await assert.rejects(exec(process.execPath, ['dist/action.cjs'], { env: { ...env, INPUT_TARGET: 'missing' } }), error => /Unknown target job/.test(error.stdout));
});
