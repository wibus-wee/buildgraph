import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pack, unpack } from './artifacts.js';

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

/** Downloads one immutable ID from this run, checks its digest, then restores an absent destination. */
export async function download({ client, artifactId, directory, visibility = 'encrypted', key, env = process.env, tempRoot = tmpdir() }) {
  checkOptions(visibility, key);
  if (!/^[1-9][0-9]*$/.test(String(artifactId)) || !Number.isSafeInteger(Number(artifactId))) throw new Error('artifact-id must be one positive integer; pass the upstream job output');
  const id = Number(artifactId);
  const { artifacts } = await client.listArtifacts();
  const artifact = artifacts.find(item => item.id === id);
  if (!artifact) throw new Error(`Artifact ${id} was not found in this run; rebuild its producer if it expired`);
  const context = contextFor(env, artifact.name);
  const digest = artifact.digest?.replace(/^sha256:/, '');
  if (!/^[a-fA-F0-9]{64}$/.test(digest ?? '')) throw new Error(`Artifact ${id} has no valid SHA-256 digest`);
  // Artifact SDK 6 compares the algorithm-prefixed digest, not the bare upload hash.
  const expectedHash = `sha256:${digest.toLowerCase()}`;
  const scratch = await mkdtemp(join(tempRoot, 'buildgraph-download-'));
  try {
    const result = await client.downloadArtifact(id, { path: scratch, expectedHash });
    if (result.digestMismatch !== false) throw new Error(`Artifact ${id} digest verification failed`);
    const archive = join(scratch, visibility === 'encrypted' ? 'output.bgenc' : 'output.tar.gz');
    return await unpack({ archive, directory, visibility, key, context, tempRoot });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
