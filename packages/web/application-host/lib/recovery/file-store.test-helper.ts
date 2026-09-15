/** Legacy filesystem writer for test baselines only; never a production fallback. */
import { createHash, randomUUID } from 'node:crypto';
import fs, { type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { objectPath } from './object-path.js';
import { copyFilePreferReflink } from '../workspace/reflink.js';
import { RecoveryPrimitiveError } from './errors.js';
import { createRecoveryFileReader, type RecoveryFileStoreOptions, type RecoveryFileStore, type RecoveryIdentity, type RecoveryState, type RegularFileState, type CaptureStateOptions, type CapturedState } from './journal-files.js';

const statStable = (before: Stats, after: Stats): boolean => (
  before.dev === after.dev
  && before.ino === after.ino
  && before.mode === after.mode
  && before.size === after.size
  && before.mtimeMs === after.mtimeMs
);

export const createRecoveryFileStore = ({
  fsModule = fs,
  fsPromises = fs.promises,
  pathModule = path,
}: RecoveryFileStoreOptions = {}): RecoveryFileStore => {
  const { relativePathFor, hashFile } = createRecoveryFileReader({ fsModule, fsPromises, pathModule });

  const captureRegularFile = async (
    filePath: string,
    root: string,
    beforeStat: Stats,
    store: boolean,
  ): Promise<RegularFileState> => {
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
    let handle: FileHandle | null | undefined;
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
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
        await fsPromises.rename(staging, target);
      }
      return { byteLength, kind: 'regular-file', mode: beforeStat.mode & 0o7777, objectHash };
    } finally {
      await handle?.close().catch(() => undefined);
      await fsPromises.rm(staging, { force: true }).catch(() => undefined);
    }
  };

  const captureState = async (
    identity: RecoveryIdentity,
    root: string,
    inputPath: string,
    { store = true }: CaptureStateOptions = {},
  ): Promise<CapturedState> => {
    const resolved = await relativePathFor(identity, inputPath);
    let stat: Stats;
    try {
      stat = await fsPromises.lstat(resolved.absolute);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')) {
        return { path: resolved.relative, state: { kind: 'missing' } };
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      return {
        path: resolved.relative,
        state: {
          kind: 'symlink',
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

  const verifyObject = async (root: string, state: RecoveryState): Promise<void> => {
    if (state.kind !== 'regular-file' || !state.objectHash) return;
    const actual = await hashFile(objectPath(root, state.objectHash));
    if (actual.objectHash !== state.objectHash || actual.byteLength !== state.byteLength) {
      throw new RecoveryPrimitiveError('object-corrupt', `Recovery object failed verification: ${state.objectHash}`);
    }
  };

  const replaceFile = async (source: string, target: string): Promise<void> => {
    const temporary = `${target}.piarium-recovery-${randomUUID()}.tmp`;
    try {
      // Reflink when the filesystem supports it (ReFS/APFS/Btrfs): the temp
      // file shares extents with the content-addressed object and CoW on write.
      await copyFilePreferReflink(source, temporary, fsPromises);
      try {
        await fsPromises.rename(temporary, target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EPERM') throw error;
        const previous = `${target}.piarium-recovery-${randomUUID()}.previous`;
        let preserved = false;
        try {
          await fsPromises.rename(target, previous);
          preserved = true;
        } catch (preserveError) {
          if ((preserveError as NodeJS.ErrnoException)?.code !== 'ENOENT') throw preserveError;
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

  const applyState = async (
    identity: RecoveryIdentity,
    root: string,
    relativePath: string,
    state: RecoveryState,
  ): Promise<void> => {
    const { absolute } = await relativePathFor(identity, relativePath);
    if (state.kind === 'missing') {
      let stat: Stats;
      try {
        stat = await fsPromises.lstat(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
        throw error;
      }
      if (stat.isDirectory()) await fsPromises.rmdir(absolute);
      else await fsPromises.unlink(absolute);
      return;
    }
    if (state.kind === 'directory') {
      try {
        const existing = await fsPromises.lstat(absolute);
        if (!existing.isDirectory()) await fsPromises.unlink(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
      await fsPromises.mkdir(absolute, { recursive: true });
      if (state.mode !== undefined) await fsPromises.chmod(absolute, state.mode);
      return;
    }
    if (state.kind === 'symlink') {
      try {
        const existing = await fsPromises.lstat(absolute);
        if (existing.isDirectory() && !existing.isSymbolicLink()) await fsPromises.rmdir(absolute);
        else await fsPromises.unlink(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
      await fsPromises.mkdir(pathModule.dirname(absolute), { recursive: true });
      await fsPromises.symlink(state.symlinkTarget, absolute);
      return;
    }
    if (state.kind !== 'regular-file') {
      throw new RecoveryPrimitiveError('unsupported-metadata', `Unsupported recovery path: ${relativePath}`);
    }
    await verifyObject(root, state);
    await fsPromises.mkdir(pathModule.dirname(absolute), { recursive: true });
    try {
      const existing = await fsPromises.lstat(absolute);
      if (existing.isDirectory() && !existing.isSymbolicLink()) await fsPromises.rmdir(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    await replaceFile(objectPath(root, state.objectHash), absolute);
    if (state.mode !== undefined) await fsPromises.chmod(absolute, state.mode);
  };

  return { applyState, captureState, hashFile, relativePathFor, verifyObject };
};
