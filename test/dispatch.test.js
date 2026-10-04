import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, dispatchInputs, waitForRun } from '../src/dispatch.js';
import { githubApi } from '../src/github.js';

test('native YAML dispatch inputs preserve booleans and reject ambiguous or nested values', () => {
  assert.deepEqual(dispatchInputs('target: site\npreview: false\nattempt: 2\nref: "on"'), {
    target: 'site',
    preview: false,
    attempt: 2,
    ref: 'on',
  });
  for (const source of ['a: 1\na: 2', '[a,b]', 'a: [1,2]', 'a: null', 'a: .inf', 'text'])
    assert.throws(() => dispatchInputs(source));
  assert.deepEqual(dispatchInputs(''), {});
});

test('dispatch returns the exact API run ID; it never discovers latest or retries a POST', async () => {
  const calls = [];
  const api = async (...args) => {
    calls.push(args);
    return { workflow_run_id: 123 };
  };
  const options = {
    repository: 'org/distribution',
    workflow: 'publish.yml',
    ref: 'main',
    inputs: 'request_id: "123"',
    api,
  };
  assert.deepEqual(await dispatch(options), {
    runId: 123,
    url: 'https://github.com/org/distribution/actions/runs/123',
  });
  assert.deepEqual(calls[0], [
    '/repos/org/distribution/actions/workflows/publish.yml/dispatches',
    { method: 'POST', body: { ref: 'main', inputs: { request_id: '123' } } },
  ]);
  await assert.rejects(dispatch({ ...options, api: async () => null }), /inspect the target/);
  await assert.rejects(dispatch({ ...options, repository: 'org/repo/else' }), /owner\/name/);
  await assert.rejects(dispatch({ ...options, inputs: 'bad: [nested]' }));
  assert.equal(calls.length, 1);
});

test('wait observes only the dispatched run, returns failure conclusions and bounds waiting', async () => {
  let time = 0;
  let calls = 0;
  const options = {
    repository: 'org/repo',
    runId: 123,
    timeoutSeconds: 2,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  };
  assert.equal(
    await waitForRun({
      ...options,
      api: async () => ({ id: 123, status: 'completed', conclusion: 'failure' }),
    }),
    'failure',
  );
  await assert.rejects(
    waitForRun({
      ...options,
      api: async (path) => {
        calls++;
        assert.ok(path.endsWith('/123'));
        return { id: 123, status: 'queued' };
      },
    }),
    /not cancelled/,
  );
  assert.equal(calls, 1);
  await assert.rejects(waitForRun({ ...options, api: async () => ({ id: 999 }) }), /different run/);
});

test('API errors omit echoed credentials and inputs; redirects and requests are bounded', async () => {
  let calls = 0;
  const api = githubApi('secret', async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.github.com/repos/org/repo');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-GitHub-Api-Version'], '2026-03-10');
    return { ok: false, status: 403, text: () => 'secret' };
  });
  await assert.rejects(
    api('/repos/org/repo', { method: 'POST', body: {} }),
    (error) => !error.message.includes('secret') && error.message.includes('403'),
  );
  assert.equal(calls, 1);
});
