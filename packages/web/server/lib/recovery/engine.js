import { createHash, randomUUID } from 'node:crypto';
import fs, { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import {
  calculateManifestHash,
  ensureRecoveryStoreLayout,
  entryDtoFromRow,
  inspectStoredSnapshot,
  objectPath,
  openRecoveryCatalog,
  recordCatalogOperation,
  snapshotSummaryFromRow,
  verifyRecoveryObject,
  verifyRecoveryStore,
} from './catalog.js';
import { failedRecoveryResult, RecoveryPrimitiveError, recoveryFailure } from './errors.js';
import { createRecoveryLocationRegistry, writeRecoveryJsonAtomic } from './locations.js';
import { createRecoveryBindingStore } from './bindings.js';
import { createCombinedRecoveryManager } from './combined.js';
import { createWorkspaceRestoreManager } from './restore.js';
import { portableSymlinkTarget } from './symlink-target.js';

const POLICY_REVISION = 'native-local-history-v3';
const EXCLUDED_VCS_NAMES = new Set(['.git', '.hg', '.svn']);
const INSERT_STAGED_ENTRY = `
  INSERT INTO staged_entries(
    capture_id, path, comparison_key, kind, coverage, object_hash, byte_length, mode,
    readonly, executable, symlink_target, reason, platform_json
  ) VALUES (
    @captureId, @path, @comparisonKey, @kind, @coverage, @objectHash, @byteLength, @mode,
    @readonly, @executable, @symlinkTarget, @reason, @platformJson
  )
  ON CONFLICT(capture_id, path) DO UPDATE SET
    comparison_key = excluded.comparison_key,
    kind = excluded.kind,
    coverage = excluded.coverage,
    object_hash = excluded.object_hash,
    byte_length = excluded.byte_length,
    mode = excluded.mode,
    readonly = excluded.readonly,
    executable = excluded.executable,
    symlink_target = excluded.symlink_target,
    reason = excluded.reason,
    platform_json = excluded.platform_json
`;

const pathIsInside = (candidate, root, pathModule) => {
  const left = pathModule.resolve(candidate);
  const right = pathModule.resolve(root);
  const normalizedLeft = process.platform === 'win32' ? left.toLowerCase() : left;
  const normalizedRight = process.platform === 'win32' ? right.toLowerCase() : right;
  return normalizedLeft === normalizedRight || normalizedLeft.startsWith(`${normalizedRight}${pathModule.sep}`);
};

const forwardPath = (value) => value.split(path.sep).join('/');
const compareStat = (left, right) => (
  left.dev === right.dev
  && left.ino === right.ino
  && left.size === right.size
  && left.mtimeNs === right.mtimeNs
  && left.ctimeNs === right.ctimeNs
);

const metadataFromStat = (stat) => {
  const mode = Number(stat.mode & 0o7777n);
  return {
    executable: (mode & 0o111) !== 0,
    mode,
    readonly: (mode & 0o222) === 0,
  };
};

const hardlinkMetadataFromStat = (stat) => {
  if (stat.nlink <= 1n) return undefined;
  return {
    hardlinkGroup: `${stat.dev}:${stat.ino}`,
    linkCount: stat.nlink.toString(),
  };
};

const entryRow = (captureId, entry) => ({
  captureId,
  path: entry.path,
  comparisonKey: entry.comparisonKey,
  kind: entry.kind,
  coverage: entry.coverage,
  objectHash: entry.objectHash ?? null,
  byteLength: entry.byteLength ?? null,
  mode: entry.mode ?? null,
  readonly: entry.readonly === undefined ? null : entry.readonly ? 1 : 0,
  executable: entry.executable === undefined ? null : entry.executable ? 1 : 0,
  symlinkTarget: entry.symlinkTarget ?? null,
  reason: entry.reason ?? null,
  platformJson: entry.platformMetadata ? JSON.stringify(entry.platformMetadata) : null,
});

const snapshotFailureResult = (status, snapshotId, error) => ({
  failure: recoveryFailure(error, status === 'missing' ? 'snapshot-missing' : `snapshot-${status}`),
  snapshotId,
  status,
});

const publicMoveOperation = (record) => ({
  byteLength: record.byteLength,
  from: record.from,
  id: record.id,
  startedAt: record.startedAt,
  state: record.state,
  to: record.to,
  updatedAt: record.updatedAt,
  workspaceId: record.workspaceId,
  ...(record.failure ? { failure: record.failure } : {}),
});

const assertPrivatePayloadRoot = (target, label, pathModule) => {
  if (typeof target !== 'string' || !pathModule.isAbsolute(target)) {
    throw new RecoveryPrimitiveError('storage-malformed', `${label} is not a recovery payload root`);
  }
  const volumeRoot = pathModule.parse(target).root;
  const segments = pathModule.relative(volumeRoot, target).split(pathModule.sep).filter(Boolean);
  if (segments.length < 3) throw new RecoveryPrimitiveError('storage-malformed', `${label} is too broad for a recovery payload root`);
  return target;
};

const canonicalizeCreatablePayloadRoot = async (target, fsPromises, pathModule) => {
  const suffix = [];
  let current = pathModule.resolve(target);
  for (;;) {
    try {
      const canonical = pathModule.resolve(await fsPromises.realpath(current), ...suffix.reverse());
      if (!pathIsInside(canonical, target, pathModule) || !pathIsInside(target, canonical, pathModule)) {
        throw new RecoveryPrimitiveError(
          'storage-malformed',
          'Recovery storage path traverses a symbolic link or junction',
        );
      }
      return assertPrivatePayloadRoot(canonical, 'Recovery storage root', pathModule);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = pathModule.dirname(current);
      if (parent === current) throw error;
      suffix.push(pathModule.basename(current));
      current = parent;
    }
  }
};

const statTree = async (root, fsPromises) => {
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
    for (const directoryEntry of entries) {
      const target = path.join(directory, directoryEntry.name);
      const stat = await fsPromises.lstat(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await walk(target);
      else if (stat.isFile()) {
        objectCount += 1;
        byteLength += stat.size;
      }
    }
  };
  await walk(root);
  return { byteLength, objectCount };
};

const operationRecord = (input) => {
  const now = new Date().toISOString();
  return {
    byteLength: 0,
    id: randomUUID(),
    startedAt: now,
    state: 'copying',
    updatedAt: now,
    ...input,
  };
};

export const createWorkspaceRecoveryEngine = ({
  authorityId,
  dataDir,
  defaultRecoveryDir,
  documents,
  faults = {},
  fsModule = fs,
  fsPromises = fs.promises,
  gitInspector,
  pathModule = path,
  sessionNavigation,
  storageOwnerId = 'piarium.builtin.recovery',
}) => {
  const locations = createRecoveryLocationRegistry({
    authorityId,
    dataDir,
    defaultRecoveryDir,
    fsPromises,
    pathModule,
    storageOwnerId,
  });
  const queues = new Map();
  const recoveredStores = new Map();
  let moveRecoveryPromise = null;

  const runWorkspace = (workspaceId, operation) => {
    const previous = queues.get(workspaceId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    queues.set(workspaceId, settled);
    settled.finally(() => {
      if (queues.get(workspaceId) === settled) queues.delete(workspaceId);
    });
    return result;
  };

  const inspectIdentity = async (workspaceId) => {
    const workspace = await documents.inspectWorkspace(workspaceId);
    const canonicalRoot = await fsPromises.realpath(workspace.root);
    if (!pathIsInside(canonicalRoot, workspace.root, pathModule) || !pathIsInside(workspace.root, canonicalRoot, pathModule)) {
      throw new RecoveryPrimitiveError('workspace-untrusted', 'Workspace canonical root changed during recovery inspection');
    }
    return {
      authorityId,
      canonicalRoot,
      filesystemProfile: process.platform === 'win32' ? 'local-windows' : 'local-posix',
      workspaceId: workspace.workspaceId,
    };
  };

  const inspectMaintenanceIdentity = async (workspaceId) => {
    try {
      return await inspectIdentity(workspaceId);
    } catch (error) {
      if (error?.code !== 'workspace-unavailable'
        || typeof documents.listWorkspaceRegistrations !== 'function') throw error;
      const registration = (await documents.listWorkspaceRegistrations())
        .find((entry) => entry.workspaceId === workspaceId);
      if (!registration) throw error;
      return {
        authorityId,
        canonicalRoot: registration.canonicalPath,
        filesystemProfile: process.platform === 'win32' ? 'local-windows' : 'local-posix',
        workspaceId,
      };
    }
  };

  const recoverStoreOperations = (root, workspaceId) => {
    const existing = recoveredStores.get(root);
    if (existing) return existing;
    const recovery = (async () => {
      let database;
      try {
        database = await openRecoveryCatalog(root, { create: false, fsPromises });
        if (!database) return;
        const recoveredAt = new Date().toISOString();
        database.transaction(() => {
          database.prepare(`
            UPDATE operations
            SET state = 'failed', updated_at = ?
            WHERE workspace_id = ?
              AND type IN ('capture', 'cleanup')
              AND state NOT IN ('complete', 'failed')
          `).run(recoveredAt, workspaceId);
          database.prepare('DELETE FROM staged_entries').run();
        })();
      } finally {
        database?.close();
      }
      await fsPromises.rm(pathModule.join(root, 'staging'), { force: true, recursive: true });
      await fsPromises.mkdir(pathModule.join(root, 'staging'), { recursive: true, mode: 0o700 });
    })();
    recoveredStores.set(root, recovery);
    recovery.catch(() => {
      if (recoveredStores.get(root) === recovery) recoveredStores.delete(root);
    });
    return recovery;
  };

  const resolveStorageRoot = async (identity, location) => canonicalizeCreatablePayloadRoot(
    await locations.resolve(identity, location),
    fsPromises,
    pathModule,
  );

  const inheritedMovePromises = new Map();
  const storageMoveQueues = new Map();

  const runStorageMove = (workspaceId, operation) => {
    const previous = storageMoveQueues.get(workspaceId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    storageMoveQueues.set(workspaceId, settled);
    settled.finally(() => {
      if (storageMoveQueues.get(workspaceId) === settled) storageMoveQueues.delete(workspaceId);
    });
    return result;
  };

  const currentStorageSelection = async (identity) => {
    const initial = await locations.materialize(identity.workspaceId);
    if (!initial.migrationRequired) return initial;
    const existing = inheritedMovePromises.get(identity.workspaceId);
    if (existing) return existing;
    const migration = (async () => {
      const operation = await runStorageMove(identity.workspaceId, () => (
        moveStorageInternal(identity, initial.defaultLocation, {
          expectedDefaultLocation: initial.defaultLocation,
          source: 'global',
        })
      ));
      if (operation.state !== 'complete') {
        throw new RecoveryPrimitiveError(
          'storage-move-failed',
          operation.failure?.message ?? 'Inherited recovery storage could not move to the global default',
          { operationId: operation.id, retryable: operation.failure?.retryable ?? true },
        );
      }
      return locations.selection(identity.workspaceId);
    })();
    inheritedMovePromises.set(identity.workspaceId, migration);
    try {
      return await migration;
    } finally {
      if (inheritedMovePromises.get(identity.workspaceId) === migration) {
        inheritedMovePromises.delete(identity.workspaceId);
      }
    }
  };

  const storageFor = async (identity, options = {}) => {
    await recoverMoveOperations();
    const selection = options.migrate === false
      ? await locations.selection(identity.workspaceId)
      : await currentStorageSelection(identity);
    const root = await resolveStorageRoot(identity, selection.location);
    await recoverStoreOperations(root, identity.workspaceId);
    return {
      ...selection,
      root,
    };
  };

  const bindings = createRecoveryBindingStore({
    fsPromises,
    inspectIdentity,
    storageFor,
  });

  const comparisonKey = (relativePath) => {
    const normalized = relativePath.normalize('NFC');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };

  const assertExistingInsideRoot = async (target, root) => {
    const canonical = await fsPromises.realpath(target);
    if (!pathIsInside(canonical, root, pathModule)) {
      throw new RecoveryPrimitiveError('workspace-untrusted', 'Workspace entry resolves outside the registered canonical root');
    }
    return canonical;
  };

  const syncDirectory = async (directory) => {
    let handle;
    try {
      handle = await fsPromises.open(directory, 'r');
      await handle.sync();
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };

  const storeRegularFile = async (absolutePath, workspaceRoot, storeRoot, captureId) => {
    await assertExistingInsideRoot(absolutePath, workspaceRoot);
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    let sourceHandle;
    let targetHandle;
    const temporaryDirectory = pathModule.join(storeRoot, 'staging', captureId, 'objects');
    const temporaryPath = pathModule.join(temporaryDirectory, `${randomUUID()}.tmp`);
    await fsPromises.mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    try {
      sourceHandle = await fsPromises.open(absolutePath, flags);
      const before = await sourceHandle.stat({ bigint: true });
      if (!before.isFile()) throw new RecoveryPrimitiveError('unstable-coverage', 'Workspace entry changed kind during capture');
      targetHandle = await fsPromises.open(temporaryPath, 'wx', 0o600);
      const hash = createHash('sha256');
      let writePosition = 0;
      for await (const chunk of sourceHandle.createReadStream({ autoClose: false })) {
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const written = await targetHandle.write(chunk, offset, chunk.length - offset, writePosition);
          offset += written.bytesWritten;
          writePosition += written.bytesWritten;
        }
      }
      await targetHandle.sync();
      const after = await sourceHandle.stat({ bigint: true });
      if (!compareStat(before, after)) {
        throw new RecoveryPrimitiveError('unstable-coverage', 'Workspace file changed while it was being captured', { retryable: true });
      }
      const objectHash = `sha256-${hash.digest('hex')}`;
      const target = objectPath(storeRoot, objectHash);
      await fsPromises.mkdir(pathModule.dirname(target), { recursive: true, mode: 0o700 });
      let existing = false;
      try {
        await verifyRecoveryObject(storeRoot, objectHash, { fsModule });
        existing = true;
      } catch (error) {
        if (!(error instanceof RecoveryPrimitiveError) || !['object-missing', 'object-corrupt'].includes(error.code)) throw error;
        if (error.code === 'object-corrupt') await fsPromises.unlink(target).catch(() => undefined);
      }
      if (existing) await fsPromises.unlink(temporaryPath);
      else {
        await fsPromises.rename(temporaryPath, target);
        await syncDirectory(pathModule.dirname(target));
      }
      await fsPromises.chmod(target, 0o600);
      return {
        byteLength: Number(before.size),
        metadata: metadataFromStat(before),
        objectHash,
        platformMetadata: hardlinkMetadataFromStat(before),
      };
    } finally {
      await targetHandle?.close().catch(() => undefined);
      await sourceHandle?.close().catch(() => undefined);
      await fsPromises.unlink(temporaryPath).catch(() => undefined);
    }
  };

  const insertEntry = (database, captureId, entry) => {
    const collision = database.prepare(
      'SELECT path FROM staged_entries WHERE capture_id = ? AND comparison_key = ? AND path <> ? LIMIT 1',
    ).get(captureId, entry.comparisonKey, entry.path);
    if (collision) {
      database.prepare(
        "UPDATE staged_entries SET coverage = 'unstable', reason = 'filesystem-comparison-collision' WHERE capture_id = ? AND path = ?",
      ).run(captureId, collision.path);
      entry = { ...entry, coverage: 'unstable', reason: 'filesystem-comparison-collision' };
    }
    database.prepare(INSERT_STAGED_ENTRY).run(entryRow(captureId, entry));
  };

  const captureIntoCatalog = async (identity, storeRoot, input, validateCapture) => {
    const captureId = randomUUID();
    const database = await openRecoveryCatalog(storeRoot, { create: true, fsPromises });
    const startedAt = new Date().toISOString();
    recordCatalogOperation(database, {
      createdAt: startedAt,
      data: { source: input.source ?? 'manual' },
      id: captureId,
      state: 'scanning',
      type: 'capture',
      updatedAt: startedAt,
      workspaceId: identity.workspaceId,
    });

    const workspaceIgnore = ignore();
    for (const ignoreFile of [
      pathModule.join(identity.canonicalRoot, '.gitignore'),
      pathModule.join(identity.canonicalRoot, '.git', 'info', 'exclude'),
    ]) {
      try {
        workspaceIgnore.add(await fsPromises.readFile(ignoreFile, 'utf8'));
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          console.warn(`[WorkspaceRecovery] Could not read ignore rules from ${ignoreFile}: ${error?.message || error}`);
        }
      }
    }

    const shouldExclude = (relativePath, absolutePath, directory = false) => {
      const segments = relativePath.split('/');
      if (EXCLUDED_VCS_NAMES.has(segments.at(-1))) return 'vcs-administrative-store';
      if (segments.length === 2 && segments[0] === '.piarium' && segments[1] === 'recovery') {
        return 'piarium-recovery-storage';
      }
      if (locations.samePath(absolutePath, storeRoot)) return 'piarium-recovery-storage';
      if (workspaceIgnore.ignores(directory ? `${relativePath}/` : relativePath)) {
        return 'workspace-ignore';
      }
      return null;
    };

    const markDirectoryUnstable = (relativePath, reason) => {
      const targetPath = relativePath || '.';
      database.prepare(
        "UPDATE staged_entries SET coverage = 'unstable', reason = ? WHERE capture_id = ? AND path = ?",
      ).run(reason, captureId, targetPath);
    };

    const walkDirectory = async (absoluteDirectory, relativeDirectory, isRoot = false) => {
      await assertExistingInsideRoot(absoluteDirectory, identity.canonicalRoot);
      let before;
      try {
        before = await fsPromises.lstat(absoluteDirectory, { bigint: true });
        if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('directory changed kind');
      } catch (error) {
        if (isRoot) throw error;
        markDirectoryUnstable(relativeDirectory, 'directory-unavailable-during-capture');
        return;
      }
      if (isRoot) {
        insertEntry(database, captureId, {
          ...metadataFromStat(before),
          comparisonKey: comparisonKey('.'),
          coverage: 'present',
          kind: 'directory',
          path: '.',
        });
      }
      let directory;
      try {
        directory = await fsPromises.opendir(absoluteDirectory);
      } catch (error) {
        if (isRoot) throw error;
        markDirectoryUnstable(relativeDirectory, `directory-read-failed:${error?.code ?? 'unknown'}`);
        return;
      }
      for await (const directoryEntry of directory) {
        await assertExistingInsideRoot(absoluteDirectory, identity.canonicalRoot);
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${directoryEntry.name}`
          : directoryEntry.name;
        const portablePath = forwardPath(relativePath);
        const absolutePath = pathModule.join(absoluteDirectory, directoryEntry.name);
        const exclusion = shouldExclude(portablePath, absolutePath, directoryEntry.isDirectory());
        if (exclusion) {
          insertEntry(database, captureId, {
            comparisonKey: comparisonKey(portablePath),
            coverage: 'excluded-unknown',
            kind: 'excluded',
            path: portablePath,
            reason: exclusion,
          });
          continue;
        }
        let stat;
        try {
          stat = await fsPromises.lstat(absolutePath, { bigint: true });
        } catch (error) {
          insertEntry(database, captureId, {
            comparisonKey: comparisonKey(portablePath),
            coverage: 'unstable',
            kind: 'unsupported',
            path: portablePath,
            reason: `entry-unavailable:${error?.code ?? 'unknown'}`,
          });
          continue;
        }
        const metadata = metadataFromStat(stat);
        if (stat.isSymbolicLink()) {
          try {
            const symlinkTarget = portableSymlinkTarget(await fsPromises.readlink(absolutePath));
            insertEntry(database, captureId, {
              ...metadata,
              comparisonKey: comparisonKey(portablePath),
              coverage: 'present',
              kind: 'symlink',
              path: portablePath,
              symlinkTarget,
            });
          } catch (error) {
            insertEntry(database, captureId, {
              ...metadata,
              comparisonKey: comparisonKey(portablePath),
              coverage: 'unstable',
              kind: 'symlink',
              path: portablePath,
              reason: `symlink-read-failed:${error?.code ?? 'unknown'}`,
            });
          }
          continue;
        }
        if (stat.isDirectory()) {
          insertEntry(database, captureId, {
            ...metadata,
            comparisonKey: comparisonKey(portablePath),
            coverage: 'present',
            kind: 'directory',
            path: portablePath,
          });
          await walkDirectory(absolutePath, portablePath);
          continue;
        }
        if (stat.isFile()) {
          try {
            const stored = await storeRegularFile(absolutePath, identity.canonicalRoot, storeRoot, captureId);
            insertEntry(database, captureId, {
              ...stored.metadata,
              byteLength: stored.byteLength,
              comparisonKey: comparisonKey(portablePath),
              coverage: 'present',
              kind: 'regular-file',
              objectHash: stored.objectHash,
              path: portablePath,
              ...(stored.platformMetadata ? { platformMetadata: stored.platformMetadata } : {}),
            });
          } catch (error) {
            insertEntry(database, captureId, {
              ...metadata,
              byteLength: Number(stat.size),
              comparisonKey: comparisonKey(portablePath),
              coverage: 'unstable',
              kind: 'regular-file',
              path: portablePath,
              reason: error instanceof RecoveryPrimitiveError
                ? error.code
                : `file-read-failed:${error?.code ?? 'unknown'}`,
            });
          }
          continue;
        }
        insertEntry(database, captureId, {
          ...metadata,
          comparisonKey: comparisonKey(portablePath),
          coverage: 'excluded-unknown',
          kind: 'unsupported',
          path: portablePath,
          reason: 'unsupported-filesystem-entry',
        });
      }
      try {
        const after = await fsPromises.lstat(absoluteDirectory, { bigint: true });
        if (!compareStat(before, after)) markDirectoryUnstable(relativeDirectory, 'directory-changed-during-capture');
      } catch {
        markDirectoryUnstable(relativeDirectory, 'directory-unavailable-after-capture');
      }
    };

    try {
      await walkDirectory(identity.canonicalRoot, '', true);
      await faults.beforePublish?.({ captureId, database, root: storeRoot });
      for (const row of database.prepare(
        'SELECT object_hash FROM staged_entries WHERE capture_id = ? AND object_hash IS NOT NULL ORDER BY path COLLATE BINARY',
      ).iterate(captureId)) {
        await verifyRecoveryObject(storeRoot, row.object_hash, { fsModule });
      }
      const validation = await validateCapture();
      const witness = {
        epoch: validation.state.epoch,
        mutationRevision: validation.state.mutationRevision,
        writerRevision: validation.state.writerRevision,
      };
      const manifestHash = calculateManifestHash(database, 'staged_entries', 'capture_id', captureId);
      const counts = database.prepare(`
        SELECT
          COUNT(*) AS entry_count,
          COALESCE(SUM(CASE WHEN byte_length IS NOT NULL THEN byte_length ELSE 0 END), 0) AS byte_length,
          COALESCE(SUM(CASE WHEN coverage = 'present' THEN 1 ELSE 0 END), 0) AS present,
          COALESCE(SUM(CASE WHEN coverage = 'known-absent' THEN 1 ELSE 0 END), 0) AS known_absent,
          COALESCE(SUM(CASE WHEN coverage = 'excluded-unknown' THEN 1 ELSE 0 END), 0) AS excluded_unknown,
          COALESCE(SUM(CASE WHEN coverage = 'unstable' THEN 1 ELSE 0 END), 0) AS unstable,
          COALESCE(SUM(CASE WHEN kind = 'unsupported' THEN 1 ELSE 0 END), 0) AS unsupported
        FROM staged_entries WHERE capture_id = ?
      `).get(captureId);
      const incomplete = counts.unstable > 0 || counts.unsupported > 0;
      const snapshotId = randomUUID();
      const createdAt = new Date().toISOString();
      const parent = database.prepare(
        'SELECT id FROM snapshots WHERE workspace_id = ? ORDER BY sequence DESC LIMIT 1',
      ).get(identity.workspaceId)?.id ?? null;
      const sequence = (database.prepare(
        'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM snapshots WHERE workspace_id = ?',
      ).get(identity.workspaceId).sequence ?? 0) + 1;
      database.transaction(() => {
        database.prepare(`
          INSERT INTO snapshots(
            id, workspace_id, sequence, parent_snapshot_id, manifest_hash, policy_revision,
            consistency, availability, coverage_present, coverage_known_absent,
            coverage_excluded_unknown, coverage_unstable, created_at, source, label,
            restored_from, entry_count, byte_length
          ) VALUES (
            @id, @workspaceId, @sequence, @parentSnapshotId, @manifestHash, @policyRevision,
            @consistency, @availability, @present, @knownAbsent,
            @excludedUnknown, @unstable, @createdAt, @source, @label,
            @restoredFrom, @entryCount, @byteLength
          )
        `).run({
          availability: incomplete ? 'incomplete' : 'ready',
          byteLength: counts.byte_length,
          consistency: incomplete
            ? 'incomplete'
            : validation.stable ? 'validated' : 'point-in-time',
          createdAt,
          entryCount: counts.entry_count,
          excludedUnknown: counts.excluded_unknown,
          id: snapshotId,
          knownAbsent: counts.known_absent,
          label: input.label ?? null,
          manifestHash,
          parentSnapshotId: parent,
          policyRevision: POLICY_REVISION,
          present: counts.present,
          restoredFrom: input.restoredFrom ?? null,
          sequence,
          source: input.source ?? 'manual',
          unstable: counts.unstable,
          workspaceId: identity.workspaceId,
        });
        database.prepare(`
          INSERT INTO snapshot_entries(
            snapshot_id, path, comparison_key, kind, coverage, object_hash, byte_length,
            mode, readonly, executable, symlink_target, reason, platform_json
          )
          SELECT ?, path, comparison_key, kind, coverage, object_hash, byte_length,
            mode, readonly, executable, symlink_target, reason, platform_json
          FROM staged_entries WHERE capture_id = ?
        `).run(snapshotId, captureId);
        database.prepare('DELETE FROM staged_entries WHERE capture_id = ?').run(captureId);
        if (validation.stable && !incomplete) {
          database.prepare(`
            INSERT INTO workspace_heads(
              workspace_id, snapshot_id, epoch, mutation_revision, writer_revision, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id) DO UPDATE SET
              snapshot_id = excluded.snapshot_id,
              epoch = excluded.epoch,
              mutation_revision = excluded.mutation_revision,
              writer_revision = excluded.writer_revision,
              updated_at = excluded.updated_at
          `).run(
            identity.workspaceId,
            snapshotId,
            witness.epoch,
            witness.mutationRevision,
            witness.writerRevision,
            createdAt,
          );
        }
        recordCatalogOperation(database, {
          createdAt: startedAt,
          data: { snapshotId },
          id: captureId,
          state: 'complete',
          type: 'capture',
          updatedAt: createdAt,
          workspaceId: identity.workspaceId,
        });
      })();
      const row = database.prepare('SELECT * FROM snapshots WHERE id = ?').get(snapshotId);
      return {
        reused: false,
        snapshot: snapshotSummaryFromRow(row),
        status: 'captured',
        witness,
      };
    } catch (error) {
      const updatedAt = new Date().toISOString();
      database.prepare('DELETE FROM staged_entries WHERE capture_id = ?').run(captureId);
      recordCatalogOperation(database, {
        createdAt: startedAt,
        data: { failure: recoveryFailure(error) },
        id: captureId,
        state: 'failed',
        type: 'capture',
        updatedAt,
        workspaceId: identity.workspaceId,
      });
      return failedRecoveryResult(error);
    } finally {
      database.close();
      await fsPromises.rm(pathModule.join(storeRoot, 'staging', captureId), { force: true, recursive: true }).catch(() => undefined);
    }
  };

  const readSnapshotInternal = async (identity, input) => {
    const storage = await storageFor(identity);
    let database;
    try {
      database = await openRecoveryCatalog(storage.root, { create: false, fsPromises });
      if (!database) {
        return snapshotFailureResult('missing', input.snapshotId, new RecoveryPrimitiveError('snapshot-missing', 'Snapshot does not exist'));
      }
      const inspected = await inspectStoredSnapshot(database, storage.root, identity.workspaceId, input.snapshotId, { fsModule });
      if (inspected.availability === 'missing') {
        return snapshotFailureResult('missing', input.snapshotId, new RecoveryPrimitiveError('snapshot-missing', 'Snapshot does not exist'));
      }
      if (inspected.availability === 'malformed' || inspected.availability === 'corrupt') {
        return snapshotFailureResult(inspected.availability, input.snapshotId, inspected.error);
      }
      const parameters = [input.snapshotId];
      let sql = 'SELECT * FROM snapshot_entries WHERE snapshot_id = ?';
      if (input.entryCursor) {
        sql += ' AND path > ? COLLATE BINARY';
        parameters.push(input.entryCursor);
      }
      sql += ' ORDER BY path COLLATE BINARY';
      const requestedLimit = input.entryLimit;
      if (requestedLimit) {
        sql += ' LIMIT ?';
        parameters.push(requestedLimit + 1);
      }
      const entries = [];
      for (const row of database.prepare(sql).iterate(...parameters)) entries.push(entryDtoFromRow(row));
      const hasMore = requestedLimit !== undefined && entries.length > requestedLimit;
      if (hasMore) entries.pop();
      const snapshot = snapshotSummaryFromRow(inspected.row, inspected.availability);
      return {
        manifest: {
          entries,
          manifestHash: snapshot.manifestHash,
          nextCursor: hasMore ? entries.at(-1)?.path ?? null : null,
          snapshot,
        },
        status: inspected.availability,
      };
    } catch (error) {
      if (error instanceof RecoveryPrimitiveError && error.code === 'storage-malformed') {
        return snapshotFailureResult('malformed', input.snapshotId, new RecoveryPrimitiveError('snapshot-malformed', error.message, { cause: error }));
      }
      if (error instanceof RecoveryPrimitiveError && error.code === 'snapshot-malformed') {
        return snapshotFailureResult('malformed', input.snapshotId, error);
      }
      throw error;
    } finally {
      database?.close();
    }
  };

  const listSnapshotsInternal = async (identity, input) => {
    const storage = await storageFor(identity);
    let database;
    try {
      database = await openRecoveryCatalog(storage.root, { create: false, fsPromises });
      if (!database) return { page: { nextCursor: null, snapshots: [] }, status: 'ready' };
      const parameters = [identity.workspaceId];
      let sql = 'SELECT * FROM snapshots WHERE workspace_id = ?';
      if (input.cursor) {
        sql += ' AND sequence < ?';
        parameters.push(input.cursor);
      }
      sql += ' ORDER BY sequence DESC';
      if (input.limit) {
        sql += ' LIMIT ?';
        parameters.push(input.limit + 1);
      }
      const rows = [...database.prepare(sql).iterate(...parameters)];
      const hasMore = input.limit !== undefined && rows.length > input.limit;
      if (hasMore) rows.pop();
      const snapshots = [];
      for (const row of rows) {
        // Listing is a metadata operation used on the prompt path. Object
        // hashing belongs to explicit read/restore/audit operations and can be
        // tens of gigabytes for data-heavy workspaces.
        const inspected = await inspectStoredSnapshot(database, storage.root, identity.workspaceId, row.id, {
          fsModule,
          verifyObjects: false,
        });
        snapshots.push(snapshotSummaryFromRow(row, inspected.availability));
      }
      return {
        page: {
          nextCursor: hasMore ? snapshots.at(-1)?.sequence ?? null : null,
          snapshots,
        },
        status: 'ready',
      };
    } finally {
      database?.close();
    }
  };

  const reuseWorkspaceHead = async (identity, storeRoot, mutationState) => {
    if (mutationState.maintenance
      || mutationState.reconciliationRequired
      || mutationState.activeWriters.length > 0) return null;
    const database = await openRecoveryCatalog(storeRoot, { create: false, fsPromises });
    if (!database) return null;
    try {
      const head = database.prepare(`
        SELECT heads.snapshot_id FROM workspace_heads AS heads
        JOIN snapshots ON snapshots.id = heads.snapshot_id
        WHERE heads.workspace_id = ?
          AND heads.epoch = ?
          AND heads.mutation_revision = ?
          AND snapshots.policy_revision = ?
      `).get(
        identity.workspaceId,
        mutationState.epoch,
        mutationState.mutationRevision,
        POLICY_REVISION,
      );
      if (!head) return null;
      const inspected = await inspectStoredSnapshot(
        database,
        storeRoot,
        identity.workspaceId,
        head.snapshot_id,
        { fsModule, verifyObjects: false },
      );
      if (inspected.availability !== 'ready') return null;
      return {
        reused: true,
        snapshot: snapshotSummaryFromRow(inspected.row),
        status: 'captured',
        witness: {
          epoch: mutationState.epoch,
          mutationRevision: mutationState.mutationRevision,
          writerRevision: mutationState.writerRevision,
        },
      };
    } finally {
      database.close();
    }
  };

  const diffSnapshotsInternal = async (identity, input) => {
    const storage = await storageFor(identity);
    let database;
    try {
      database = await openRecoveryCatalog(storage.root, { create: false, fsPromises });
      if (!database) throw new RecoveryPrimitiveError('snapshot-unavailable', 'Recovery storage does not contain snapshots');
      for (const snapshotId of [input.beforeSnapshotId, input.afterSnapshotId]) {
        const inspected = await inspectStoredSnapshot(database, storage.root, identity.workspaceId, snapshotId, {
          fsModule,
          verifyObjects: false,
        });
        if (inspected.availability === 'missing') throw new RecoveryPrimitiveError('snapshot-missing', `Snapshot does not exist: ${snapshotId}`);
        if (inspected.availability === 'malformed') throw inspected.error;
        if (inspected.availability === 'corrupt') throw inspected.error;
      }
      const iterator = (snapshotId) => database.prepare(`
        SELECT * FROM snapshot_entries
        WHERE snapshot_id = ? AND path > ? COLLATE BINARY
        ORDER BY path COLLATE BINARY
      `).iterate(snapshotId, input.cursor ?? '')[Symbol.iterator]();
      const beforeIterator = iterator(input.beforeSnapshotId);
      const afterIterator = iterator(input.afterSnapshotId);
      let before = beforeIterator.next();
      let after = afterIterator.next();
      const changes = [];
      let nextCursor = null;
      while (!before.done || !after.done) {
        const beforeEntry = before.done ? null : entryDtoFromRow(before.value);
        const afterEntry = after.done ? null : entryDtoFromRow(after.value);
        let change = null;
        if (!beforeEntry || (afterEntry && afterEntry.path < beforeEntry.path)) {
          change = { after: afterEntry, path: afterEntry.path, type: 'added' };
          after = afterIterator.next();
        } else if (!afterEntry || beforeEntry.path < afterEntry.path) {
          change = { before: beforeEntry, path: beforeEntry.path, type: 'removed' };
          before = beforeIterator.next();
        } else {
          if (JSON.stringify(beforeEntry) !== JSON.stringify(afterEntry)) {
            change = { after: afterEntry, before: beforeEntry, path: beforeEntry.path, type: 'modified' };
          }
          before = beforeIterator.next();
          after = afterIterator.next();
        }
        if (!change) continue;
        if (input.limit !== undefined && changes.length >= input.limit) {
          nextCursor = changes.at(-1)?.path ?? null;
          break;
        }
        changes.push(change);
      }
      return {
        diff: {
          afterSnapshotId: input.afterSnapshotId,
          beforeSnapshotId: input.beforeSnapshotId,
          changes,
          nextCursor,
          workspaceId: identity.workspaceId,
        },
        status: 'ready',
      };
    } finally {
      database?.close();
    }
  };

  const storageStatusInternal = async (identity) => {
    await recoverMoveOperations();
    const selection = identity
      ? await currentStorageSelection(identity)
      : await locations.globalSelection();
    if (!identity) {
      return {
        authorityId,
        byteLength: 0,
        encryption: { available: false, enabled: false },
        location: selection.location,
        locationSource: 'global',
        objectCount: 0,
        readySnapshotCount: 0,
        registryRevision: selection.document.revision,
        snapshotCount: 0,
        state: 'missing',
      };
    }
    const root = await resolveStorageRoot(identity, selection.location);
    const objectStats = await statTree(pathModule.join(root, 'objects'), fsPromises);
    let database;
    try {
      database = await openRecoveryCatalog(root, { create: false, fsPromises });
      if (!database) {
        return {
          authorityId,
          byteLength: objectStats.byteLength,
          encryption: { available: false, enabled: false },
          location: selection.location,
          locationSource: selection.source,
          objectCount: objectStats.objectCount,
          readySnapshotCount: 0,
          registryRevision: selection.document.revision,
          snapshotCount: 0,
          state: 'missing',
          workspaceId: identity.workspaceId,
        };
      }
      const rows = [...database.prepare('SELECT id, availability FROM snapshots WHERE workspace_id = ?').iterate(identity.workspaceId)];
      let state = rows.some((row) => row.availability === 'incomplete') ? 'incomplete' : 'ready';
      let readySnapshotCount = 0;
      for (const row of rows) {
        const inspected = await inspectStoredSnapshot(database, root, identity.workspaceId, row.id, {
          fsModule,
          verifyObjects: false,
        });
        if (inspected.availability === 'corrupt') state = 'corrupt';
        else if (inspected.availability === 'malformed' && state !== 'corrupt') state = 'malformed';
        else if (inspected.availability === 'ready') readySnapshotCount += 1;
      }
      return {
        authorityId,
        byteLength: objectStats.byteLength,
        encryption: { available: false, enabled: false },
        location: selection.location,
        locationSource: selection.source,
        objectCount: objectStats.objectCount,
        readySnapshotCount,
        registryRevision: selection.document.revision,
        snapshotCount: rows.length,
        state: rows.length === 0 && objectStats.objectCount === 0 ? 'missing' : state,
        workspaceId: identity.workspaceId,
      };
    } finally {
      database?.close();
    }
  };

  const storageWorkspaceSummary = async (registration) => {
    const identity = {
      authorityId,
      canonicalRoot: registration.canonicalPath,
      filesystemProfile: process.platform === 'win32' ? 'local-windows' : 'local-posix',
      workspaceId: registration.workspaceId,
    };
    const selection = await locations.selection(identity.workspaceId);
    let workspaceAvailable = false;
    try {
      const stat = await fsPromises.stat(await fsPromises.realpath(identity.canonicalRoot));
      workspaceAvailable = stat.isDirectory();
    } catch {
      workspaceAvailable = false;
    }
    try {
      const root = await resolveStorageRoot(identity, selection.location);
      const objectStats = await statTree(pathModule.join(root, 'objects'), fsPromises);
      const database = await openRecoveryCatalog(root, { create: false, fsPromises });
      try {
        const snapshots = database?.prepare(`
          SELECT
            COUNT(*) AS count,
            MAX(created_at) AS last_activity_at,
            COALESCE(SUM(CASE WHEN availability = 'incomplete' THEN 1 ELSE 0 END), 0) AS incomplete
          FROM snapshots WHERE workspace_id = ?
        `).get(identity.workspaceId) ?? { count: 0, incomplete: 0, last_activity_at: null };
        const operationActivity = database?.prepare(
          'SELECT MAX(updated_at) AS last_activity_at FROM operations WHERE workspace_id = ?',
        ).get(identity.workspaceId)?.last_activity_at ?? null;
        const lastActivityAt = [snapshots.last_activity_at, operationActivity]
          .filter((value) => typeof value === 'string')
          .sort()
          .at(-1) ?? null;
        return {
          byteLength: objectStats.byteLength,
          canonicalRoot: identity.canonicalRoot,
          lastActivityAt,
          location: selection.location,
          locationSource: selection.source,
          migrationRequired: selection.migrationRequired,
          objectCount: objectStats.objectCount,
          snapshotCount: snapshots.count,
          state: snapshots.count === 0 && objectStats.objectCount === 0
            ? 'missing'
            : snapshots.incomplete > 0 ? 'incomplete' : 'ready',
          storageAvailable: true,
          workspaceAvailable,
          workspaceId: identity.workspaceId,
        };
      } finally {
        database?.close();
      }
    } catch (error) {
      return {
        byteLength: 0,
        canonicalRoot: identity.canonicalRoot,
        failure: recoveryFailure(error, 'unavailable'),
        lastActivityAt: null,
        location: selection.location,
        locationSource: selection.source,
        migrationRequired: selection.migrationRequired,
        objectCount: 0,
        snapshotCount: 0,
        state: 'unavailable',
        storageAvailable: false,
        workspaceAvailable,
        workspaceId: identity.workspaceId,
      };
    }
  };

  const moveRecordPath = (operationId) => pathModule.join(locations.operationsRoot, `${operationId}.json`);
  const writeMove = async (operation) => {
    operation.updatedAt = new Date().toISOString();
    await writeRecoveryJsonAtomic(moveRecordPath(operation.id), operation, { fsPromises, pathModule });
  };

  const readMove = async (operationId) => {
    try {
      const operation = JSON.parse(await fsPromises.readFile(moveRecordPath(operationId), 'utf8'));
      if (!operation || operation.authorityId !== authorityId || operation.id !== operationId) {
        throw new RecoveryPrimitiveError('storage-malformed', 'Recovery storage move record is malformed');
      }
      if (typeof operation.workspaceId !== 'string' || !operation.workspaceId) {
        throw new RecoveryPrimitiveError('storage-malformed', 'Recovery storage move workspace is malformed');
      }
      if (operation.stageRoot !== `${operation.destinationRoot}.move-${operation.id}.staging`
        || operation.backupRoot !== `${operation.destinationRoot}.move-${operation.id}.previous`) {
        throw new RecoveryPrimitiveError('storage-malformed', 'Recovery storage move staging paths are malformed');
      }
      return operation;
    } catch (error) {
      if (error?.code === 'ENOENT') throw new RecoveryPrimitiveError('operation-not-found', 'Recovery storage move does not exist');
      if (error instanceof RecoveryPrimitiveError) throw error;
      throw new RecoveryPrimitiveError('storage-malformed', 'Recovery storage move record cannot be read', { cause: error });
    }
  };

  const validateMoveRoots = async (operation) => {
    const identity = await inspectIdentity(operation.workspaceId);
    const [sourceRoot, destinationRoot] = await Promise.all([
      resolveStorageRoot(identity, operation.from),
      resolveStorageRoot(identity, operation.to),
    ]);
    if (!locations.samePath(sourceRoot, operation.sourceRoot)
      || !locations.samePath(destinationRoot, operation.destinationRoot)
      || !locations.samePath(`${destinationRoot}.move-${operation.id}.staging`, operation.stageRoot)
      || !locations.samePath(`${destinationRoot}.move-${operation.id}.previous`, operation.backupRoot)) {
      throw new RecoveryPrimitiveError('storage-malformed', 'Recovery storage move roots do not match their authoritative locations');
    }
    return operation;
  };

  const recoverMoveOperations = () => {
    if (moveRecoveryPromise) return moveRecoveryPromise;
    moveRecoveryPromise = (async () => {
      let entries;
      try {
        entries = await fsPromises.readdir(locations.operationsRoot, { withFileTypes: true });
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile()
          || !entry.name.endsWith('.json')
          || entry.name.startsWith('restore-')
          || entry.name.startsWith('combined-')) continue;
        const operationId = entry.name.slice(0, -'.json'.length);
        const operation = await validateMoveRoots(await readMove(operationId));
        if (operation.state === 'complete' || operation.state === 'failed') continue;
        const selection = await locations.selection(operation.workspaceId);
        const authority = JSON.stringify(selection.location);
        if (authority === JSON.stringify(operation.to)) {
          operation.switched = true;
          operation.state = 'complete';
          await writeMove(operation);
          await fsPromises.rm(operation.sourceRoot, { force: true, recursive: true }).catch(() => undefined);
          await fsPromises.rm(operation.backupRoot, { force: true, recursive: true }).catch(() => undefined);
          await fsPromises.rm(operation.stageRoot, { force: true, recursive: true }).catch(() => undefined);
          continue;
        }
        if (authority === JSON.stringify(operation.from)) {
          if (operation.destinationHadExisting === false) {
            await fsPromises.rm(operation.destinationRoot, { force: true, recursive: true }).catch(() => undefined);
          } else if (operation.destinationHadExisting === true) {
            try {
              await fsPromises.lstat(operation.backupRoot);
              await fsPromises.rm(operation.destinationRoot, { force: true, recursive: true }).catch(() => undefined);
              await fsPromises.rename(operation.backupRoot, operation.destinationRoot);
            } catch (error) {
              if (error?.code !== 'ENOENT') throw error;
            }
          }
        }
        await fsPromises.rm(operation.stageRoot, { force: true, recursive: true }).catch(() => undefined);
        operation.state = 'failed';
        operation.failure = recoveryFailure(new RecoveryPrimitiveError(
          'storage-move-failed',
          'An interrupted storage move was rolled back to the authoritative location registry decision',
          { operationId: operation.id, retryable: true },
        ));
        await writeMove(operation);
      }
    })().catch((error) => {
      moveRecoveryPromise = null;
      throw error;
    });
    return moveRecoveryPromise;
  };

  const moveStorageInternal = async (identity, targetLocation, commitOptions = {}) => {
    const normalizedTargetLocation = await locations.validateLocation(targetLocation);
    const current = await locations.selection(identity.workspaceId);
    const sourceRoot = await resolveStorageRoot(identity, current.location);
    const sourceCatalog = await openRecoveryCatalog(sourceRoot, { create: false, fsPromises });
    try {
      const activeRestore = sourceCatalog?.prepare(`
        SELECT id FROM operations
        WHERE type IN ('workspace-restore', 'combined-recovery')
          AND state NOT IN ('complete', 'aborted', 'compensated', 'needs-attention')
        LIMIT 1
      `).get();
      if (activeRestore) {
        throw new RecoveryPrimitiveError('recovery-in-progress', 'Recovery storage cannot move during a workspace restore', {
          details: { operationId: activeRestore.id },
          operationId: activeRestore.id,
        });
      }
    } finally {
      sourceCatalog?.close();
    }
    const destinationRoot = await resolveStorageRoot(identity, normalizedTargetLocation);
    if (!locations.samePath(sourceRoot, destinationRoot)
      && (pathIsInside(sourceRoot, destinationRoot, pathModule)
        || pathIsInside(destinationRoot, sourceRoot, pathModule))) {
      throw new RecoveryPrimitiveError(
        'invalid-request',
        'Recovery storage cannot be moved into its own source tree or one of its descendants',
      );
    }
    const operation = operationRecord({
      authorityId,
      from: current.location,
      sourceRoot,
      destinationRoot,
      to: normalizedTargetLocation,
      workspaceId: identity.workspaceId,
    });
    const stageRoot = `${destinationRoot}.move-${operation.id}.staging`;
    const backupRoot = `${destinationRoot}.move-${operation.id}.previous`;
    operation.stageRoot = stageRoot;
    operation.backupRoot = backupRoot;
    operation.destinationHadExisting = null;
    operation.switched = false;
    await writeMove(operation);
    if (locations.samePath(sourceRoot, destinationRoot)) {
      await locations.commit(identity.workspaceId, current.location, normalizedTargetLocation, commitOptions);
      operation.state = 'complete';
      await writeMove(operation);
      return publicMoveOperation(operation);
    }
    let destinationReplaced = false;
    try {
      await fsPromises.rm(stageRoot, { force: true, recursive: true });
      await fsPromises.rm(backupRoot, { force: true, recursive: true });
      try {
        const sourceStat = await fsPromises.lstat(sourceRoot);
        if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
          throw new RecoveryPrimitiveError('storage-malformed', 'Authoritative recovery storage is not a directory');
        }
        await fsPromises.cp(sourceRoot, stageRoot, {
          dereference: false,
          errorOnExist: true,
          force: false,
          preserveTimestamps: true,
          recursive: true,
          verbatimSymlinks: true,
        });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await ensureRecoveryStoreLayout(stageRoot, fsPromises);
        const empty = await openRecoveryCatalog(stageRoot, { create: true, fsPromises });
        empty.close();
      }
      operation.byteLength = (await statTree(stageRoot, fsPromises)).byteLength;
      operation.state = 'verifying';
      await writeMove(operation);
      await verifyRecoveryStore(stageRoot, { fsModule, fsPromises });
      await faults.beforeLocationSwitch?.({ destinationRoot, operationId: operation.id, sourceRoot, stageRoot });
      operation.state = 'switching';
      await writeMove(operation);
      await fsPromises.mkdir(pathModule.dirname(destinationRoot), { recursive: true, mode: 0o700 });
      try {
        await fsPromises.lstat(destinationRoot);
        throw new RecoveryPrimitiveError(
          'storage-move-failed',
          'Recovery storage destination already exists; move or remove that payload before transferring this history',
          { details: { destinationRoot } },
        );
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      operation.destinationHadExisting = false;
      await writeMove(operation);
      await fsPromises.rename(stageRoot, destinationRoot);
      destinationReplaced = true;
      await locations.commit(identity.workspaceId, current.location, normalizedTargetLocation, commitOptions);
      operation.switched = true;
      operation.state = 'complete';
      await writeMove(operation);
      await fsPromises.rm(sourceRoot, { force: true, recursive: true }).catch(() => undefined);
      await fsPromises.rm(backupRoot, { force: true, recursive: true }).catch(() => undefined);
      return publicMoveOperation(operation);
    } catch (error) {
      if (!operation.switched && destinationReplaced) {
        await fsPromises.rm(destinationRoot, { force: true, recursive: true }).catch(() => undefined);
      }
      await fsPromises.rm(stageRoot, { force: true, recursive: true }).catch(() => undefined);
      operation.state = 'failed';
      operation.failure = recoveryFailure(new RecoveryPrimitiveError(
        'storage-move-failed',
        error instanceof Error ? error.message : String(error),
        { cause: error, operationId: operation.id, retryable: true },
      ));
      await writeMove(operation).catch(() => undefined);
      return publicMoveOperation(operation);
    }
  };

  const cleanupInternal = async (identity) => {
    const operationId = randomUUID();
    const base = {
      byteLengthReclaimed: 0,
      failures: [],
      manifestsDeleted: 0,
      objectsDeleted: 0,
      operationId,
      retainedPins: 0,
      status: 'complete',
      workspaceId: identity.workspaceId,
    };
    const storage = await storageFor(identity, { migrate: false });
    let database;
    const startedAt = new Date().toISOString();
    try {
      database = await openRecoveryCatalog(storage.root, { create: false, fsPromises });
      if (!database) return base;
      const activeRestore = database.prepare(`
        SELECT id FROM operations
        WHERE type IN ('workspace-restore', 'combined-recovery')
          AND state NOT IN ('complete', 'aborted', 'compensated', 'needs-attention')
        LIMIT 1
      `).get();
      if (activeRestore) {
        throw new RecoveryPrimitiveError('recovery-in-progress', 'Storage cleanup cannot run during a workspace restore', {
          details: { operationId: activeRestore.id },
          operationId: activeRestore.id,
        });
      }
      database.transaction(() => {
        database.prepare(`
          UPDATE operations SET state = 'failed', updated_at = ?
          WHERE type IN ('capture', 'cleanup') AND state NOT IN ('complete', 'failed')
        `).run(new Date().toISOString());
        database.prepare('DELETE FROM staged_entries').run();
      })();
      recordCatalogOperation(database, {
        createdAt: startedAt,
        data: {},
        id: operationId,
        state: 'running',
        type: 'cleanup',
        updatedAt: startedAt,
        workspaceId: identity.workspaceId,
      });
      base.retainedPins = database.prepare('SELECT COUNT(*) AS count FROM pins').get().count;
      const objectsRoot = pathModule.join(storage.root, 'objects');
      const walk = async (directory) => {
        let handle;
        try {
          handle = await fsPromises.opendir(directory);
        } catch (error) {
          if (error?.code === 'ENOENT') return;
          throw error;
        }
        for await (const directoryEntry of handle) {
          const target = pathModule.join(directory, directoryEntry.name);
          const stat = await fsPromises.lstat(target);
          if (stat.isDirectory() && !stat.isSymbolicLink()) {
            await walk(target);
            await fsPromises.rmdir(target).catch((error) => { if (error?.code !== 'ENOTEMPTY' && error?.code !== 'ENOENT') throw error; });
            continue;
          }
          const relative = pathModule.relative(objectsRoot, target).split(pathModule.sep).join('');
          const objectHash = /^[0-9a-f]{64}$/.test(relative) ? `sha256-${relative}` : null;
          const reachable = objectHash && database.prepare(`
            SELECT 1 AS reachable FROM snapshot_entries WHERE object_hash = ? LIMIT 1
          `).get(objectHash);
          if (reachable) continue;
          await fsPromises.unlink(target);
          base.objectsDeleted += 1;
          base.byteLengthReclaimed += stat.size;
        }
      };
      await walk(objectsRoot);
      recordCatalogOperation(database, {
        createdAt: startedAt,
        data: {
          byteLengthReclaimed: base.byteLengthReclaimed,
          objectsDeleted: base.objectsDeleted,
        },
        id: operationId,
        state: 'complete',
        type: 'cleanup',
        updatedAt: new Date().toISOString(),
        workspaceId: identity.workspaceId,
      });
      return base;
    } catch (error) {
      base.status = 'failed';
      base.failures.push(recoveryFailure(error));
      if (database) recordCatalogOperation(database, {
        createdAt: startedAt,
        data: { failure: recoveryFailure(error) },
        id: operationId,
        state: 'failed',
        type: 'cleanup',
        updatedAt: new Date().toISOString(),
        workspaceId: identity.workspaceId,
      });
      return base;
    } finally {
      database?.close();
    }
  };

  const deleteHistoryInternal = async (identity) => {
    const operationId = randomUUID();
    const storage = await storageFor(identity, { migrate: false });
    const database = await openRecoveryCatalog(storage.root, { create: false, fsPromises });
    try {
      const activeRestore = database?.prepare(`
        SELECT id FROM operations
        WHERE type IN ('workspace-restore', 'combined-recovery')
          AND state NOT IN ('complete', 'aborted', 'compensated', 'needs-attention')
        LIMIT 1
      `).get();
      if (activeRestore) {
        throw new RecoveryPrimitiveError('recovery-in-progress', 'Recovery history cannot be deleted during a workspace restore', {
          details: { operationId: activeRestore.id },
          operationId: activeRestore.id,
        });
      }
    } finally {
      database?.close();
    }
    const stats = await statTree(storage.root, fsPromises).catch(() => ({ byteLength: 0, objectCount: 0 }));
    const objectStats = await statTree(pathModule.join(storage.root, 'objects'), fsPromises)
      .catch(() => ({ byteLength: 0, objectCount: 0 }));
    const result = {
      byteLengthReclaimed: stats.byteLength,
      failures: [],
      manifestsDeleted: 0,
      objectsDeleted: objectStats.objectCount,
      operationId,
      retainedPins: 0,
      status: 'complete',
      workspaceId: identity.workspaceId,
    };
    try {
      await fsPromises.rm(storage.root, { force: true, recursive: true });
      await locations.remove(identity.workspaceId);
    } catch (error) {
      result.status = 'failed';
      result.failures.push(recoveryFailure(error));
    }
    return result;
  };

  const captureSnapshotPublic = (input) => runWorkspace(input.workspaceId, async () => {
    let capture;
    let captureCompleted = false;
    try {
      const identity = await inspectIdentity(input.workspaceId);
      const storage = await storageFor(identity);
      if (input.reuseIfUnchanged) {
        const reused = await reuseWorkspaceHead(
          identity,
          storage.root,
          await documents.inspectMutation(input.workspaceId),
        );
        if (reused) return reused;
      }
      let captureUnavailable = null;
      try {
        capture = await documents.beginCapture(input.workspaceId, {
          allowMaintenance: input.allowMaintenance === true,
        });
      } catch (error) {
        // A workspace watcher strengthens a revision from point-in-time to
        // validated, but it is not the authority for whether history exists.
        // IDE local-history semantics still preserve a complete filesystem
        // scan when the watcher is unavailable; restore-time conflict checks
        // decide whether that revision should be applied in place.
        captureUnavailable = error;
      }
      return await captureIntoCatalog(identity, storage.root, input, async () => {
        if (capture) {
          captureCompleted = true;
          return documents.completeCapture(capture);
        }
        const state = await documents.inspectMutation(input.workspaceId);
        return {
          reasons: [
            `watcher-unavailable:${captureUnavailable?.code ?? 'unknown'}`,
          ],
          stable: false,
          state,
        };
      });
    } catch (error) {
      return failedRecoveryResult(error);
    } finally {
      if (capture && !captureCompleted) {
        await documents.completeCapture(capture).catch(() => undefined);
      }
    }
  });

  const createCheckpointPublic = async (input) => {
    const captured = await captureSnapshotPublic({
      label: input.name,
      source: 'manual',
      workspaceId: input.workspaceId,
    });
    if (captured.status !== 'captured') return captured;
    try {
      await runWorkspace(input.workspaceId, () => (
        bindings.pinCheckpoint(input.workspaceId, captured.snapshot.id, input.name)
      ));
      return captured;
    } catch (error) {
      return failedRecoveryResult(error);
    }
  };

  const restore = createWorkspaceRestoreManager({
    captureSnapshot: captureSnapshotPublic,
    documents,
    faults,
    fsModule,
    fsPromises,
    ...(gitInspector ? { gitInspector } : {}),
    inspectIdentity,
    locations,
    pathModule,
    storageFor,
  });
  const combined = createCombinedRecoveryManager({
    bindings,
    fsPromises,
    inspectIdentity,
    locations,
    pathModule,
    restore,
    sessionNavigation,
    storageFor,
  });

  return {
    locations,
    async fenceUnfinishedOperations() {
      return restore.fenceUnfinished();
    },
    async resumeCombinedOperations() {
      return combined.resumeUnfinished();
    },
    async resumeWorkspaceOperations() {
      return restore.resumeUnfinished();
    },
    async resumeUnfinishedOperations() {
      const workspace = await restore.resumeUnfinished();
      const composite = await combined.resumeUnfinished();
      return { composite, workspace };
    },
    async status(workspaceId) {
      try {
        const identity = await inspectIdentity(workspaceId);
        return {
          capabilities: {
            bindings: true,
            capture: true,
            checkpoints: true,
            combined: Boolean(sessionNavigation),
            diff: true,
            read: true,
            restore: true,
            storageManagement: true,
          },
          identity,
          status: 'ready',
          storage: await storageStatusInternal(identity),
        };
      } catch (error) {
        return failedRecoveryResult(error);
      }
    },
    async captureSnapshot(input) {
      return captureSnapshotPublic(input);
    },
    async createCheckpoint(input) {
      return createCheckpointPublic(input);
    },
    async recordTurnStart(input) {
      return runWorkspace(input.workspaceId, async () => {
        try {
          return await bindings.recordTurnStart(input);
        } catch (error) {
          return failedRecoveryResult(error);
        }
      });
    },
    async recordTurnSettled(input) {
      return runWorkspace(input.workspaceId, async () => {
        try {
          return await bindings.recordTurnSettled(input);
        } catch (error) {
          return failedRecoveryResult(error);
        }
      });
    },
    async resolveEntry(input) {
      return runWorkspace(input.workspaceId, async () => {
        try {
          return await bindings.resolveEntry(input);
        } catch (error) {
          return failedRecoveryResult(error);
        }
      });
    },
    async prepareRestore(input) {
      try {
        return { plan: await restore.prepare(input), status: 'ready' };
      } catch (error) {
        return failedRecoveryResult(error);
      }
    },
    async prepareCombinedRecovery(input) {
      try {
        return { plan: await combined.prepare(input), status: 'ready' };
      } catch (error) {
        return failedRecoveryResult(error);
      }
    },
    async prepareCombinedUndo(operationId) {
      try {
        return { plan: await combined.prepareUndo(operationId), status: 'ready' };
      } catch (error) {
        return failedRecoveryResult(error);
      }
    },
    async applyCombinedRecovery(input) {
      try {
        return { operation: await combined.apply(input), status: 'ready' };
      } catch (error) {
        return failedRecoveryResult(error);
      }
    },
    async getCombinedOperation(operationId) {
      try {
        return { operation: await combined.get(operationId), status: 'ready' };
      } catch (error) {
        return failedRecoveryResult(error);
      }
    },
    async listCombinedOperations(workspaceId) {
      try {
        await inspectIdentity(workspaceId);
        return { operations: await combined.list(workspaceId), status: 'ready' };
      } catch (error) {
        return failedRecoveryResult(error);
      }
    },
    async cancelCombinedOperation(operationId) {
      try {
        return { operation: await combined.cancel(operationId), status: 'ready' };
      } catch (error) {
        return failedRecoveryResult(error);
      }
    },
    async applyRestore(input) {
      try {
        return { operation: await restore.apply(input), status: 'ready' };
      } catch (error) {
        return failedRecoveryResult(error);
      }
    },
    async getOperation(operationId) {
      try {
        return { operation: await restore.get(operationId), status: 'ready' };
      } catch (error) {
        return failedRecoveryResult(error);
      }
    },
    async cancelOperation(operationId) {
      try {
        return { operation: await restore.cancel(operationId), status: 'ready' };
      } catch (error) {
        return failedRecoveryResult(error);
      }
    },
    async listSnapshots(input) {
      return runWorkspace(input.workspaceId, async () => {
        try {
          return await listSnapshotsInternal(await inspectIdentity(input.workspaceId), input);
        } catch (error) {
          return failedRecoveryResult(error);
        }
      });
    },
    async readSnapshot(input) {
      return runWorkspace(input.workspaceId, async () => {
        try {
          return await readSnapshotInternal(await inspectIdentity(input.workspaceId), input);
        } catch (error) {
          return failedRecoveryResult(error);
        }
      });
    },
    async diffSnapshots(input) {
      return runWorkspace(input.workspaceId, async () => {
        try {
          return await diffSnapshotsInternal(await inspectIdentity(input.workspaceId), input);
        } catch (error) {
          return failedRecoveryResult(error, 'snapshot-unavailable');
        }
      });
    },
    async storageStatus(workspaceId) {
      try {
        const identity = workspaceId ? await inspectIdentity(workspaceId) : null;
        return { status: 'ready', storage: await storageStatusInternal(identity) };
      } catch (error) {
        return failedRecoveryResult(error);
      }
    },
    async listStorageWorkspaces() {
      try {
        if (typeof documents.listWorkspaceRegistrations !== 'function') {
          throw new RecoveryPrimitiveError('unavailable', 'Workspace registration inventory is unavailable');
        }
        const registrations = await documents.listWorkspaceRegistrations();
        const workspaces = await Promise.all(registrations.map(storageWorkspaceSummary));
        workspaces.sort((left, right) => (
          (right.lastActivityAt ?? '').localeCompare(left.lastActivityAt ?? '')
          || left.canonicalRoot.localeCompare(right.canonicalRoot)
        ));
        return { status: 'ready', workspaces };
      } catch (error) {
        return failedRecoveryResult(error);
      }
    },
    async setDefaultStorageLocation(location) {
      try {
        const normalized = await locations.validateLocation(location);
        await locations.setDefault(normalized);
        return { status: 'ready', storage: await storageStatusInternal(null) };
      } catch (error) {
        return failedRecoveryResult(error, 'storage-move-failed');
      }
    },
    async setStorageLocation(input) {
      return runWorkspace(input.workspaceId, async () => {
        try {
          await recoverMoveOperations();
          const operation = await runStorageMove(input.workspaceId, async () => (
            moveStorageInternal(await inspectIdentity(input.workspaceId), input.location)
          ));
          return { operation, status: 'ready' };
        } catch (error) {
          return failedRecoveryResult(error, 'storage-move-failed');
        }
      });
    },
    async clearStorageLocationOverride(workspaceId) {
      return runWorkspace(workspaceId, async () => {
        try {
          await recoverMoveOperations();
          const identity = await inspectIdentity(workspaceId);
          const global = await locations.globalSelection();
          const operation = await runStorageMove(workspaceId, () => (
            moveStorageInternal(identity, global.location, {
              expectedDefaultLocation: global.location,
              source: 'global',
            })
          ));
          return { operation, status: 'ready' };
        } catch (error) {
          return failedRecoveryResult(error, 'storage-move-failed');
        }
      });
    },
    async getStorageMove(operationId) {
      try {
        await recoverMoveOperations();
        return { operation: publicMoveOperation(await validateMoveRoots(await readMove(operationId))), status: 'ready' };
      } catch (error) {
        return failedRecoveryResult(error);
      }
    },
    async cleanupStorage(input) {
      return runWorkspace(input.workspaceId, async () => {
        try {
          return { result: await cleanupInternal(await inspectMaintenanceIdentity(input.workspaceId)), status: 'ready' };
        } catch (error) {
          return failedRecoveryResult(error);
        }
      });
    },
    async deleteWorkspaceHistory(workspaceId) {
      return runWorkspace(workspaceId, async () => {
        try {
          const result = await deleteHistoryInternal(await inspectMaintenanceIdentity(workspaceId));
          if (result.status === 'complete') {
            await combined.deleteWorkspaceOperations(workspaceId);
            await restore.deleteWorkspaceOperations(workspaceId);
          }
          return { result, status: 'ready' };
        } catch (error) {
          return failedRecoveryResult(error);
        }
      });
    },
  };
};
