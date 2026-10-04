#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { diagnoseWiring, plan, readWorkflow } from '../src/index.js';

const help = `buildgraph validate [workflow.yml]
buildgraph plan [workflow.yml] [--target job_a,job_b] [--planner-job plan]
buildgraph keygen

The default workflow is .github/workflows/build.yml. Edit native Actions YAML directly.
`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    target: { type: 'string' }, 'planner-job': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  const [command, file = '.github/workflows/build.yml'] = positionals;
  if (values.help || !command) process.stdout.write(help);
  else if (command === 'keygen') process.stdout.write(`${randomBytes(32).toString('hex')}\n`);
  else {
    if (!['validate', 'plan'].includes(command)) throw new Error(`Unknown command: ${command}\n${help}`);
    if (positionals.length > 2) throw new Error('Expected one workflow path');
    const workflow = await readWorkflow(file);
    const diagnostics = diagnoseWiring(workflow, { plannerJob: values['planner-job'] });
    for (const item of diagnostics.filter(item => item.level === 'warning')) console.error(`Warning: ${item.message}`);
    const errors = diagnostics.filter(item => item.level === 'error');
    if (errors.length) throw new Error(errors.map(item => item.message).join('\n'));
    if (command === 'validate') console.log(`Valid dependency graph: ${Object.keys(workflow.jobs).length} jobs`);
    else console.log(JSON.stringify(plan(workflow, { target: values.target, plannerJob: values['planner-job'] }), null, 2));
  }
} catch (error) {
  console.error(`buildgraph: ${error.message}`);
  process.exitCode = 1;
}
