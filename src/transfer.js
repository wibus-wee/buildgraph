import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pack, unpack } from './artifacts.js';
import { githubApi, positiveId, repositoryPath } from './github.js';

function contextFor(env, name) {
  for (const field of ['GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_SHA']) {
    if (!env[field]) throw new Error(`Missing ${field}; artifact transfers must run inside GitHub Actions`);
  }
  // Attempt belongs to the artifact name, so a rerun can consume an earlier producer's output.
  return JSON.stringify(['buildgraph-transfer-v1', env.GITHUB_REPOSITORY, env.GITHUB_RUN_ID, env.GITHUB_SHA, name]);
}

function checkOptions(visibility, key) {
  if (!['encrypted', 'public'].includes(visibility)) throw new Error('visibility must be encrypted or public');
  if (visibility === 'encrypted' && !/^[a-fA-F0-9]{64}$/.test(key ?? '')) throw new Error('Encrypted artifacts require a 64-character hex key; pass secrets.BUILDGRAPH_ARTIFACT_KEY as key');
}

/** Uploads one directory; scratch archives are removed even when the service fails. */
export async function upload({ client, directory, visibility = 'encrypted', key, retentionDays = 7, env = process.env, tempRoot = tmpdir() }) {
  checkOptions(visibility, key);
  if (!Number.isInteger(retentionDays) || retentionDays < 0) throw new Error('retention-days must be a nonnegative integer');
  if (!env.GITHUB_JOB || !env.GITHUB_RUN_ATTEMPT) throw new Error('Missing GitHub job or run attempt');
  const name = `bg-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${env.GITHUB_JOB}-${randomUUID()}`;
  const context = contextFor(env, name);
  const archive = await pack({ directory, visibility, key, context, tempRoot });
  try {
    const result = await client.uploadArtifact(name, [archive], dirname(archive), { retentionDays, compressionLevel: 0 });
    if (!Number.isSafeInteger(result.id) || result.id <= 0) throw new Error('Artifact service did not return an artifact ID');
    return { ...result, name };
  } finally {
    await rm(dirname(archive), { recursive: true, force: true });
  }
}

/** Cross-run consumers pin a trusted workflow and branch, then authenticate with producer metadata. */
async function remoteArtifact({ repository, runId, workflow, branch, token, api = githubApi(token) }, id) {
  const base = repositoryPath(repository);
  positiveId(runId, 'source-run-id');
  if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow ?? '')) throw new Error('source-workflow must be .github/workflows/<filename>.yml');
  if (!branch || typeof branch !== 'string') throw new Error('source-branch must be a trusted branch name');
  const run = await api(`${base}/actions/runs/${runId}`);
  if (run.id !== Number(runId) || run.path !== workflow || run.head_branch !== branch || run.event !== 'workflow_dispatch' || !/^[a-f0-9]{40}$/.test(run.head_sha ?? '') || run.head_repository?.full_name?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('Source run does not match the trusted repository, workflow, branch, and workflow_dispatch event');
  }
  const artifact = await api(`${base}/actions/artifacts/${id}`);
  if (artifact.id !== id || artifact.expired || artifact.workflow_run?.id !== Number(runId) || artifact.workflow_run?.head_sha !== run.head_sha) throw new Error('Artifact does not belong to the source run or has expired');
  const [repositoryOwner, repositoryName] = repository.split('/');
  return { artifact, env: { GITHUB_REPOSITORY: run.head_repository.full_name, GITHUB_RUN_ID: String(run.id), GITHUB_SHA: run.head_sha }, findBy: { repositoryOwner, repositoryName, workflowRunId: Number(runId), token } };
}

/** Downloads one immutable ID, checks its digest, then restores an absent destination. */
export async function download({ client, artifactId, directory, visibility = 'encrypted', key, source, expectedDigest, env = process.env, tempRoot = tmpdir() }) {
  checkOptions(visibility, key);
  if (!/^[1-9][0-9]*$/.test(String(artifactId)) || !Number.isSafeInteger(Number(artifactId))) throw new Error('artifact-id must be one positive integer; pass the upstream job output');
  const id = Number(artifactId);
  const remote = source ? await remoteArtifact(source, id) : undefined;
  const artifact = remote?.artifact ?? (await client.listArtifacts()).artifacts.find(item => item.id === id);
  if (!artifact) throw new Error(`Artifact ${id} was not found in this run; rebuild its producer if it expired`);
  const context = contextFor(remote?.env ?? env, artifact.name);
  const digest = artifact.digest?.replace(/^sha256:/, '');
  if (!/^[a-fA-F0-9]{64}$/.test(digest ?? '')) throw new Error(`Artifact ${id} has no valid SHA-256 digest`);
  if (expectedDigest && expectedDigest.replace(/^sha256:/, '').toLowerCase() !== digest.toLowerCase()) throw new Error('Artifact digest does not match expected-digest');
  // Artifact SDK 6 compares the algorithm-prefixed digest, not the bare upload hash.
  const expectedHash = `sha256:${digest.toLowerCase()}`;
  const scratch = await mkdtemp(join(tempRoot, 'buildgraph-download-'));
  try {
    const result = await client.downloadArtifact(id, { path: scratch, expectedHash, ...(remote ? { findBy: remote.findBy } : {}) });
    if (result.digestMismatch !== false) throw new Error(`Artifact ${id} digest verification failed`);
    const archive = join(scratch, visibility === 'encrypted' ? 'output.bgenc' : 'output.tar.gz');
    return await unpack({ archive, directory, visibility, key, context, tempRoot });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
