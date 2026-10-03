import * as core from '@actions/core';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pack, unpack } from './artifacts.js';
import { plan, readManifest } from './graph.js';

const input = name => core.getInput(name);
const required = name => core.getInput(name, { required: true });

async function main() {
  const operation = required('operation');
  const key = input('key');
  if (key) core.setSecret(key);
  if (operation === 'plan') {
    const manifest = await readManifest(required('manifest'));
    const result = plan(manifest, { target: input('target') || manifest.defaultTarget, refs: JSON.parse(input('refs') || '{}') });
    if (input('expected-digest') && result.digest !== input('expected-digest')) throw new Error('Manifest changed after workflow generation. Recompile and commit the workflow before dispatching.');
    core.setOutput('selected', JSON.stringify(result.selected));
    core.setOutput('refs', JSON.stringify(result.refs));
    core.setOutput('digest', result.digest);
    const rows = result.selected.map(id => [id, (manifest.nodes[id].needs ?? []).join(', ') || '—', manifest.nodes[id].output ? (manifest.nodes[id].output.visibility ?? 'encrypted') : 'none']);
    await core.summary.addHeading('Buildgraph plan').addTable([
      [{ data: 'Node', header: true }, { data: 'Needs', header: true }, { data: 'Output', header: true }], ...rows,
    ]).addRaw(`\nManifest SHA-256: \`${result.digest}\`\n`).write();
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
