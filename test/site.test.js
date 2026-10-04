import test from 'node:test';
import assert from 'node:assert/strict';
import { newWorkflow } from '../site/workflow.js';
import { parseWorkflow, plan, diagnoseWiring } from '../src/graph.js';
import { parse } from 'yaml';

test('onboarding emits native workflows with independent build and explicit delivery targets', () => {
  for (const stack of ['node', 'go', 'custom'])
    for (const mode of ['artifact', 'release', 'dispatch']) {
      const result = newWorkflow({
        project: 'photo',
        source: 'org/private',
        command: 'npm ci\nnpm run build',
        output: 'source/dist',
        stack,
        mode,
        destinations: 'a/dist\nb/mirror',
      });
      const workflow = parseWorkflow(result.yaml);
      assert.deepEqual(plan(workflow, { target: 'build' }).selected, ['build']);
      assert.deepEqual(diagnoseWiring(workflow), []);
      assert.equal(workflow.on.workflow_dispatch.inputs.target.default, 'build');
      assert.equal(workflow.jobs.build.steps.at(-1).with.key, '${{ secrets.BUILDGRAPH_ARTIFACT_KEY }}');
      if (mode !== 'artifact') {
        assert.deepEqual(plan(workflow, { target: 'deliver' }).selected, ['build', 'deliver']);
        assert.equal(workflow.jobs.deliver.strategy.matrix.include.length, 2);
        assert.equal(workflow.jobs.deliver.environment, 'production');
      }
      if (mode === 'dispatch') {
        const inputs = workflow.jobs.deliver.steps.at(-1).with.inputs;
        assert.match(inputs, /toJSON\(inputs.request_id/);
      }
    }
});

test('onboarding rejects injected identifiers and escaping output directories', () => {
  const options = { project: 'photo', source: 'org/private', command: 'make build', output: 'source/dist' };
  for (const change of [
    { project: 'photo\nother:' },
    { source: 'org/repo\npermissions:' },
    { output: 'source/../../secret' },
    { mode: 'release', destinations: '' },
  ])
    assert.throws(() => newWorkflow({ ...options, ...change }));
  const command = 'echo "literal: text"\nmake build';
  const workflow = parse(newWorkflow({ ...options, command }).yaml);
  assert.equal(workflow.jobs.build.steps.find((step) => step.name === 'Build').run, command);
});
