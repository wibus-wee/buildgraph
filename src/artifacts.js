import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';

const magic = Buffer.from('BG01');
const headerSize = 32; // BG01, 12-byte nonce, 16-byte GCM authentication tag.

function decodeKey(key, context) {
  if (!/^[a-fA-F0-9]{64}$/.test(key ?? '')) throw new Error('Encrypted artifacts require a 64-character hex key in BUILDGRAPH_ARTIFACT_KEY (or the configured secret)');
  if (typeof context !== 'string' || !context) throw new Error('Encrypted artifacts require a nonempty context identifying the run, manifest, and producer');
  return Buffer.from(key, 'hex');
}

function checkVisibility(visibility) {
  if (!['public', 'encrypted'].includes(visibility)) throw new Error('visibility must be encrypted or public');
}

async function inspectTree(directory) {
  let files = 0;
  async function visit(path) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Output contains a symbolic link: ${relative(directory, path)}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (name === '.git') throw new Error('Output must not contain a .git directory');
        await visit(join(path, name));
      }
    } else if (stat.isFile()) files++;
    else throw new Error(`Output contains a non-regular file: ${relative(directory, path)}`);
  }
  if (!(await lstat(directory)).isDirectory()) throw new Error('Output must be a directory');
  await visit(directory);
  if (!files) throw new Error('Output directory is empty; write the node result to BUILDGRAPH_OUTPUT');
}

/** Packages only the explicit output directory. Encrypted mode never returns or uploads a plaintext archive. */
export async function pack({ directory, visibility = 'encrypted', key, context, tempRoot = tmpdir() }) {
  checkVisibility(visibility);
  const secret = visibility === 'encrypted' ? decodeKey(key, context) : undefined;
  directory = resolve(directory);
  await inspectTree(directory);
  const scratch = await mkdtemp(join(tempRoot, 'buildgraph-pack-'));
  const plain = join(scratch, 'output.tar.gz');
  try {
    await tar.c({ file: plain, cwd: directory, gzip: true, portable: true, mtime: new Date(0), strict: true }, ['.']);
    if (visibility === 'public') return plain;
    const archive = join(scratch, 'output.bgenc');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', secret, nonce);
    cipher.setAAD(Buffer.concat([magic, Buffer.from(context)]));
    await writeFile(archive, Buffer.concat([magic, nonce, Buffer.alloc(16)]), { flag: 'wx', mode: 0o600 });
    await pipeline(createReadStream(plain), cipher, createWriteStream(archive, { flags: 'a' }));
    const handle = await open(archive, 'r+');
    try { await handle.write(cipher.getAuthTag(), 0, 16, 16); } finally { await handle.close(); }
    await rm(plain);
    return archive;
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}

async function inspectArchive(file) {
  let invalid;
  await tar.t({ file, strict: true, onReadEntry(entry) {
    const path = entry.path;
    if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || /[\\\x00-\x1f]/.test(path) || path.split('/').includes('..')) invalid = 'Artifact contains an unsafe path';
    if (!['File', 'OldFile', 'Directory'].includes(entry.type)) invalid = `Artifact contains an unsupported entry type: ${entry.type}`;
    if (path.split('/').includes('.git')) invalid = 'Artifact contains a .git directory';
  } });
  if (invalid) throw new Error(invalid);
}

/** Authenticates before extraction. Destination must be absent; a failed restore leaves it absent. */
export async function unpack({ archive, directory, visibility = 'encrypted', key, context, tempRoot = tmpdir() }) {
  checkVisibility(visibility);
  const secret = visibility === 'encrypted' ? decodeKey(key, context) : undefined;
  directory = resolve(directory);
  await mkdir(dirname(directory), { recursive: true });
  directory = join(await realpath(dirname(directory)), basename(directory));
  try {
    await lstat(directory);
    throw new Error(`Artifact destination already exists: ${basename(directory)}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const scratch = await mkdtemp(join(tempRoot, 'buildgraph-unpack-'));
  const stage = await mkdtemp(join(dirname(directory), '.buildgraph-restore-'));
  try {
    let plain = resolve(archive);
    if (visibility === 'encrypted') {
      const header = Buffer.alloc(headerSize);
      const handle = await open(archive, 'r');
      let bytesRead;
      try { ({ bytesRead } = await handle.read(header, 0, headerSize, 0)); } finally { await handle.close(); }
      if (bytesRead !== headerSize || !header.subarray(0, 4).equals(magic)) throw new Error('Invalid encrypted artifact header');
      const decipher = createDecipheriv('aes-256-gcm', secret, header.subarray(4, 16));
      decipher.setAuthTag(header.subarray(16, 32));
      decipher.setAAD(Buffer.concat([magic, Buffer.from(context)]));
      plain = join(scratch, 'output.tar.gz');
      try {
        await pipeline(createReadStream(archive, { start: headerSize }), decipher, createWriteStream(plain, { flags: 'wx', mode: 0o600 }));
      } catch {
        throw new Error('Artifact authentication failed: wrong key/context or damaged ciphertext');
      }
    }
    await inspectArchive(plain);
    await tar.x({ file: plain, cwd: stage, strict: true, preservePaths: false });
    await rename(stage, directory);
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await rm(stage, { recursive: true, force: true });
  }
  return directory;
}
