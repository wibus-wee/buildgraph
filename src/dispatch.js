import { parseDocument } from 'yaml';
import { githubApi, positiveId, repositoryPath } from './github.js';

/** A YAML mapping of native workflow inputs, not a separate workflow schema. */
export function dispatchInputs(source = '') {
  const doc = parseDocument(source, { version: '1.2' });
  if (doc.errors.length) throw new Error('inputs must be valid YAML with unique keys');
  const inputs = doc.toJS({ maxAliasCount: 20 }) ?? {};
  if (!inputs || Array.isArray(inputs) || typeof inputs !== 'object' || Object.keys(inputs).length > 25)
    throw new Error('inputs must be a YAML mapping of at most 25 scalar values');
  for (const [name, value] of Object.entries(inputs)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) ||
      !['string', 'boolean', 'number'].includes(typeof value) ||
      (typeof value === 'number' && !Number.isFinite(value))
    ) {
      throw new Error('inputs must contain named string, boolean, or finite number values');
    }
  }
  return inputs;
}

export async function dispatch({ repository, workflow, ref, inputs = '', token, api = githubApi(token) }) {
  const base = repositoryPath(repository);
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow))
    throw new Error('workflow must be a .yml or .yaml filename');
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('ref must name a target branch or tag');
  const result = await api(`${base}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
    method: 'POST',
    body: { ref, inputs: dispatchInputs(inputs) },
  });
  if (!result?.workflow_run_id)
    throw new Error(
      'GitHub accepted dispatch without a run ID; inspect the target Actions page before retrying',
    );
  const runId = positiveId(result.workflow_run_id, 'workflow_run_id');
  return { runId, url: `https://github.com/${repository}/actions/runs/${runId}` };
}

/** Waits for this exact run. A timeout does not cancel the remote run. */
export async function waitForRun({
  repository,
  runId,
  token,
  timeoutSeconds = 1800,
  api = githubApi(token),
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const base = repositoryPath(repository);
  positiveId(runId, 'run-id');
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 21600)
    throw new Error('timeout-seconds must be an integer between 1 and 21600');
  const deadline = now() + timeoutSeconds * 1000;
  while (now() < deadline) {
    const run = await api(`${base}/actions/runs/${runId}`);
    if (run.id !== Number(runId)) throw new Error('GitHub returned a different run');
    if (run.status === 'completed') return run.conclusion;
    await sleep(Math.min(10_000, Math.max(0, deadline - now())));
  }
  throw new Error(`Timed out waiting for run ${runId}; it was not cancelled. Inspect it before retrying`);
}
