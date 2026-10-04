import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { upload, download } from '../src/transfer.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bg-transfer-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'source');
  await mkdir(directory);
  await writeFile(join(directory, 'result.txt'), 'private build result');
  const stored = [];
  const client = {
    async uploadArtifact(name, files, archiveRoot, options) {
      assert.equal(options.compressionLevel, 0);
      const bytes = await readFile(files[0]);
      const digest = createHash('sha256').update(bytes).digest('hex');
      const item = { id: stored.length + 1, name, digest: `sha256:${digest}`, bytes, file: basename(files[0]) };
      stored.push(item);
      return { id: item.id, digest };
    },
    async listArtifacts() { return { artifacts: stored }; },
    async downloadArtifact(id, { path, expectedHash }) {
      const item = stored.find(item => item.id === id);
      await writeFile(join(path, item.file), item.bytes);
      assert.match(expectedHash, /^sha256:[a-f0-9]{64}$/);
      return { digestMismatch: `sha256:${createHash('sha256').update(item.bytes).digest('hex')}` !== expectedHash };
    },
  };
  return { client, directory, tempRoot: root, stored, key: randomBytes(32).toString('hex'), env: {
    GITHUB_REPOSITORY: 'owner/hub', GITHUB_RUN_ID: '100', GITHUB_SHA: 'abc', GITHUB_JOB: 'core', GITHUB_RUN_ATTEMPT: '1',
  } };
}

test('encrypted transfer needs only ID, destination and key, including downstream-only reruns', async t => {
  const f = await fixture(t);
  const first = await upload(f);
  const second = await upload(f);
  assert.notEqual(first.name, second.name);
  assert.equal(f.stored[0].bytes.includes(Buffer.from('private build result')), false);
  const directory = join(f.tempRoot, 'restored');
  await download({ ...f, artifactId: first.id, directory, env: { ...f.env, GITHUB_JOB: 'web', GITHUB_RUN_ATTEMPT: '2' } });
  assert.equal(await readFile(join(directory, 'result.txt'), 'utf8'), 'private build result');
  assert.deepEqual((await readdir(f.tempRoot)).sort(), ['restored', 'source']);
});

test('digest mismatch, ciphertext context substitution and missing metadata fail before restore', async t => {
  const f = await fixture(t);
  const { id } = await upload(f);
  const directory = join(f.tempRoot, 'restored');
  const options = { ...f, directory, artifactId: id };
  const original = f.stored[0].digest;
  f.stored[0].digest = '0'.repeat(64);
  await assert.rejects(download(options), /digest verification failed/);
  f.stored[0].digest = original;
  for (const change of [{ GITHUB_RUN_ID: '101' }, { GITHUB_SHA: 'other' }, { GITHUB_REPOSITORY: 'other/hub' }]) {
    await assert.rejects(download({ ...options, env: { ...f.env, ...change } }), /authentication failed/);
  }
  f.stored[0].name += '-substituted';
  await assert.rejects(download(options), /authentication failed/);
  delete f.stored[0].digest;
  await assert.rejects(download(options), /no valid SHA-256 digest/);
  await assert.rejects(download({ ...options, artifactId: 999 }), /not found in this run/);
  await assert.rejects(access(directory));
  assert.deepEqual(await readdir(f.tempRoot), ['source']);
});

test('public mode is explicit at both ends and preserves absent-destination rules', async t => {
  const f = await fixture(t);
  const { id } = await upload({ ...f, visibility: 'public', key: undefined });
  const directory = join(f.tempRoot, 'restored');
  await assert.rejects(download({ ...f, artifactId: id, directory }), /ENOENT/);
  await download({ ...f, artifactId: id, directory, visibility: 'public', key: undefined });
  await assert.rejects(download({ ...f, artifactId: id, directory, visibility: 'public' }), /already exists/);
  assert.equal(await readFile(join(directory, 'result.txt'), 'utf8'), 'private build result');
});

test('bad inputs fail before network calls and failed uploads clean their archives', async t => {
  const f = await fixture(t);
  await assert.rejects(upload({ ...f, key: '' }), /64-character/);
  await assert.rejects(upload({ ...f, retentionDays: -1 }), /retention-days/);
  for (const artifactId of ['', '1,2', 0, -1, '1.5', '9007199254740992']) {
    await assert.rejects(download({ ...f, artifactId }), /one positive integer/);
  }
  assert.equal(f.stored.length, 0);
  await assert.rejects(upload({ ...f, client: { async uploadArtifact() { throw new Error('service failed'); } } }), /service failed/);
  assert.deepEqual(await readdir(f.tempRoot), ['source']);
});
