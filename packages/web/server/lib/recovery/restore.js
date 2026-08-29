import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  hashFileStream,
  inspectStoredSnapshot,
  objectPath,
  openRecoveryCatalog,
  recordCatalogOperation,
  verifyRecoveryObject,
} from './catalog.js';
import { RecoveryPrimitiveError, recoveryFailure } from './errors.js';
import { writeRecoveryJsonAtomic } from './locations.js';
import { portableSymlinkTarget } from './symlink-target.js';

const OPERATION_SCHEMA_VERSION = 1;
const PRE_DECISION_STATES = new Set(['planned', 'staged']);

const canonicalJson = (value) => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  throw new RecoveryPrimitiveError('invalid-request', 'Restore plan contains a non-JSON value');
};

const planRevision = (plan) => `sha256-${createHash('sha256').update(canonicalJson(plan)).digest('hex')}`;
const depth = (value) => value === '.' ? 0 : value.split('/').length;

const pathInside = (candidate, root, pathModule) => {
  const left = pathModule.resolve(candidate);
  const right = pathModule.resolve(root);
  const normalizedLeft = process.platform === 'win32' ? left.toLowerCase() : left;
  const normalizedRight = process.platform === 'win32' ? right.toLowerCase() : right;
  return normalizedLeft === normalizedRight || normalizedLeft.startsWith(`${normalizedRight}${pathModule.sep}`);
};

const samePath = (left, right, pathModule) => {
  const resolvedLeft = pathModule.resolve(left);
  const resolvedRight = pathModule.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
};

const pathExists = async (target, fsPromises) => {
  try {
    await fsPromises.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};

const resolveTarget = (root, relativePath, pathModule) => {
  if (relativePath === '.') return pathModule.resolve(root);
  const target = pathModule.resolve(root, ...relativePath.split('/'));
  if (!pathInside(target, root, pathModule)) {
    throw new RecoveryPrimitiveError('workspace-untrusted', `Restore path escapes workspace: ${relativePath}`);
  }
  return target;
};

const readRows = (database, snapshotId) => database.prepare(`
  SELECT * FROM snapshot_entries WHERE snapshot_id = ? ORDER BY path COLLATE BINARY
`).all(snapshotId);

const excludedAncestor = (targetRows, relativePath) => {
  const parts = relativePath.split('/');
  for (let index = parts.length; index > 0; index -= 1) {
    const candidate = parts.slice(0, index).join('/');
    const row = targetRows.get(candidate);
    if (row?.coverage === 'excluded-unknown' || row?.kind === 'excluded') return true;
  }
  return false;
};

const metadataChanged = (left, right) => (
  left?.mode !== right?.mode
  || left?.readonly !== right?.readonly
  || left?.executable !== right?.executable
  || platformMetadata(left).hardlinkGroup !== platformMetadata(right).hardlinkGroup
);

const platformMetadata = (row) => {
  if (!row?.platform_json) return {};
  try {
    const value = JSON.parse(row.platform_json);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    throw new RecoveryPrimitiveError('snapshot-malformed', `Snapshot metadata is malformed: ${row.path}`);
  }
};

const operationForPresent = (row, current) => {
  if (row.kind === 'directory') {
    if (!current || current.kind !== 'directory') return { kind: row.kind, path: row.path, type: 'mkdir' };
    if (metadataChanged(row, current)) return { kind: row.kind, path: row.path, type: 'metadata' };
    return null;
  }
  if (row.kind === 'regular-file') {
    if (!current
      || current.kind !== row.kind
      || current.object_hash !== row.object_hash
      || metadataChanged(row, current)) {
      return {
        byteLength: row.byte_length ?? 0,
        kind: row.kind,
        objectHash: row.object_hash,
        path: row.path,
        type: 'write',
      };
    }
    return null;
  }
  if (row.kind === 'symlink') {
    if (!current || current.kind !== row.kind || current.symlink_target !== row.symlink_target) {
      return { kind: row.kind, path: row.path, type: 'symlink' };
    }
    return null;
  }
  return null;
};

const sortOperations = (operations) => operations.toSorted((left, right) => {
  const rank = { mkdir: 0, write: 1, symlink: 1, metadata: 2, delete: 3 };
  const rankDiff = rank[left.type] - rank[right.type];
  if (rankDiff !== 0) return rankDiff;
  if (left.type === 'delete') return depth(right.path) - depth(left.path) || right.path.localeCompare(left.path);
  return depth(left.path) - depth(right.path) || left.path.localeCompare(right.path);
});

const buildPlans = (database, targetSnapshotId, safetySnapshotId) => {
  const target = readRows(database, targetSnapshotId);
  const safety = readRows(database, safetySnapshotId);
  const targetByPath = new Map(target.map((row) => [row.path, row]));
  const safetyByPath = new Map(safety.map((row) => [row.path, row]));
  const safetyByComparison = new Map(safety.map((row) => [row.comparison_key, row]));
  const consumedSafetyPaths = new Set();
  const targetConflicts = [];
  const inPlaceConflicts = [];
  const newWorkspaceOperations = [];
  const inPlaceOperations = [];

  for (const row of target) {
    if (row.path === '.' || row.coverage === 'excluded-unknown' || row.kind === 'excluded') continue;
    if (row.coverage !== 'present' || row.kind === 'unsupported' || !['directory', 'regular-file', 'symlink'].includes(row.kind)) {
      targetConflicts.push({
        code: 'snapshot-incomplete',
        message: row.reason || `Snapshot entry cannot be materialized: ${row.path}`,
        path: row.path,
      });
      continue;
    }
    const full = operationForPresent(row, null);
    if (full) newWorkspaceOperations.push(full);
    let current = safetyByPath.get(row.path);
    if (!current) {
      const comparisonMatch = safetyByComparison.get(row.comparison_key);
      if (comparisonMatch && comparisonMatch.path !== row.path) {
        current = comparisonMatch;
        consumedSafetyPaths.add(comparisonMatch.path);
        inPlaceConflicts.push({
          code: 'unsupported-metadata',
          message: `Case-only path changes require new-workspace restore: ${comparisonMatch.path} -> ${row.path}`,
          path: row.path,
        });
      }
    }
    const changed = operationForPresent(row, current);
    if (changed) inPlaceOperations.push(changed);
  }

  for (const row of safety) {
    if (row.path === '.' || row.coverage !== 'present' || targetByPath.has(row.path) || consumedSafetyPaths.has(row.path)) continue;
    if (excludedAncestor(targetByPath, row.path)) continue;
    inPlaceOperations.push({ kind: row.kind, path: row.path, type: 'delete' });
  }

  return {
    inPlaceConflicts,
    targetConflicts,
    inPlaceOperations: sortOperations(inPlaceOperations),
    newWorkspaceOperations: sortOperations(newWorkspaceOperations),
  };
};

const publicOperation = (record) => ({
  appliedOperations: record.appliedOperations,
  createdAt: record.createdAt,
  destinationPath: record.destinationPath || record.plan.newWorkspacePath,
  id: record.id,
  planRevision: record.plan.revision,
  safetySnapshotId: record.plan.safetySnapshotId,
  state: record.state,
  targetSnapshotId: record.plan.targetSnapshotId,
  totalOperations: record.totalOperations,
  updatedAt: record.updatedAt,
  workspaceId: record.plan.workspaceId,
  ...(record.compensation?.snapshotId ? { compensatedSnapshotId: record.compensation.snapshotId } : {}),
  ...(record.completionHold ? { completionHold: record.completionHold } : {}),
  ...(record.failure ? { failure: record.failure } : {}),
  ...(record.mode ? { mode: record.mode } : {}),
  ...(record.restoredSnapshotId ? { restoredSnapshotId: record.restoredSnapshotId } : {}),
});

const assertOperationRecord = (value, operationId) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== OPERATION_SCHEMA_VERSION
    || value.kind !== 'workspace-restore'
    || value.id !== operationId
    || !value.plan
    || typeof value.state !== 'string') {
    throw new RecoveryPrimitiveError('storage-malformed', `Restore operation is malformed: ${operationId}`);
  }
  return value;
};

export const createWorkspaceRestoreManager = ({
  captureSnapshot,
  documents,
  faults = {},
  fsModule,
  fsPromises,
  gitInspector = async () => ({ available: true, repository: false, staged: false }),
  inspectIdentity,
  locations,
  pathModule = path,
  storageFor,
}) => {
  const operationQueues = new Map();
  const workspaceQueues = new Map();
  const operationPath = (operationId) => pathModule.join(locations.operationsRoot, `restore-${operationId}.json`);

  const runOperation = (operationId, operation) => {
    const previous = operationQueues.get(operationId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    operationQueues.set(operationId, current);
    void current.finally(() => {
      if (operationQueues.get(operationId) === current) operationQueues.delete(operationId);
    }).catch(() => undefined);
    return current;
  };

  const runWorkspace = (workspaceId, operation) => {
    const previous = workspaceQueues.get(workspaceId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    workspaceQueues.set(workspaceId, current);
    void current.finally(() => {
      if (workspaceQueues.get(workspaceId) === current) workspaceQueues.delete(workspaceId);
    }).catch(() => undefined);
    return current;
  };

  const writeOperation = async (record, database) => {
    record.updatedAt = new Date().toISOString();
    await writeRecoveryJsonAtomic(operationPath(record.id), record, { fsPromises, pathModule });
    if (database) {
      recordCatalogOperation(database, {
        createdAt: record.createdAt,
        data: {
          appliedOperations: record.appliedOperations,
          mode: record.mode,
          planRevision: record.plan.revision,
          totalOperations: record.totalOperations,
        },
        id: record.id,
        state: record.state,
        type: 'workspace-restore',
        updatedAt: record.updatedAt,
        workspaceId: record.plan.workspaceId,
      });
    }
  };

  const readOperation = async (operationId) => {
    try {
      return assertOperationRecord(JSON.parse(await fsPromises.readFile(operationPath(operationId), 'utf8')), operationId);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new RecoveryPrimitiveError('operation-not-found', `Unknown restore operation: ${operationId}`);
      if (error instanceof RecoveryPrimitiveError) throw error;
      throw new RecoveryPrimitiveError('storage-malformed', `Restore operation cannot be read: ${operationId}`, { cause: error });
    }
  };

  const listOperationRecords = async () => {
    let entries;
    try {
      entries = await fsPromises.readdir(locations.operationsRoot);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const records = [];
    for (const name of entries) {
      if (!name.startsWith('restore-') || !name.endsWith('.json')) continue;
      const operationId = name.slice('restore-'.length, -'.json'.length);
      records.push(await readOperation(operationId));
    }
    return records;
  };

  const stageOperation = async (record, database, storeRoot, operations) => {
    if (record.state !== 'planned') return;
    const stageRoot = pathModule.join(storeRoot, 'staging', `restore-${record.id}`);
    const stagedBytes = operations.reduce((total, operation) => total + (operation.byteLength ?? 0), 0);
    await ensureFreeSpace(storeRoot, stagedBytes);
    await fsPromises.rm(stageRoot, { force: true, recursive: true });
    for (const operation of operations) {
      const target = resolveTarget(stageRoot, operation.path, pathModule);
      if (operation.type === 'mkdir') {
        await fsPromises.mkdir(target, { recursive: true, mode: 0o700 });
      } else if (operation.type === 'write') {
        await verifyRecoveryObject(storeRoot, operation.objectHash, { fsModule });
        await fsPromises.mkdir(pathModule.dirname(target), { recursive: true, mode: 0o700 });
        await fsPromises.copyFile(objectPath(storeRoot, operation.objectHash), target);
        const stagedHash = await hashFileStream(target, fsModule);
        if (stagedHash.objectHash !== operation.objectHash) {
          throw new RecoveryPrimitiveError('object-corrupt', `Staged object failed verification: ${operation.path}`);
        }
      } else if (operation.type === 'symlink') {
        await fsPromises.mkdir(pathModule.dirname(target), { recursive: true, mode: 0o700 });
        const row = record.targetEntries[operation.path];
        await fsPromises.symlink(row.symlink_target, target);
        if (portableSymlinkTarget(await fsPromises.readlink(target)) !== row.symlink_target) {
          throw new RecoveryPrimitiveError('unsupported-metadata', `Symlink staging failed: ${operation.path}`);
        }
      }
    }
    await faults.afterStage?.({ operationId: record.id, stageRoot });
    record.stageRoot = stageRoot;
    record.state = 'staged';
    await writeOperation(record, database);
  };

  const ensureFreeSpace = async (directory, byteLength) => {
    if (typeof fsPromises.statfs !== 'function') return;
    const info = await fsPromises.statfs(directory);
    const available = Number(info.bavail) * Number(info.bsize);
    if (Number.isFinite(available) && available < byteLength) {
      throw new RecoveryPrimitiveError('insufficient-space', 'Restore destination does not have enough free space', {
        details: { availableBytes: available, requiredBytes: byteLength },
      });
    }
  };

  const removeOrBackup = async (target, backup) => {
    if (await pathExists(backup, fsPromises)) return true;
    try {
      await fsPromises.rename(target, backup);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  };

  const assertAuxiliaryPathsAvailable = async (record, root, operations) => {
    for (let index = 0; index < operations.length; index += 1) {
      if (operations[index].type === 'metadata') continue;
      const target = resolveTarget(root, operations[index].path, pathModule);
      const token = `${record.id}-${index}`;
      for (const candidate of [
        pathModule.join(pathModule.dirname(target), `.piarium-restore-${token}.tmp`),
        pathModule.join(pathModule.dirname(target), `.piarium-restore-${token}.previous`),
      ]) {
        try {
          await fsPromises.lstat(candidate);
          throw new RecoveryPrimitiveError('locked-path', `Restore staging path already exists: ${candidate}`);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    }
  };

  const preflightHardlinks = async (record, directory) => {
    if (!record.hardlinkLeaders || Object.keys(record.hardlinkLeaders).length === 0) return;
    const source = pathModule.join(directory, `.piarium-hardlink-${record.id}.source`);
    const target = pathModule.join(directory, `.piarium-hardlink-${record.id}.target`);
    try {
      await fsPromises.writeFile(source, '', { flag: 'wx' });
      await fsPromises.link(source, target);
      const [sourceStat, targetStat] = await Promise.all([fsPromises.stat(source), fsPromises.stat(target)]);
      if (sourceStat.dev !== targetStat.dev || sourceStat.ino !== targetStat.ino) {
        throw new Error('filesystem did not preserve hardlink identity');
      }
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new RecoveryPrimitiveError('locked-path', 'Hardlink preflight path already exists', { cause: error });
      }
      throw new RecoveryPrimitiveError('unsupported-metadata', 'Restore destination does not support required hardlinks', {
        cause: error,
      });
    } finally {
      await fsPromises.rm(target, { force: true }).catch(() => undefined);
      await fsPromises.rm(source, { force: true }).catch(() => undefined);
    }
  };

  const applyOne = async (record, operation, index, root) => {
    const target = resolveTarget(root, operation.path, pathModule);
    const token = `${record.id}-${index}`;
    const temporary = pathModule.join(pathModule.dirname(target), `.piarium-restore-${token}.tmp`);
    const backup = pathModule.join(pathModule.dirname(target), `.piarium-restore-${token}.previous`);
    const retainBackup = record.completionHold === 'conversation';
    if (operation.type === 'delete') {
      const moved = await removeOrBackup(target, backup);
      if (moved && !retainBackup) await fsPromises.rm(backup, { force: true, recursive: true });
      return;
    }
    if (operation.type === 'mkdir') {
      try {
        const stat = await fsPromises.lstat(target);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          await removeOrBackup(target, backup);
          await fsPromises.rm(target, { force: true, recursive: true });
          await fsPromises.mkdir(target, { recursive: true });
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await fsPromises.mkdir(target, { recursive: true });
      }
      const row = record.targetEntries[operation.path];
      if (row?.mode !== null && row?.mode !== undefined) await fsPromises.chmod(target, row.mode);
      if (!retainBackup) await fsPromises.rm(backup, { force: true, recursive: true });
      return;
    }
    if (operation.type === 'metadata') {
      const row = record.targetEntries[operation.path];
      if (row?.mode !== null && row?.mode !== undefined) await fsPromises.chmod(target, row.mode);
      return;
    }
    await fsPromises.mkdir(pathModule.dirname(target), { recursive: true });
    await fsPromises.rm(temporary, { force: true, recursive: true });
    if (operation.type === 'write') {
      const hardlinkLeader = record.hardlinkLeaders?.[operation.path];
      if (hardlinkLeader) {
        await fsPromises.link(resolveTarget(root, hardlinkLeader, pathModule), temporary);
      } else {
        const staged = resolveTarget(record.stageRoot, operation.path, pathModule);
        await fsPromises.copyFile(staged, temporary);
      }
      const handle = await fsPromises.open(temporary, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
    } else if (operation.type === 'symlink') {
      const row = record.targetEntries[operation.path];
      await fsPromises.symlink(row.symlink_target, temporary);
    }
    const moved = await removeOrBackup(target, backup);
    try {
      await fsPromises.rm(target, { force: true, recursive: true });
      await fsPromises.rename(temporary, target);
    } catch (error) {
      if (moved && !await pathExists(target, fsPromises)) {
        await fsPromises.rename(backup, target).catch(() => undefined);
      }
      throw error;
    }
    if (!retainBackup) await fsPromises.rm(backup, { force: true, recursive: true });
    const row = record.targetEntries[operation.path];
    if (operation.type === 'write' && row?.mode !== null && row?.mode !== undefined) {
      await fsPromises.chmod(target, row.mode);
    }
  };

  const verifyMaterialized = async (record, root, operations) => {
    for (const operation of operations) {
      const target = resolveTarget(root, operation.path, pathModule);
      if (operation.type === 'delete') {
        await fsPromises.lstat(target).then(
          () => { throw new RecoveryPrimitiveError('needs-attention', `Deleted path still exists: ${operation.path}`); },
          (error) => { if (error?.code !== 'ENOENT') throw error; },
        );
        continue;
      }
      const row = record.targetEntries[operation.path];
      const stat = await fsPromises.lstat(target);
      if (row.mode !== null && row.mode !== undefined && (stat.mode & 0o7777) !== row.mode) {
        throw new RecoveryPrimitiveError('needs-attention', `Restored metadata differs: ${operation.path}`);
      }
      if (row.kind === 'directory' && (!stat.isDirectory() || stat.isSymbolicLink())) {
        throw new RecoveryPrimitiveError('needs-attention', `Restored directory has the wrong kind: ${operation.path}`);
      }
      if (row.kind === 'symlink') {
        if (!stat.isSymbolicLink()
          || portableSymlinkTarget(await fsPromises.readlink(target)) !== row.symlink_target) {
          throw new RecoveryPrimitiveError('needs-attention', `Restored symlink differs: ${operation.path}`);
        }
      }
      if (row.kind === 'regular-file') {
        const hashed = await hashFileStream(target, fsModule);
        if (hashed.objectHash !== row.object_hash) {
          throw new RecoveryPrimitiveError('needs-attention', `Restored file failed verification: ${operation.path}`);
        }
        const hardlinkLeader = record.hardlinkLeaders?.[operation.path];
        if (hardlinkLeader) {
          const [leaderStat, targetStat] = await Promise.all([
            fsPromises.stat(resolveTarget(root, hardlinkLeader, pathModule)),
            fsPromises.stat(target),
          ]);
          if (leaderStat.dev !== targetStat.dev || leaderStat.ino !== targetStat.ino) {
            throw new RecoveryPrimitiveError('needs-attention', `Restored hardlink differs: ${operation.path}`);
          }
        }
      }
    }
  };

  const materialize = async (record, root, operations, database) => {
    for (let index = record.appliedOperations; index < operations.length; index += 1) {
      await applyOne(record, operations[index], index, root);
      record.appliedOperations = index + 1;
      record.state = 'applying-workspace';
      await writeOperation(record, database);
      await faults.afterApplyOperation?.({ index, operationId: record.id, path: operations[index].path });
    }
    const rootEntry = record.targetEntries['.'];
    if (rootEntry?.mode !== null && rootEntry?.mode !== undefined) {
      await fsPromises.chmod(root, rootEntry.mode);
    }
    await verifyMaterialized(record, root, operations);
    if (rootEntry?.mode !== null && rootEntry?.mode !== undefined) {
      const rootStat = await fsPromises.lstat(root);
      if ((rootStat.mode & 0o7777) !== rootEntry.mode) {
        throw new RecoveryPrimitiveError('needs-attention', 'Restored workspace root metadata differs');
      }
    }
    record.state = 'workspace-verified';
    await writeOperation(record, database);
  };

  const prepare = async (input) => {
    const identity = await inspectIdentity(input.workspaceId);
    const storage = await storageFor(identity);
    const database = await openRecoveryCatalog(storage.root, { create: false, fsPromises });
    if (!database) throw new RecoveryPrimitiveError('snapshot-missing', `Unknown workspace snapshot: ${input.targetSnapshotId}`);
    try {
      // Planning reads manifests and computes a preview. Hashing every stored
      // object here can turn opening the dialog into a multi-minute operation;
      // apply/staging verifies each object before it can affect a workspace.
      const target = await inspectStoredSnapshot(
        database,
        storage.root,
        identity.workspaceId,
        input.targetSnapshotId,
        { fsModule, verifyObjects: false },
      );
      if (target.availability !== 'ready') {
        throw target.error ?? new RecoveryPrimitiveError('snapshot-incomplete', 'Target workspace snapshot is not ready');
      }
    } finally {
      database.close();
    }

    const initialState = await documents.inspectMutation(identity.workspaceId);
    if (initialState.maintenance) {
      throw new RecoveryPrimitiveError('recovery-in-progress', 'Workspace is already in recovery maintenance');
    }
    const safety = await captureSnapshot({
      reuseIfUnchanged: true,
      source: 'safety',
      workspaceId: identity.workspaceId,
    });
    if (safety.status !== 'captured') throw new RecoveryPrimitiveError('snapshot-incomplete', 'Current workspace safety checkpoint failed');
    const currentState = await documents.inspectMutation(identity.workspaceId);
    const witnessChanged = currentState.epoch !== safety.witness.epoch
      || currentState.mutationRevision !== safety.witness.mutationRevision
      || currentState.writerRevision !== safety.witness.writerRevision;
    const reopened = await openRecoveryCatalog(storage.root, { create: false, fsPromises });
    try {
      const built = buildPlans(reopened, input.targetSnapshotId, safety.snapshot.id);
      const targetRows = readRows(reopened, input.targetSnapshotId);
      const safetyRows = readRows(reopened, safety.snapshot.id);
      const targetEntries = Object.fromEntries(targetRows.map((row) => [row.path, row]));
      const safetyEntries = Object.fromEntries(safetyRows.map((row) => [row.path, row]));
      const hardlinkLeaders = {};
      const hardlinkGroups = new Map();
      for (const operation of built.newWorkspaceOperations) {
        if (operation.type !== 'write') continue;
        const group = platformMetadata(targetEntries[operation.path]).hardlinkGroup;
        if (typeof group !== 'string' || !group) continue;
        const leader = hardlinkGroups.get(group);
        if (leader) hardlinkLeaders[operation.path] = leader;
        else hardlinkGroups.set(group, operation.path);
      }
      const journals = (await documents.listRecoveryJournals({ workspaceId: identity.workspaceId }))
        .filter((journal) => journal.epoch === currentState.epoch);
      const liveDirty = await documents.inspectDirtyBuffers(identity.workspaceId);
      const dirtyResources = new Set([
        ...journals.map((journal) => journal.resource.resourceId),
        ...liveDirty.flatMap((owner) => owner.resources.map((entry) => entry.resource.resourceId)),
      ]);
      const git = await gitInspector(identity.canonicalRoot).catch(() => ({
        available: false,
        repository: false,
        staged: false,
      }));
      const activeWriterScopes = currentState.activeWriters.map((writer) => (
        `${writer.owner.kind}:${writer.owner.id}${writer.owner.generation === undefined ? '' : `@${writer.owner.generation}`}`
      ));
      const conflicts = [...built.targetConflicts, ...built.inPlaceConflicts];
      if (safety.snapshot.availability !== 'ready') {
        conflicts.push({ code: 'snapshot-incomplete', message: 'Current workspace safety checkpoint is incomplete' });
      }
      if (witnessChanged) conflicts.push({ code: 'stale-plan', message: 'Workspace changed after its safety checkpoint' });
      if (dirtyResources.size > 0) conflicts.push({ code: 'dirty-buffers', message: 'Unsaved document buffers are present' });
      if (activeWriterScopes.length > 0) conflicts.push({ code: 'active-writer', message: 'Workspace writers are active' });
      if (!git.available) conflicts.push({ code: 'unavailable', message: 'Git state could not be inspected' });
      if (git.staged) conflicts.push({ code: 'navigation-conflict', message: 'Git has staged changes' });
      if (git.operation) conflicts.push({ code: 'navigation-conflict', message: `Git operation is active: ${git.operation}` });
      const targetConflicts = built.targetConflicts.length > 0;
      const allowedModes = targetConflicts
        ? []
        : conflicts.length > 0 ? ['new-workspace'] : ['in-place', 'new-workspace'];
      if (allowedModes.length === 0) {
        throw new RecoveryPrimitiveError('snapshot-incomplete', 'Target snapshot cannot be materialized', {
          details: { conflicts },
        });
      }
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const recommendedMode = conflicts.length > 0 ? 'new-workspace' : 'in-place';
      const displayedOperations = recommendedMode === 'new-workspace'
        ? built.newWorkspaceOperations
        : built.inPlaceOperations;
      const suggested = input.newWorkspacePath
        ? pathModule.resolve(input.newWorkspacePath)
        : pathModule.join(
            pathModule.dirname(identity.canonicalRoot),
            `${pathModule.basename(identity.canonicalRoot)}-recovered-${id.slice(0, 8)}`,
          );
      if (pathInside(suggested, identity.canonicalRoot, pathModule)
        || pathInside(identity.canonicalRoot, suggested, pathModule)
        || pathInside(suggested, storage.root, pathModule)
        || pathInside(storage.root, suggested, pathModule)) {
        throw new RecoveryPrimitiveError(
          'invalid-request',
          'A recovered workspace must be outside the current workspace tree',
        );
      }
      const draft = {
        activeWriterScopes,
        allowedModes,
        conflicts,
        createdAt,
        dirtyBufferCount: dirtyResources.size,
        git: {
          available: git.available === true,
          repository: git.repository === true,
          staged: git.staged === true,
          ...(git.operation ? { operation: String(git.operation) } : {}),
        },
        id,
        newWorkspacePath: suggested,
        operationCount: displayedOperations.length,
        operations: displayedOperations,
        recommendedMode,
        safetySnapshotId: safety.snapshot.id,
        targetSnapshotId: input.targetSnapshotId,
        // The dialog describes the recommended action, not the logical size of
        // the entire target revision. A no-op in-place rollback must read 0 B,
        // even when the workspace itself contains hundreds of megabytes.
        totalBytes: displayedOperations.reduce((total, operation) => total + (operation.byteLength ?? 0), 0),
        witness: safety.witness,
        workspaceId: identity.workspaceId,
      };
      const plan = { ...draft, revision: planRevision(draft) };
      const record = {
        appliedOperations: 0,
        createdAt,
        destinationPath: '',
        failure: null,
        hardlinkLeaders,
        id,
        inPlaceOperations: built.inPlaceOperations,
        inPlaceRequiredBytes: built.inPlaceOperations.reduce(
          (largest, operation) => Math.max(largest, operation.byteLength ?? 0),
          0,
        ),
        kind: 'workspace-restore',
        mode: null,
        newWorkspaceOperations: built.newWorkspaceOperations,
        plan,
        safetyEntries,
        schemaVersion: OPERATION_SCHEMA_VERSION,
        stageRoot: null,
        state: 'planned',
        targetEntries,
        totalOperations: built.inPlaceOperations.length,
        updatedAt: createdAt,
      };
      reopened.transaction(() => {
        reopened.prepare(`
          INSERT OR IGNORE INTO pins(snapshot_id, kind, key, created_at) VALUES (?, 'restore-safety', ?, ?)
        `).run(plan.safetySnapshotId, id, createdAt);
        reopened.prepare(`
          INSERT OR IGNORE INTO pins(snapshot_id, kind, key, created_at) VALUES (?, 'restore-target', ?, ?)
        `).run(plan.targetSnapshotId, id, createdAt);
      })();
      await writeOperation(record, reopened);
      return plan;
    } finally {
      reopened.close();
    }
  };

  const applyInternal = async (input) => {
    const record = await readOperation(input.operationId);
    if (record.plan.revision !== input.expectedRevision) {
      throw new RecoveryPrimitiveError('stale-plan', 'Restore plan revision is stale');
    }
    if (!record.plan.allowedModes.includes(input.mode)) {
      throw new RecoveryPrimitiveError('invalid-request', `Restore mode is not allowed: ${input.mode}`);
    }
    if (record.state === 'complete' || record.state === 'needs-attention') return publicOperation(record);
    if (record.state === 'aborted') throw new RecoveryPrimitiveError('recovery-in-progress', 'Restore operation was cancelled');
    if (input.holdForConversation === true && input.mode !== 'in-place') {
      throw new RecoveryPrimitiveError('invalid-request', 'Conversation coordination can only hold an in-place restore');
    }
    record.failure = null;
    const identity = await inspectIdentity(record.plan.workspaceId);
    let maintenanceAcquired = false;
    const releaseMaintenance = async ({ force = false } = {}) => {
      if (!force && !maintenanceAcquired) return;
      await documents.setMaintenance(identity.workspaceId, false);
      maintenanceAcquired = false;
    };
    const storage = await storageFor(identity);
    const database = await openRecoveryCatalog(storage.root, { create: false, fsPromises });
    if (!database) throw new RecoveryPrimitiveError('storage-malformed', 'Recovery catalog is unavailable');
    try {
      if (input.holdForConversation === true && record.completionHold !== 'conversation') {
        if (!PRE_DECISION_STATES.has(record.state)) {
          throw new RecoveryPrimitiveError('stale-plan', 'Restore completion mode changed after its commit decision');
        }
        record.completionHold = 'conversation';
        await writeOperation(record, database);
      }
      if (record.mode && record.mode !== input.mode) {
        if (!PRE_DECISION_STATES.has(record.state)) {
          throw new RecoveryPrimitiveError('stale-plan', 'Restore mode changed after its commit decision');
        }
        if (record.stageRoot) await fsPromises.rm(record.stageRoot, { force: true, recursive: true });
        record.appliedOperations = 0;
        record.stageRoot = null;
        record.state = 'planned';
        if (input.mode !== 'in-place') record.completionHold = null;
      }
      record.mode = input.mode;
      await writeOperation(record, database);
      const stagingOperations = input.mode === 'new-workspace'
        ? record.newWorkspaceOperations
        : record.inPlaceOperations;
      await stageOperation(record, database, storage.root, stagingOperations);
      if (input.mode === 'new-workspace') {
        const destination = pathModule.resolve(input.newWorkspacePath || record.plan.newWorkspacePath);
        if (!samePath(destination, record.plan.newWorkspacePath, pathModule)) {
          throw new RecoveryPrimitiveError('stale-plan', 'New workspace destination differs from the prepared plan');
        }
        const parent = pathModule.dirname(destination);
        await fsPromises.mkdir(parent, { recursive: true });
        await ensureFreeSpace(parent, record.plan.totalBytes);
        await preflightHardlinks(record, parent);
        let destinationExists = false;
        try {
          await fsPromises.lstat(destination);
          destinationExists = true;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        if (destinationExists) {
          if (record.state !== 'workspace-verified') {
            throw new RecoveryPrimitiveError('locked-path', `Restore destination already exists: ${destination}`);
          }
          await verifyMaterialized(record, destination, record.newWorkspaceOperations);
          record.destinationPath = destination;
          record.state = 'complete';
          await writeOperation(record, database);
          await fsPromises.rm(record.stageRoot, { force: true, recursive: true });
          return publicOperation(record);
        }
        const temporaryRoot = pathModule.join(parent, `.piarium-restore-${record.id}.staging`);
        record.destinationPath = destination;
        record.totalOperations = record.newWorkspaceOperations.length;
        if (record.state === 'staged') {
          try {
            await fsPromises.lstat(temporaryRoot);
            throw new RecoveryPrimitiveError('locked-path', `Restore staging path already exists: ${temporaryRoot}`);
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
          record.appliedOperations = 0;
          record.state = 'commit-decided';
          await writeOperation(record, database);
        }
        if (record.state === 'commit-decided' && record.appliedOperations === 0) {
          await fsPromises.rm(temporaryRoot, { force: true, recursive: true });
          await fsPromises.mkdir(temporaryRoot, { recursive: true });
        }
        await materialize(record, temporaryRoot, record.newWorkspaceOperations, database);
        await faults.beforeRootSwitch?.({ destination, operationId: record.id, temporaryRoot });
        await fsPromises.rename(temporaryRoot, destination);
        record.destinationPath = destination;
      } else {
        record.destinationPath = identity.canonicalRoot;
        record.totalOperations = record.inPlaceOperations.length;
        if (record.state === 'staged' && record.inPlaceOperations.length === 0) {
          const current = await documents.inspectMutation(identity.workspaceId);
          if (current.epoch !== record.plan.witness.epoch
            || current.mutationRevision !== record.plan.witness.mutationRevision
            || current.writerRevision !== record.plan.witness.writerRevision) {
            throw new RecoveryPrimitiveError('stale-plan', 'Workspace changed after restore planning', { retryable: true });
          }
          record.restoredSnapshotId = record.plan.targetSnapshotId;
          record.verifiedWitness = {
            epoch: current.epoch,
            mutationRevision: current.mutationRevision,
            writerRevision: current.writerRevision,
          };
          record.state = record.completionHold === 'conversation' ? 'workspace-verified' : 'complete';
          await writeOperation(record, database);
          // Repairs legacy operations which persisted a workspace lock even
          // though this restore has no filesystem work to perform.
          await releaseMaintenance({ force: true });
          if (record.state === 'complete') await cleanupAuxiliaryPaths(record, identity.canonicalRoot);
          return publicOperation(record);
        }
        if (record.state === 'workspace-verified' && record.verifiedWitness) {
          // A verified workspace is a committed saga step, not a reason to keep
          // blocking the workspace while conversation navigation is pending.
          await releaseMaintenance({ force: true });
          if (record.completionHold === 'conversation') return publicOperation(record);
          record.state = 'complete';
          await writeOperation(record, database);
          await cleanupAuxiliaryPaths(record, identity.canonicalRoot);
          return publicOperation(record);
        }
        if (record.state === 'staged') {
          const current = await documents.inspectMutation(identity.workspaceId);
          if (current.epoch !== record.plan.witness.epoch
            || current.mutationRevision !== record.plan.witness.mutationRevision
            || current.writerRevision !== record.plan.witness.writerRevision) {
            throw new RecoveryPrimitiveError('stale-plan', 'Workspace changed after restore planning', { retryable: true });
          }
          const maintenance = await documents.setMaintenance(identity.workspaceId, true);
          maintenanceAcquired = true;
          if (maintenance.activeWriters.length > 0) {
            await releaseMaintenance();
            throw new RecoveryPrimitiveError('active-writer', 'Workspace has active writers', { retryable: true });
          }
          const fenced = await documents.inspectMutation(identity.workspaceId);
          if (fenced.epoch !== record.plan.witness.epoch
            || fenced.mutationRevision !== record.plan.witness.mutationRevision) {
            await releaseMaintenance();
            throw new RecoveryPrimitiveError('stale-plan', 'Workspace changed while restore maintenance was acquired', {
              retryable: true,
            });
          }
          await assertAuxiliaryPathsAvailable(record, identity.canonicalRoot, record.inPlaceOperations);
          await preflightHardlinks(record, identity.canonicalRoot);
          record.state = 'commit-decided';
          await writeOperation(record, database);
          const advanced = await documents.advanceEpoch(identity.workspaceId, {
            expectedEpoch: record.plan.witness.epoch,
          });
          record.fenceEpoch = advanced.epoch;
          record.appliedOperations = 0;
          await writeOperation(record, database);
        } else if (['commit-decided', 'applying-workspace', 'workspace-verified'].includes(record.state)) {
          const maintenance = await documents.setMaintenance(identity.workspaceId, true);
          maintenanceAcquired = true;
          if (maintenance.activeWriters.length > 0) {
            await releaseMaintenance();
            throw new RecoveryPrimitiveError('active-writer', 'Workspace has active writers', { retryable: true });
          }
        }
        if (record.state === 'commit-decided' && !record.fenceEpoch) {
          const current = await documents.inspectMutation(identity.workspaceId);
          if (current.epoch === record.plan.witness.epoch) {
            const advanced = await documents.advanceEpoch(identity.workspaceId, {
              expectedEpoch: record.plan.witness.epoch,
            });
            record.fenceEpoch = advanced.epoch;
          } else if (current.epoch === record.plan.witness.epoch + 1 && current.maintenance) {
            record.fenceEpoch = current.epoch;
          } else {
            throw new RecoveryPrimitiveError('needs-attention', 'Workspace epoch cannot be reconciled after restore decision');
          }
          await writeOperation(record, database);
        }
        await ensureFreeSpace(identity.canonicalRoot, record.inPlaceRequiredBytes ?? 0);
        await materialize(record, identity.canonicalRoot, record.inPlaceOperations, database);
        const restored = await captureSnapshot({
          allowMaintenance: true,
          restoredFrom: record.plan.targetSnapshotId,
          source: 'restore',
          workspaceId: identity.workspaceId,
        });
        if (restored.status !== 'captured' || restored.snapshot.availability !== 'ready') {
          throw new RecoveryPrimitiveError('needs-attention', 'Restored workspace could not publish its new timeline revision');
        }
        record.restoredSnapshotId = restored.snapshot.id;
        record.verifiedWitness = restored.witness;
        record.state = 'workspace-verified';
        await writeOperation(record, database);
        await releaseMaintenance();
        if (record.completionHold === 'conversation') {
          return publicOperation(record);
        }
      }
      record.state = 'complete';
      await writeOperation(record, database);
      await fsPromises.rm(record.stageRoot, { force: true, recursive: true });
      return publicOperation(record);
    } catch (error) {
      if (error?.simulatedCrash === true) throw error;
      if (record.mode === 'in-place') {
        await releaseMaintenance({ force: true }).catch(() => undefined);
      }
      if (record.state === 'planned' || record.state === 'staged') {
        record.failure = recoveryFailure(error);
        await writeOperation(record, database);
        throw error;
      }
      record.failure = recoveryFailure(error, 'needs-attention');
      record.state = 'needs-attention';
      await writeOperation(record, database);
      throw new RecoveryPrimitiveError('needs-attention', 'Restore requires attention after its durable commit decision', {
        cause: error,
        details: { operationId: record.id },
        operationId: record.id,
      });
    } finally {
      database.close();
    }
  };

  const cleanupAuxiliaryPaths = async (record, root) => {
    await Promise.all(record.inPlaceOperations.flatMap((operation, index) => {
      if (operation.type === 'metadata') return [];
      const target = resolveTarget(root, operation.path, pathModule);
      const token = `${record.id}-${index}`;
      return [
        fsPromises.rm(pathModule.join(pathModule.dirname(target), `.piarium-restore-${token}.tmp`), {
          force: true,
          recursive: true,
        }),
        fsPromises.rm(pathModule.join(pathModule.dirname(target), `.piarium-restore-${token}.previous`), {
          force: true,
          recursive: true,
        }),
      ];
    }));
    if (record.stageRoot) await fsPromises.rm(record.stageRoot, { force: true, recursive: true });
  };

  const verifyPendingInternal = async (record, database, identity) => {
    if (record.completionHold !== 'conversation'
      || !['workspace-verified', 'completion-decided'].includes(record.state)) {
      throw new RecoveryPrimitiveError('recovery-in-progress', 'Restore is not waiting for conversation navigation');
    }
    const current = await documents.inspectMutation(identity.workspaceId);
    if (current.maintenance) {
      throw new RecoveryPrimitiveError('recovery-in-progress', 'Workspace filesystem recovery is still in progress', {
        retryable: true,
      });
    }
    if (!record.verifiedWitness) {
      throw new RecoveryPrimitiveError('needs-attention', 'Workspace recovery has no committed verification witness');
    }
    if (current.epoch !== record.verifiedWitness.epoch
      || current.mutationRevision !== record.verifiedWitness.mutationRevision) {
      throw new RecoveryPrimitiveError('stale-plan', 'Workspace changed after restore verification', { retryable: true });
    }
    // The in-process mutation witness is enough for the normal fast path. After
    // a Host restart the watcher baseline is intentionally unknown, so verify
    // only the affected paths rather than rescanning the whole workspace.
    if (current.reconciliationRequired) {
      await verifyMaterialized(record, identity.canonicalRoot, record.inPlaceOperations);
    }
    await writeOperation(record, database);
    return publicOperation(record);
  };

  const finalizeInternal = async (record) => {
    const identity = await inspectIdentity(record.plan.workspaceId);
    const storage = await storageFor(identity);
    const database = await openRecoveryCatalog(storage.root, { create: false, fsPromises });
    if (!database) throw new RecoveryPrimitiveError('storage-malformed', 'Recovery catalog is unavailable');
    try {
      if (record.state === 'complete') return publicOperation(record);
      if (record.state === 'workspace-verified') {
        await verifyPendingInternal(record, database, identity);
        record.state = 'completion-decided';
        await writeOperation(record, database);
      }
      if (record.state !== 'completion-decided' || record.completionHold !== 'conversation') {
        throw new RecoveryPrimitiveError('recovery-in-progress', 'Restore is not ready to finalize');
      }
      await cleanupAuxiliaryPaths(record, identity.canonicalRoot);
      record.completionHold = null;
      record.state = 'complete';
      await writeOperation(record, database);
      return publicOperation(record);
    } finally {
      database.close();
    }
  };

  const compensateInternal = async (record) => {
    const identity = await inspectIdentity(record.plan.workspaceId);
    const storage = await storageFor(identity);
    const database = await openRecoveryCatalog(storage.root, { create: false, fsPromises });
    if (!database) throw new RecoveryPrimitiveError('storage-malformed', 'Recovery catalog is unavailable');
    let maintenanceAcquired = false;
    const releaseMaintenance = async ({ force = false } = {}) => {
      if (!force && !maintenanceAcquired) return;
      await documents.setMaintenance(identity.workspaceId, false);
      maintenanceAcquired = false;
    };
    try {
      if (record.state === 'compensated') return publicOperation(record);
      if (record.completionHold !== 'conversation'
        || !['workspace-verified', 'compensating-workspace'].includes(record.state)) {
        throw new RecoveryPrimitiveError('recovery-in-progress', 'Restore cannot be compensated in its current state');
      }
      if (!record.compensation) {
        const current = await documents.inspectMutation(identity.workspaceId);
        if (!record.verifiedWitness
          || current.epoch !== record.verifiedWitness.epoch
          || current.mutationRevision !== record.verifiedWitness.mutationRevision) {
          throw new RecoveryPrimitiveError(
            'stale-plan',
            'Workspace changed after restore verification and cannot be compensated automatically',
            { retryable: false },
          );
        }
        record.compensation = { appliedOperations: 0, fenceEpoch: null, snapshotId: null };
        record.state = 'compensating-workspace';
        await writeOperation(record, database);
      }
      const maintenance = await documents.setMaintenance(identity.workspaceId, true);
      maintenanceAcquired = true;
      if (maintenance.activeWriters.length > 0) {
        await releaseMaintenance();
        throw new RecoveryPrimitiveError('active-writer', 'Workspace has active writers', { retryable: true });
      }
      if (!record.compensation.fenceEpoch) {
        const current = await documents.inspectMutation(identity.workspaceId);
        if (current.epoch === record.verifiedWitness.epoch
          && current.mutationRevision === record.verifiedWitness.mutationRevision) {
          const advanced = await documents.advanceEpoch(identity.workspaceId, {
            expectedEpoch: record.verifiedWitness.epoch,
          });
          record.compensation.fenceEpoch = advanced.epoch;
        } else if (current.epoch === record.verifiedWitness.epoch + 1 && current.maintenance) {
          record.compensation.fenceEpoch = current.epoch;
        } else {
          throw new RecoveryPrimitiveError('needs-attention', 'Workspace compensation epoch cannot be reconciled');
        }
        await writeOperation(record, database);
      }
      for (
        let offset = record.compensation.appliedOperations;
        offset < record.inPlaceOperations.length;
        offset += 1
      ) {
        const index = record.inPlaceOperations.length - 1 - offset;
        const operation = record.inPlaceOperations[index];
        const target = resolveTarget(identity.canonicalRoot, operation.path, pathModule);
        const token = `${record.id}-${index}`;
        const temporary = pathModule.join(pathModule.dirname(target), `.piarium-restore-${token}.tmp`);
        const backup = pathModule.join(pathModule.dirname(target), `.piarium-restore-${token}.previous`);
        if (operation.type === 'metadata') {
          const safetyEntry = record.safetyEntries[operation.path];
          if (safetyEntry?.mode !== null && safetyEntry?.mode !== undefined) {
            await fsPromises.chmod(target, safetyEntry.mode);
          }
        } else {
          const safetyEntry = record.safetyEntries[operation.path];
          const backupExists = await pathExists(backup, fsPromises);
          if (safetyEntry?.coverage === 'present' && !backupExists) {
            throw new RecoveryPrimitiveError(
              'needs-attention',
              `Restore compensation backup is missing: ${operation.path}`,
            );
          }
          await fsPromises.rm(temporary, { force: true, recursive: true });
          await fsPromises.rm(target, { force: true, recursive: true });
          if (backupExists) await fsPromises.rename(backup, target);
        }
        record.compensation.appliedOperations = offset + 1;
        await writeOperation(record, database);
        await faults.afterCompensationOperation?.({ index, operationId: record.id, path: operation.path });
      }
      const safetyRoot = record.safetyEntries['.'];
      if (safetyRoot?.mode !== null && safetyRoot?.mode !== undefined) {
        await fsPromises.chmod(identity.canonicalRoot, safetyRoot.mode);
      }
      const compensated = await captureSnapshot({
        allowMaintenance: true,
        restoredFrom: record.plan.safetySnapshotId,
        source: 'restore',
        workspaceId: identity.workspaceId,
      });
      if (compensated.status !== 'captured' || compensated.snapshot.availability !== 'ready') {
        throw new RecoveryPrimitiveError('needs-attention', 'Compensated workspace could not publish a verified revision');
      }
      const comparison = buildPlans(database, record.plan.safetySnapshotId, compensated.snapshot.id);
      if (comparison.targetConflicts.length > 0
        || comparison.inPlaceConflicts.length > 0
        || comparison.inPlaceOperations.length > 0) {
        throw new RecoveryPrimitiveError('needs-attention', 'Workspace compensation did not reproduce its safety checkpoint');
      }
      record.compensation.snapshotId = compensated.snapshot.id;
      record.completionHold = null;
      record.state = 'compensated';
      await writeOperation(record, database);
      await releaseMaintenance();
      await cleanupAuxiliaryPaths(record, identity.canonicalRoot);
      return publicOperation(record);
    } catch (error) {
      if (error?.simulatedCrash === true) throw error;
      await releaseMaintenance({ force: true }).catch(() => undefined);
      record.failure = recoveryFailure(error, 'needs-attention');
      record.state = 'needs-attention';
      await writeOperation(record, database);
      throw new RecoveryPrimitiveError('needs-attention', 'Restore compensation requires attention', {
        cause: error,
        details: { operationId: record.id },
        operationId: record.id,
      });
    } finally {
      database.close();
    }
  };

  return {
    apply: (input) => runOperation(input.operationId, async () => {
      const record = await readOperation(input.operationId);
      return runWorkspace(record.plan.workspaceId, () => applyInternal(input));
    }),
    compensate: (operationId) => runOperation(operationId, async () => {
      const record = await readOperation(operationId);
      return runWorkspace(record.plan.workspaceId, () => compensateInternal(record));
    }),
    cancel: (operationId) => runOperation(operationId, async () => {
      const record = await readOperation(operationId);
      if (record.state === 'aborted') return publicOperation(record);
      if (!PRE_DECISION_STATES.has(record.state)) {
        throw new RecoveryPrimitiveError('recovery-in-progress', 'Restore cannot be cancelled after its commit decision');
      }
      record.state = 'aborted';
      const identity = await inspectIdentity(record.plan.workspaceId);
      const storage = await storageFor(identity);
      const database = await openRecoveryCatalog(storage.root, { create: false, fsPromises });
      try {
        database?.prepare(`
          DELETE FROM pins WHERE key = ? AND kind IN ('restore-safety', 'restore-target')
        `).run(operationId);
        await writeOperation(record, database);
      } finally {
        database?.close();
      }
      if (record.stageRoot) {
        await fsPromises.rm(record.stageRoot, { force: true, recursive: true }).catch(() => undefined);
      }
      return publicOperation(record);
    }),
    async fenceUnfinished() {
      const records = await listOperationRecords();
      const fenced = [];
      const workspaceMaintenance = new Map();
      for (const record of records) {
        const requiresMaintenance = record.mode === 'in-place' && (
          ['commit-decided', 'applying-workspace', 'compensating-workspace'].includes(record.state)
          || (record.state === 'workspace-verified' && !record.verifiedWitness)
        );
        const workspaceId = record.plan.workspaceId;
        const pending = workspaceMaintenance.get(workspaceId) ?? false;
        workspaceMaintenance.set(workspaceId, pending || requiresMaintenance);
        if (requiresMaintenance) fenced.push(record.id);
      }
      // Reconcile the durable lock from operation truth. This also repairs the
      // old crash window where maintenance could be persisted while the restore
      // record was still only staged, and releases legacy conversation holds.
      for (const [workspaceId, requiresMaintenance] of workspaceMaintenance) {
        await documents.setMaintenance(workspaceId, requiresMaintenance);
      }
      return fenced;
    },
    async resumeUnfinished() {
      const records = await listOperationRecords();
      const results = [];
      for (const record of records) {
        if (record.state === 'completion-decided') {
          results.push(await runOperation(record.id, () => (
            runWorkspace(record.plan.workspaceId, () => finalizeInternal(record))
          )));
          continue;
        }
        if (record.state === 'compensating-workspace') {
          results.push(await runOperation(record.id, () => (
            runWorkspace(record.plan.workspaceId, () => compensateInternal(record))
          )));
          continue;
        }
        if (!['commit-decided', 'applying-workspace', 'workspace-verified'].includes(record.state)) continue;
        if (record.state === 'workspace-verified'
          && record.completionHold === 'conversation'
          && record.verifiedWitness) continue;
        if (!record.mode) continue;
        results.push(await runOperation(record.id, () => runWorkspace(record.plan.workspaceId, () => applyInternal({
          expectedRevision: record.plan.revision,
          ...(record.completionHold === 'conversation' ? { holdForConversation: true } : {}),
          mode: record.mode,
          newWorkspacePath: record.destinationPath || record.plan.newWorkspacePath,
          operationId: record.id,
        }))));
      }
      return results;
    },
    async get(operationId) {
      return publicOperation(await readOperation(operationId));
    },
    finalize: (operationId) => runOperation(operationId, async () => {
      const record = await readOperation(operationId);
      return runWorkspace(record.plan.workspaceId, () => finalizeInternal(record));
    }),
    verifyPending: (operationId) => runOperation(operationId, async () => {
      const record = await readOperation(operationId);
      return runWorkspace(record.plan.workspaceId, async () => {
        const identity = await inspectIdentity(record.plan.workspaceId);
        const storage = await storageFor(identity);
        const database = await openRecoveryCatalog(storage.root, { create: false, fsPromises });
        if (!database) throw new RecoveryPrimitiveError('storage-malformed', 'Recovery catalog is unavailable');
        try {
          return await verifyPendingInternal(record, database, identity);
        } finally {
          database.close();
        }
      });
    }),
    async deleteWorkspaceOperations(workspaceId) {
      let entries = [];
      try {
        entries = await fsPromises.readdir(locations.operationsRoot);
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      for (const name of entries) {
        if (!name.startsWith('restore-') || !name.endsWith('.json')) continue;
        const filePath = pathModule.join(locations.operationsRoot, name);
        try {
          const record = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
          if (record?.kind === 'workspace-restore' && record.plan?.workspaceId === workspaceId) {
            await fsPromises.rm(filePath, { force: true });
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    },
    prepare,
  };
};
