import test from 'node:test';
import assert from 'node:assert/strict';
import { newWorkflow } from '../site/workflow.js';
import { parseWorkflow, plan, diagnoseWiring } from '../src/graph.js';
import { parse } from 'yaml';
import { describeWorkflow, filterWorkflows, layoutGraph, latestFor, statusLabel } from '../site/model.js';

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

test('catalog derives jobs and targets from native YAML without retaining commands or credentials', () => {
  const workflow = parse(
    newWorkflow({ project: 'photo', source: 'org/private', command: 'make build', output: 'source/dist' })
      .yaml,
  );
  const model = describeWorkflow('project-photo.yml', workflow);
  assert.deepEqual(model.targets, ['build']);
  assert.deepEqual(model.jobs.find((job) => job.id === 'build').needs, ['plan']);
  assert.equal(model.jobs.find((job) => job.id === 'plan').planner, true);
  assert.ok(model.jobs.find((job) => job.id === 'build').steps.includes('Build'));
  assert.doesNotMatch(JSON.stringify(model), /make build|SOURCE_READ_TOKEN|org\/private/);

  workflow.jobs.build['runs-on'] = ['self-hosted', 'linux'];
  assert.equal(describeWorkflow('photo.yml', workflow).jobs[1].runner, 'self-hosted, linux');
  workflow.on.workflow_dispatch.inputs.target = { type: 'string' };
  assert.deepEqual(describeWorkflow('photo.yml', workflow).targets, ['build']);
  delete workflow.jobs.plan;
  workflow.jobs.build.needs = [];
  assert.deepEqual(describeWorkflow('ordinary.yml', workflow).targets, []);
  const called = describeWorkflow('reuse.yml', {
    jobs: { build: { uses: 'org/ci/.github/workflows/build.yml@main' } },
  }).jobs[0];
  assert.equal(called.reusable, 'org/ci/.github/workflows/build.yml@main');
  assert.equal(called.runner, 'Defined by reusable workflow');
});

test('topology keeps unrelated roots separate and places dependants after every parent', () => {
  const jobs = [
    { id: 'app', needs: ['sdk'] },
    { id: 'backup', needs: [] },
    { id: 'sdk', needs: [] },
    { id: 'publish', needs: ['sdk', 'app'] },
  ];
  const before = structuredClone(jobs);
  const { nodes, width, height } = layoutGraph(jobs);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  assert.equal(byId.get('backup').x, byId.get('sdk').x);
  assert.notEqual(byId.get('backup').y, byId.get('sdk').y);
  for (const node of nodes) {
    for (const parent of node.needs) assert.ok(byId.get(parent).x + 154 < node.x);
    assert.ok(node.x >= 0 && node.x + 154 <= width);
    assert.ok(node.y >= 0 && node.y + 64 <= height);
  }
  assert.deepEqual(jobs, before);
  assert.throws(() => layoutGraph([{ id: 'a', needs: ['b'] }]), /missing job/);
  assert.throws(
    () =>
      layoutGraph([
        { id: 'a', needs: ['b'] },
        { id: 'b', needs: ['a'] },
      ]),
    /cycle/,
  );
  assert.deepEqual(layoutGraph([]).nodes, []);
});

test('search matches every query word and activity uses workflow paths, not display names', () => {
  const workflows = [
    { file: 'photo.yml', name: 'Photo app', targets: ['build', 'deliver'] },
    { file: 'backup.yml', name: 'Backup', targets: ['build'] },
  ];
  assert.deepEqual(filterWorkflows(workflows, ' PHOTO deliver '), [workflows[0]]);
  assert.deepEqual(filterWorkflows(workflows, 'photo backup'), []);
  assert.deepEqual(filterWorkflows(workflows, ' '), workflows);
  const runs = [
    { id: 2, name: 'Photo app', path: '.github/workflows/backup.yml' },
    { id: 1, name: 'Old name', path: '.github/workflows/photo.yml@main', conclusion: 'success' },
  ];
  assert.equal(latestFor(workflows[0], runs).id, 1);
  assert.equal(latestFor(workflows[0], []), undefined);
  assert.equal(statusLabel(runs[1]).label, 'Passed');
  assert.equal(statusLabel({ status: 'in_progress', conclusion: null }).label, 'Running');
  assert.equal(statusLabel().tone, 'neutral');
  assert.equal(statusLabel({ conclusion: 'future_state' }).label, 'future state');
});
