import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { objectPath } from './journal-catalog.js';
import { RecoveryPrimitiveError } from './errors.js';
import {
  assertAbsolutePathInWorkspace,
  resolveWorkspacePath,
} from '../workspace/path-safety.js';

export const normalizeResourceId = (value) => String(value || '')
  .replace(/\\/g, '/')
  .replace(/^\.\//, '')
  .replace(/\/+/g, '/');

export const stateIdentity = (state) => JSON.stringify({
  byteLength: state.byteLength ?? null,
  kind: state.kind,
  mode: state.mode ?? null,
  objectHash: state.objectHash ?? null,
  symlinkTarget: state.symlinkTarget ?? null,
});

export const sameState = (left, right) => stateIdentity(left) === stateIdentity(right);

const statStable = (before, after) => (
  before.dev === after.dev
  && before.ino === after.ino
  && before.mode === after.mode
  && before.size === after.size
  && before.mtimeMs === after.mtimeMs
);

const pathInside = (candidate, root, pathModule) => {
  const relative = pathModule.relative(root, candidate);
  return relative && relative !== '.' && !relative.startsWith('..') && !pathModule.isAbsolute(relative);
};

export const createRecoveryFileStore = ({ fsModule = fs, fsPromises = fs.promises, pathModule = path } = {}) => {
  const relativePathFor = async (identity, inputPath) => {
    const absolute = pathModule.isAbsolute(inputPath)
      ? pathModule.resolve(inputPath)
      : pathModule.resolve(identity.canonicalRoot, inputPath);
    if (!pathInside(absolute, identity.canonicalRoot, pathModule)) {
      throw new RecoveryPrimitiveError('workspace-untrusted', `Recovery path is outside the workspace: ${inputPath}`);
    }
    const relative = normalizeResourceId(pathModule.relative(identity.canonicalRoot, absolute));
    if (!relative || relative === '.' || relative.split('/').includes('..')) {
      throw new RecoveryPrimitiveError('workspace-untrusted', `Recovery path is invalid: ${inputPath}`);
    }
    const contained = pathModule.isAbsolute(inputPath)
      ? await assertAbsolutePathInWorkspace(absolute, {
          allowMissing: true,
          fsPromises,
          pathModule,
          root: identity.canonicalRoot,
        })
      : await resolveWorkspacePath(relative, {
          allowMissing: true,
          fsPromises,
          pathModule,
          root: identity.canonicalRoot,
        });
    return { absolute: contained.absolutePath, relative };
  };

  const hashFile = async (filePath) => {
    const hash = createHash('sha256');
    let byteLength = 0;
    for await (const chunk of fsModule.createReadStream(filePath)) {
      hash.update(chunk);
      byteLength += chunk.length;
    }
    return { byteLength, objectHash: `sha256-${hash.digest('hex')}` };
  };

  const captureRegularFile = async (filePath, root, beforeStat, store) => {
    if (!store) {
      const hashed = await hashFile(filePath);
      const afterStat = await fsPromises.lstat(filePath);
      if (!statStable(beforeStat, afterStat)) {
        throw new RecoveryPrimitiveError('checkpoint-incomplete', `File changed while it was being recorded: ${filePath}`, { retryable: true });
      }
      return { ...hashed, kind: 'regular-file', mode: beforeStat.mode & 0o7777 };
    }
    const staging = pathModule.join(root, 'staging', `${randomUUID()}.object`);
    await fsPromises.mkdir(pathModule.dirname(staging), { recursive: true, mode: 0o700 });
    const hash = createHash('sha256');
    let byteLength = 0;
    let handle;
    try {
      handle = await fsPromises.open(staging, 'wx', 0o600);
      for await (const chunk of fsModule.createReadStream(filePath)) {
        hash.update(chunk);
        byteLength += chunk.length;
        await handle.write(chunk);
      }
      await handle.sync();
      await handle.close();
      handle = null;
      const afterStat = await fsPromises.lstat(filePath);
      if (!statStable(beforeStat, afterStat)) {
        throw new RecoveryPrimitiveError('checkpoint-incomplete', `File changed while it was being recorded: ${filePath}`, { retryable: true });
      }
      const objectHash = `sha256-${hash.digest('hex')}`;
      const target = objectPath(root, objectHash);
      await fsPromises.mkdir(pathModule.dirname(target), { recursive: true, mode: 0o700 });
      try {
        await fsPromises.lstat(target);
        await fsPromises.rm(staging, { force: true });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await fsPromises.rename(staging, target);
      }
      return { byteLength, kind: 'regular-file', mode: beforeStat.mode & 0o7777, objectHash };
    } finally {
      await handle?.close().catch(() => undefined);
      await fsPromises.rm(staging, { force: true }).catch(() => undefined);
    }
  };

  const captureState = async (identity, root, inputPath, { store = true } = {}) => {
    const resolved = await relativePathFor(identity, inputPath);
    let stat;
    try {
      stat = await fsPromises.lstat(resolved.absolute);
    } catch (error) {
      if (error?.code === 'ENOENT') return { path: resolved.relative, state: { kind: 'missing' } };
      throw error;
    }
    if (stat.isSymbolicLink()) {
      return {
        path: resolved.relative,
        state: {
          kind: 'symlink',
          mode: stat.mode & 0o7777,
          symlinkTarget: await fsPromises.readlink(resolved.absolute),
        },
      };
    }
    if (stat.isDirectory()) {
      return { path: resolved.relative, state: { kind: 'directory', mode: stat.mode & 0o7777 } };
    }
    if (!stat.isFile()) return { path: resolved.relative, state: { kind: 'unsupported' } };
    return { path: resolved.relative, state: await captureRegularFile(resolved.absolute, root, stat, store) };
  };

  const verifyObject = async (root, state) => {
    if (state.kind !== 'regular-file' || !state.objectHash) return;
    const actual = await hashFile(objectPath(root, state.objectHash));
    if (actual.objectHash !== state.objectHash || actual.byteLength !== state.byteLength) {
      throw new RecoveryPrimitiveError('object-corrupt', `Recovery object failed verification: ${state.objectHash}`);
    }
  };

  const replaceFile = async (source, target) => {
    const temporary = `${target}.piarium-recovery-${randomUUID()}.tmp`;
    try {
      await fsPromises.copyFile(source, temporary);
      try {
        await fsPromises.rename(temporary, target);
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) throw error;
        const previous = `${target}.piarium-recovery-${randomUUID()}.previous`;
        let preserved = false;
        try {
          await fsPromises.rename(target, previous);
          preserved = true;
        } catch (preserveError) {
          if (preserveError?.code !== 'ENOENT') throw preserveError;
        }
        try {
          await fsPromises.rename(temporary, target);
          if (preserved) await fsPromises.rm(previous, { force: true });
        } catch (replaceError) {
          if (preserved) await fsPromises.rename(previous, target).catch(() => undefined);
          throw replaceError;
        }
      }
    } finally {
      await fsPromises.rm(temporary, { force: true }).catch(() => undefined);
    }
  };

  const applyState = async (identity, root, relativePath, state) => {
    const { absolute } = await relativePathFor(identity, relativePath);
    if (state.kind === 'missing') {
      let stat;
      try {
        stat = await fsPromises.lstat(absolute);
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      if (stat.isDirectory()) await fsPromises.rmdir(absolute);
      else await fsPromises.unlink(absolute);
      return;
    }
    if (state.kind === 'directory') {
      await fsPromises.mkdir(absolute, { recursive: true });
      if (state.mode !== undefined) await fsPromises.chmod(absolute, state.mode);
      return;
    }
    if (state.kind === 'symlink') {
      await fsPromises.rm(absolute, { force: true, recursive: false }).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
      await fsPromises.mkdir(pathModule.dirname(absolute), { recursive: true });
      await fsPromises.symlink(state.symlinkTarget, absolute);
      return;
    }
    if (state.kind !== 'regular-file') {
      throw new RecoveryPrimitiveError('unsupported-metadata', `Unsupported recovery path: ${relativePath}`);
    }
    await verifyObject(root, state);
    await fsPromises.mkdir(pathModule.dirname(absolute), { recursive: true });
    await replaceFile(objectPath(root, state.objectHash), absolute);
    if (state.mode !== undefined) await fsPromises.chmod(absolute, state.mode);
  };

  return { applyState, captureState, hashFile, relativePathFor, verifyObject };
};

export const statTree = async (root, fsPromises = fs.promises, pathModule = path) => {
  let byteLength = 0;
  let objectCount = 0;
  const walk = async (directory) => {
    let entries;
    try {
      entries = await fsPromises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const target = pathModule.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) {
        objectCount += 1;
        byteLength += (await fsPromises.stat(target)).size;
      }
    }
  };
  await walk(root);
  return { byteLength, objectCount };
};
