import * as core from '@actions/core';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pack, unpack } from './artifacts.js';
import { dependencies, diagnoseWiring, plan, readWorkflow } from './graph.js';
import { DefaultArtifactClient } from '@actions/artifact';
import { upload, download } from './transfer.js';

const input = name => core.getInput(name);
const required = name => core.getInput(name, { required: true });

async function main(operation) {
  const key = input('key');
  if (key) core.setSecret(key);
  if (operation === 'plan') {
    const workflow = await readWorkflow(required('workflow'));
    const plannerJob = input('planner-job') || 'plan';
    const diagnostics = diagnoseWiring(workflow, { plannerJob });
    for (const item of diagnostics.filter(item => item.level === 'warning')) core.warning(item.message);
    const errors = diagnostics.filter(item => item.level === 'error');
    if (errors.length) throw new Error(errors.map(item => item.message).join('\n'));
    const result = plan(workflow, { target: input('target') || undefined, plannerJob });
    core.setOutput('selected', JSON.stringify(result.selected));
    const rows = result.selected.map(id => [id, dependencies(workflow, id).join(', ') || '—']);
    await core.summary.addHeading('Buildgraph plan').addTable([
      [{ data: 'Job', header: true }, { data: 'Needs', header: true }], ...rows,
    ]).write();
    core.info(`Selected: ${result.selected.join(' -> ')}`);
  } else if (operation === 'upload' || operation === 'download') {
    const options = { client: new DefaultArtifactClient(), directory: required('path'), visibility: input('visibility') || 'encrypted', key };
    if (operation === 'upload') {
      const result = await upload({ ...options, retentionDays: Number(input('retention-days') || '7') });
      core.setOutput('artifact-id', result.id);
      core.setOutput('artifact-name', result.name);
      core.setOutput('artifact-digest', result.digest);
    } else core.setOutput('path', await download({ ...options, artifactId: required('artifact-id') }));
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

export function run(operation) {
  return main(operation || input('operation')).catch(error => core.setFailed(error.message));
}
