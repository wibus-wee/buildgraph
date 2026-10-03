import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { pack, unpack } from '../src/index.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'buildgraph-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'output');
  await mkdir(directory);
  await writeFile(join(directory, 'hello'), 'private intermediate data\n');
  await chmod(join(directory, 'hello'), 0o755);
  return { root, directory, tempRoot: root, key: randomBytes(32).toString('hex'), context: 'run:manifest:producer' };
}

test('encrypted transfer round-trips content and executable permissions without leaving plaintext archives', async t => {
  const opts = await fixture(t);
  const archive = await pack(opts);
  const data = await readFile(archive);
  assert.equal(data.subarray(0, 4).toString(), 'BG01');
  assert.equal(data.includes(Buffer.from('private intermediate')), false);
  assert.deepEqual(await readdir(join(archive, '..')), ['output.bgenc']);
  const directory = join(opts.root, 'restored');
  await unpack({ ...opts, archive, directory });
  assert.equal(await readFile(join(directory, 'hello'), 'utf8'), 'private intermediate data\n');
  if (process.platform !== 'win32') assert.equal((await lstat(join(directory, 'hello'))).mode & 0o777, 0o755);
});

test('tampering, wrong key and substituted producer context fail before exposing a destination', async t => {
  const opts = await fixture(t);
  const archive = await pack(opts);
  for (const override of [{ key: randomBytes(32).toString('hex') }, { context: 'run:manifest:other-producer' }]) {
    const directory = join(opts.root, 'rejected');
    await assert.rejects(unpack({ ...opts, archive, directory, ...override }), /authentication failed/);
    await assert.rejects(lstat(directory), { code: 'ENOENT' });
  }
  const bytes = await readFile(archive);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(archive, bytes);
  await assert.rejects(unpack({ ...opts, archive, directory: join(opts.root, 'tampered') }), /authentication failed/);
  assert.equal((await readdir(opts.root)).some(name => name.startsWith('buildgraph-unpack-') || name.startsWith('.buildgraph-restore-')), false);
});

test('public output is a portable gzip archive and encrypted mode fails closed without a key', async t => {
  const opts = await fixture(t);
  await assert.rejects(pack({ ...opts, key: '' }), /hex key/);
  const archive = await pack({ ...opts, visibility: 'public', key: undefined });
  assert.deepEqual([...(await readFile(archive)).subarray(0, 2)], [0x1f, 0x8b]);
  await unpack({ archive, directory: join(opts.root, 'public'), visibility: 'public', tempRoot: opts.root });
  await assert.rejects(unpack({ archive, directory: join(opts.root, 'public'), visibility: 'public' }), /already exists/);
});

test('empty output, source metadata, and symlinks are not exported', async t => {
  const opts = await fixture(t);
  const empty = join(opts.root, 'empty');
  await mkdir(empty);
  await assert.rejects(pack({ ...opts, directory: empty }), /empty/);
  await mkdir(join(opts.directory, '.git'));
  await assert.rejects(pack(opts), /\.git/);
  await rm(join(opts.directory, '.git'), { recursive: true });
  if (process.platform !== 'win32') {
    await symlink('/etc/passwd', join(opts.directory, 'link'));
    await assert.rejects(pack(opts), /symbolic link/);
  }
});

test('unpack rejects archive traversal and links before extraction', async t => {
  const opts = await fixture(t);
  const malicious = join(opts.root, 'malicious.tar.gz');
  await tar.c({ cwd: opts.directory, file: malicious, gzip: true, prefix: '../escape' }, ['hello']);
  await assert.rejects(unpack({ archive: malicious, directory: join(opts.root, 'destination'), visibility: 'public', tempRoot: opts.root }), /unsafe path/);
  await assert.rejects(lstat(join(opts.root, 'escape')), { code: 'ENOENT' });
  if (process.platform !== 'win32') {
    await symlink('/etc/passwd', join(opts.directory, 'link'));
    await tar.c({ cwd: opts.directory, file: malicious, gzip: true }, ['link']);
    await assert.rejects(unpack({ archive: malicious, directory: join(opts.root, 'destination'), visibility: 'public', tempRoot: opts.root }), /unsupported entry type/);
  }
});
