import { createHash, randomUUID } from 'node:crypto';
import fs, { type Dirent, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { objectPath } from './journal-catalog.js';
import { RecoveryPrimitiveError } from './errors.js';
import {
  assertAbsolutePathInWorkspace,
  resolveWorkspacePath,
  WorkspacePathError,
} from '../workspace/path-safety.js';

export interface RecoveryIdentity {
  authorityId: string;
  canonicalRoot: string;
  filesystemProfile: string;
  workspaceId: string;
}

export interface MissingState {
  kind: 'missing';
}

export interface DirectoryState {
  kind: 'directory';
  mode?: number | undefined;
}

export interface SymlinkState {
  kind: 'symlink';
  mode?: number | undefined;
  symlinkTarget: string;
}

export interface RegularFileState {
  kind: 'regular-file';
  byteLength: number;
  mode?: number | undefined;
  objectHash: string;
}

export interface UnsupportedState {
  kind: 'unsupported';
}

export type RecoveryState =
  | DirectoryState
  | MissingState
  | RegularFileState
  | SymlinkState
  | UnsupportedState;

export interface RecoveryStateLike {
  kind: string;
  byteLength?: number | undefined;
  mode?: number | undefined;
  objectHash?: string | undefined;
  symlinkTarget?: string | undefined;
}

export interface CapturedState {
  path: string;
  state: RecoveryState;
}

export interface FileHashResult {
  byteLength: number;
  objectHash: string;
}

export interface ResolvedPath {
  absolute: string;
  relative: string;
}

export interface StatTreeResult {
  byteLength: number;
  objectCount: number;
}

export interface CaptureStateOptions {
  store?: boolean | undefined;
}

export interface RecoveryFileStoreOptions {
  fsModule?: typeof fs | undefined;
  fsPromises?: typeof fs.promises | undefined;
  pathModule?: typeof path | undefined;
}

export interface RecoveryFileStore {
  applyState: (
    identity: RecoveryIdentity,
    root: string,
    relativePath: string,
    state: RecoveryState,
  ) => Promise<void>;
  captureState: (
    identity: RecoveryIdentity,
    root: string,
    inputPath: string,
    options?: CaptureStateOptions | undefined,
  ) => Promise<CapturedState>;
  hashFile: (filePath: string) => Promise<FileHashResult>;
  relativePathFor: (identity: RecoveryIdentity, inputPath: string) => Promise<ResolvedPath>;
  verifyObject: (root: string, state: RecoveryState) => Promise<void>;
}

export const normalizeResourceId = (value: unknown): string => String(value || '')
  .replace(/\\/g, '/')
  .replace(/^\.\//, '')
  .replace(/\/+/g, '/');

export const stateIdentity = (state: RecoveryStateLike): string => JSON.stringify({
  byteLength: state.byteLength ?? null,
  kind: state.kind,
  mode: state.mode ?? null,
  objectHash: state.objectHash ?? null,
  symlinkTarget: state.symlinkTarget ?? null,
});

export const sameState = (left: RecoveryStateLike, right: RecoveryStateLike): boolean =>
  stateIdentity(left) === stateIdentity(right);

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
  const relativePathFor = async (
    identity: RecoveryIdentity,
    inputPath: string,
  ): Promise<ResolvedPath> => {
    let contained: { relativePath: string; absolutePath: string };
    try {
      contained = pathModule.isAbsolute(inputPath)
        ? await assertAbsolutePathInWorkspace(inputPath, {
            allowMissing: true,
            fsPromises,
            pathModule,
            root: identity.canonicalRoot,
          })
        : await resolveWorkspacePath(normalizeResourceId(inputPath), {
            allowMissing: true,
            fsPromises,
            pathModule,
            root: identity.canonicalRoot,
          });
    } catch (error) {
      if (error instanceof WorkspacePathError) {
        throw new RecoveryPrimitiveError(
          'workspace-untrusted',
          `Recovery path is outside the workspace: ${inputPath}`,
          { cause: error },
        );
      }
      throw error;
    }
    const relative = normalizeResourceId(contained.relativePath);
    if (!relative || relative === '.' || relative.split('/').includes('..')) {
      throw new RecoveryPrimitiveError('workspace-untrusted', `Recovery path is invalid: ${inputPath}`);
    }
    return { absolute: contained.absolutePath, relative };
  };

  const hashFile = async (filePath: string): Promise<FileHashResult> => {
    const hash = createHash('sha256');
    let byteLength = 0;
    for await (const chunk of fsModule.createReadStream(filePath)) {
      hash.update(chunk);
      byteLength += chunk.length;
    }
    return { byteLength, objectHash: `sha256-${hash.digest('hex')}` };
  };

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
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { path: resolved.relative, state: { kind: 'missing' } };
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
      await fsPromises.copyFile(source, temporary);
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
      await fsPromises.mkdir(absolute, { recursive: true });
      if (state.mode !== undefined) await fsPromises.chmod(absolute, state.mode);
      return;
    }
    if (state.kind === 'symlink') {
      await fsPromises.rm(absolute, { force: true, recursive: false }).catch((error) => {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
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

export const statTree = async (
  root: string,
  fsPromises: typeof fs.promises = fs.promises,
  pathModule: typeof path = path,
): Promise<StatTreeResult> => {
  let byteLength = 0;
  let objectCount = 0;
  const walk = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fsPromises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
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
