import * as core from '@actions/core';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pack, unpack } from './artifacts.js';
import { dependencies, plan, readWorkflow } from './graph.js';

const input = name => core.getInput(name);
const required = name => core.getInput(name, { required: true });

async function main() {
  const operation = required('operation');
  const key = input('key');
  if (key) core.setSecret(key);
  if (operation === 'plan') {
    const workflow = await readWorkflow(required('workflow'));
    const result = plan(workflow, { target: input('target') || undefined, plannerJob: input('planner-job') || 'plan' });
    core.setOutput('selected', JSON.stringify(result.selected));
    const rows = result.selected.map(id => [id, dependencies(workflow, id).join(', ') || '—']);
    await core.summary.addHeading('Buildgraph plan').addTable([
      [{ data: 'Job', header: true }, { data: 'Needs', header: true }], ...rows,
    ]).write();
    core.info(`Selected: ${result.selected.join(' -> ')}`);
  } else if (operation === 'prepare') {
    await mkdir(required('directory'), { recursive: true });
    await mkdir(required('inputs-directory'), { recursive: true });
    const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: required('source-directory') });
    const sha = stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('Could not record source commit');
    core.info(`Source commit: ${sha}`);
    await core.summary.addRaw(`\nSource commit: \`${sha}\`\n`).write();
  } else if (operation === 'pack' || operation === 'unpack') {
    const options = { directory: required('directory'), visibility: input('visibility') || 'encrypted', key, context: input('context') };
    if (operation === 'pack') core.setOutput('archive', await pack(options));
    else await unpack({ ...options, archive: required('archive') });
  } else throw new Error(`Unknown operation: ${operation}`);
}

main().catch(error => core.setFailed(error.message));
