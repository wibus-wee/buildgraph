import test from 'node:test';
import assert from 'node:assert/strict';
import { dependencies, order, parseWorkflow, plan, readWorkflow, validate } from '../src/index.js';

const demo = await readWorkflow('.github/workflows/build.yml');
const copy = () => structuredClone(demo);

test('reads native jobs/needs and selects a diamond without the planner or unrelated jobs', () => {
  assert.deepEqual(plan(demo).selected, ['core', 'web', 'cli', 'bundle']);
  assert.deepEqual(plan(demo, { target: 'cli,web,cli' }).selected, ['core', 'cli', 'web']);
  assert.deepEqual(plan(demo, { target: 'independent' }).selected, ['independent']);
  assert.deepEqual(dependencies(demo, 'core'), ['plan']);
  assert.deepEqual(dependencies(demo, 'bundle'), ['plan', 'web', 'cli']);
  assert.equal(order(demo)[0], 'plan');
});

test('rejects cycles even in an unselected branch', () => {
  const workflow = copy();
  workflow.jobs.core.needs = ['plan', 'bundle'];
  assert.throws(() => plan(workflow, { target: 'independent' }), /core -> bundle -> web -> core/);
});

test('rejects missing jobs, unknown targets, invalid needs, and dependency duplicates', () => {
  const workflow = copy();
  workflow.jobs.cli.needs = ['missing'];
  assert.throws(() => validate(workflow), /cli: unknown dependency missing/);
  assert.throws(() => plan(demo, { target: 'missing' }), /Unknown target job/);
  assert.throws(() => plan(demo, { target: ', ' }), /at least one/);
  for (const needs of [null, 4, {}, ['core', 7]]) {
    workflow.jobs.cli.needs = needs;
    assert.throws(() => validate(workflow), /needs must be/);
  }
  workflow.jobs.cli.needs = ['core', 'core'];
  assert.throws(() => validate(workflow), /duplicate dependency/);
});

test('YAML 1.2 preserves on and resolves native anchors without changing block scripts', () => {
  const workflow = parseWorkflow(`
on:
  workflow_dispatch:
    inputs:
      target:
        default: consumer
jobs:
  shared:
    steps: &steps
      - run: |
          echo first
          echo second
  consumer:
    needs: shared
    steps: *steps
`);
  assert.deepEqual(plan(workflow).selected, ['shared', 'consumer']);
  assert.equal(workflow.jobs.consumer.steps[0].run, 'echo first\necho second\n');
});

test('duplicate YAML keys fail instead of hiding part of the build graph', () => {
  assert.throws(() => parseWorkflow('jobs:\n  core: {}\n  core: {}\n'), /Invalid workflow YAML/);
  assert.throws(() => parseWorkflow('jobs: ['), /Invalid workflow YAML/);
});

test('native matrices, reusable workflow jobs, and expressions remain GitHub-owned', () => {
  const workflow = parseWorkflow(`
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - run: echo ready
  build-matrix:
    needs: setup
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
    runs-on: \${{ matrix.os }}
    steps:
      - run: echo build
  Ship:
    needs: build-matrix
    uses: ./.github/workflows/release.yml
    secrets: inherit
`);
  assert.deepEqual(plan(workflow, { target: 'Ship' }).selected, ['setup', 'build-matrix', 'Ship']);
  assert.equal(workflow.jobs['build-matrix']['runs-on'], '${{ matrix.os }}');
});

test('planner job can be renamed but cannot be a target or have prerequisites', () => {
  const workflow = parseWorkflow('jobs:\n  choose: {}\n  build:\n    needs: choose\n');
  assert.deepEqual(plan(workflow, { target: 'build', plannerJob: 'choose' }).selected, ['build']);
  assert.throws(() => plan(workflow, { target: 'choose', plannerJob: 'choose' }), /cannot be a build target/);
  const graph = copy();
  graph.jobs.preflight = { steps: [{ run: 'true' }] };
  graph.jobs.plan.needs = 'preflight';
  assert.throws(() => plan(graph), /must not depend/);
});

test('default target is optional when a caller supplies an explicit target', () => {
  const workflow = parseWorkflow('jobs:\n  build: {}\n');
  assert.throws(() => plan(workflow), /Provide target job IDs/);
  assert.deepEqual(plan(workflow, { target: 'build' }).selected, ['build']);
});

test('native demo keeps fail propagation and artifact IDs in visible workflow YAML', () => {
  assert.deepEqual(Object.keys(demo.on), ['workflow_dispatch']);
  assert.doesNotMatch(demo.jobs.core.if, /always\(/);
  const download = demo.jobs.bundle.steps.find(s => s.name === 'Download web');
  assert.equal(download.with['artifact-ids'], '${{ needs.web.outputs.artifact_id }}');
  assert.equal(download.with['digest-mismatch'], 'error');
  assert.equal(demo.jobs.core.steps.find(s => s.id === 'pack').with.key, '${{ secrets.BUILDGRAPH_ARTIFACT_KEY }}');
  assert.equal(demo.jobs.bundle.steps.find(s => s.id === 'pack').with.visibility, 'public');
  assert.equal(demo.jobs.bundle.steps.find(s => s.id === 'pack').with.key, undefined);
});
