#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { compile, plan, readManifest } from '../src/index.js';

const help = `buildgraph validate [manifest.json]
buildgraph plan [manifest.json] [--target node_a,node_b] [--refs '{"node":"SHA"}']
buildgraph compile [manifest.json] [--output .github/workflows/build.yml] [--action-ref owner/repo@SHA]
buildgraph check [manifest.json] [--output .github/workflows/build.yml] [--action-ref owner/repo@SHA]
buildgraph keygen

The default manifest is buildgraph.json. Generated workflows run only on workflow_dispatch.
`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    target: { type: 'string' }, refs: { type: 'string' }, output: { type: 'string' },
    'action-ref': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  const [command, file = 'buildgraph.json'] = positionals;
  if (values.help || !command) process.stdout.write(help);
  else if (command === 'keygen') process.stdout.write(`${randomBytes(32).toString('hex')}\n`);
  else {
    if (!['validate', 'plan', 'compile', 'check'].includes(command)) throw new Error(`Unknown command: ${command}\n${help}`);
    if (positionals.length > 2) throw new Error('Expected one manifest path');
    const manifest = await readManifest(file);
    if (command === 'validate') console.log(`Valid graph: ${Object.keys(manifest.nodes).length} nodes`);
    else if (command === 'plan') console.log(JSON.stringify(plan(manifest, { target: values.target, refs: JSON.parse(values.refs || '{}') }), null, 2));
    else {
      const manifestPath = relative(process.cwd(), resolve(file)).split('\\').join('/');
      const output = values.output ?? '.github/workflows/build.yml';
      const result = compile(manifest, { manifestPath, actionRef: values['action-ref'] });
      if (command === 'check') {
        if (await readFile(output, 'utf8') !== result) throw new Error(`${output} is stale; run buildgraph compile with the same options`);
        console.log(`${output} is up to date`);
      } else {
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, result);
        console.log(`Generated ${output}`);
      }
    }
  }
} catch (error) {
  console.error(`buildgraph: ${error.message}`);
  process.exitCode = 1;
}
