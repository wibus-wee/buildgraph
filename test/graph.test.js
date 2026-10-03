import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { compile, plan, validate } from '../src/index.js';

const demo = JSON.parse(await readFile(new URL('../buildgraph.json', import.meta.url), 'utf8'));
const copy = () => structuredClone(demo);

test('diamond target includes prerequisites once and excludes unrelated nodes', () => {
  const result = plan(demo, { target: 'bundle' });
  assert.deepEqual(result.selected, ['core', 'web', 'cli', 'bundle']);
  assert.deepEqual(plan(demo, { target: 'cli,web,cli' }).selected, ['core', 'cli', 'web']);
  assert.deepEqual(plan(demo, { target: 'independent' }).selected, ['independent']);
});

test('rejects cycles even in an unselected branch, and reports the cycle', () => {
  const graph = copy();
  graph.nodes.core.needs = ['bundle'];
  assert.throws(() => plan(graph, { target: 'independent' }), /core -> bundle -> web -> core/);
});

test('rejects dangling dependencies, unknown targets, and misspelled fields', () => {
  const graph = copy();
  graph.nodes.cli.needs = ['missing'];
  assert.throws(() => validate(graph), /cli: unknown dependency missing/);
  assert.throws(() => plan(demo, { target: 'missing' }), /Unknown target/);
  assert.throws(() => plan(demo, { target: ', ' }), /at least one/);
  const typo = copy();
  typo.nodes.core.need = ['web'];
  assert.throws(() => validate(typo), /additional properties \(need\)/);
});

test('source overrides cannot redirect repositories, execute expressions, or affect unrelated nodes', () => {
  const graph = copy();
  graph.nodes.core.source = { repository: 'owner/private-core', ref: 'main' };
  graph.nodes.independent.source = { repository: 'owner/private-tool', ref: 'main' };
  const sha = 'a'.repeat(40);
  assert.deepEqual(plan(graph, { refs: { core: sha } }).refs, { core: sha });
  for (const refs of [{ core: '${{ secrets.X }}' }, { core: 'x\ny' }, { bundle: 'main' }, { independent: 'main' }, []]) {
    assert.throws(() => plan(graph, { refs }));
  }
  assert.equal(graph.nodes.core.source.ref, 'main');
});

test('compiler emits native needs, dispatch-only entry, scoped selection and artifact IDs', () => {
  const workflow = parse(compile(demo));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.jobs.bundle.needs, ['plan', 'web', 'cli']);
  assert.deepEqual(workflow.jobs.web.needs, ['plan', 'core']);
  assert.match(workflow.jobs.core.if, /contains\(fromJSON\(needs.plan.outputs.selected\), 'core'\)/);
  assert.doesNotMatch(workflow.jobs.core.if, /always\(/);
  const downloads = workflow.jobs.bundle.steps.filter(s => s.name.startsWith('Download'));
  assert.equal(downloads[0].with['artifact-ids'], '${{ needs.web.outputs.artifact_id }}');
  assert.equal(downloads[0].with['digest-mismatch'], 'error');
  assert.equal(workflow.jobs.core.steps.find(s => s.id === 'bg_pack').with.visibility, 'encrypted');
  assert.equal(workflow.jobs.bundle.steps.find(s => s.id === 'bg_pack').with.visibility, 'public');
  assert.equal(workflow.jobs.bundle.steps.find(s => s.id === 'bg_pack').with.key, undefined);
});

test('App auth grants one source repository read access; shared env can be overridden per node', () => {
  const graph = copy();
  graph.defaults.auth = 'sources';
  graph.auth = { sources: { type: 'app', clientIdVariable: 'SOURCE_APP_ID', privateKeySecret: 'SOURCE_APP_KEY' } };
  graph.nodes.core.source = { repository: 'team/core', ref: 'main' };
  graph.nodes.core.env = { BUILD_FLAVOR: 'release' };
  const workflow = parse(compile(graph));
  const steps = workflow.jobs.core.steps;
  const token = steps.find(s => s.id === 'bg_source_token');
  assert.equal(token.with.owner, 'team');
  assert.equal(token.with.repositories, 'core');
  assert.equal(token.with['permission-contents'], 'read');
  assert.match(token.uses, /^actions\/create-github-app-token@[a-f0-9]{40}$/);
  assert.equal(steps.find(s => s.name === 'Checkout source').with['persist-credentials'], false);
  assert.equal(workflow.jobs.core.env.BUILD_FLAVOR, 'release');
  assert.equal(workflow.jobs.web.env.BUILD_FLAVOR, 'demo');
  assert.equal(workflow.jobs.plan.env, undefined);
});

test('PAT authentication is explicit and external toolkit references must be immutable', () => {
  const graph = copy();
  graph.auth = { sources: { type: 'token', tokenSecret: 'SOURCE_READ_TOKEN' } };
  graph.nodes.core.source = { repository: 'team/core', ref: 'v1', auth: 'sources' };
  const workflow = parse(compile(graph, { actionRef: `owner/buildgraph@${'a'.repeat(40)}` }));
  assert.equal(workflow.jobs.core.steps.find(s => s.name === 'Checkout source').with.token, '${{ secrets.SOURCE_READ_TOKEN }}');
  assert.throws(() => compile(graph, { actionRef: 'owner/buildgraph@main' }), /commit SHA/);
  assert.throws(() => compile(graph, { manifestPath: '../private.json' }), /relative JSON path/);
});

test('reserved identifiers and environment variables cannot collide with compiler internals', () => {
  for (const name of ['plan', 'bg_internal']) {
    const graph = copy();
    graph.nodes[name] = { steps: [{ run: 'true' }] };
    assert.throws(() => validate(graph), /Reserved node/);
  }
  const graph = copy();
  graph.defaults.env.BUILDGRAPH_OUTPUT = '/tmp/wrong';
  assert.throws(() => validate(graph), /reserved environment variable/);
  delete graph.defaults.env.BUILDGRAPH_OUTPUT;
  graph.nodes.core.source = { repository: 'team/core', ref: 'main', auth: 'missing' };
  assert.throws(() => validate(graph), /unknown auth profile/);
});
