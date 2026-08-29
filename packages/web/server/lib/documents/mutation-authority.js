import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createSettingsFileStore } from '@piarium/settings-store';
import { DocumentAuthorityError } from './errors.js';

const SCHEMA_VERSION = 3;
const LEGACY_SCHEMA_VERSION = 2;
const WRITER_MODES = new Set(['controlled', 'process', 'external']);

// A PID is not enough to distinguish a restarted process or an abandoned authority
// instance in the same Host. Instances in this process can be identified exactly;
// another live process is deliberately retained because its instance cannot be
// confirmed without a separate liveness protocol.
const liveAuthorityInstances = new Set();

const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

const malformedState = () => new DocumentAuthorityError('Workspace mutation authority state is malformed', {
  code: 'failed',
  statusCode: 500,
});

const assertOwner = (owner) => {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) {
    throw new DocumentAuthorityError('Workspace mutation owner is required', { code: 'failed', statusCode: 400 });
  }
  if (typeof owner.kind !== 'string' || !owner.kind.trim() || typeof owner.id !== 'string' || !owner.id.trim()) {
    throw new DocumentAuthorityError('Workspace mutation owner is malformed', { code: 'failed', statusCode: 400 });
  }
  if (owner.generation !== undefined && (!Number.isSafeInteger(owner.generation) || owner.generation < 0)) {
    throw new DocumentAuthorityError('Workspace mutation owner generation is malformed', { code: 'failed', statusCode: 400 });
  }
  return {
    kind: owner.kind.trim(),
    id: owner.id.trim(),
    ...(owner.generation === undefined ? {} : { generation: owner.generation }),
  };
};

const assertStoredOwner = (owner) => {
  try {
    return assertOwner(owner);
  } catch {
    throw malformedState();
  }
};

const defaultEntry = () => ({
  epoch: 1,
  maintenance: false,
  maintenanceOwner: null,
  mutationRevision: 1,
  writerRevision: 1,
  activeWriters: {},
});

const assertMaintenanceOwner = (owner) => {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)
    || !positiveInteger(owner.pid)
    || typeof owner.authorityInstanceId !== 'string' || !owner.authorityInstanceId
    || typeof owner.acquiredAt !== 'string' || !owner.acquiredAt) {
    throw malformedState();
  }
  return owner;
};

const assertDocument = (value, hostId) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![LEGACY_SCHEMA_VERSION, SCHEMA_VERSION].includes(value.schemaVersion)
    || value.hostId !== hostId
    || !value.workspaces
    || typeof value.workspaces !== 'object'
    || Array.isArray(value.workspaces)) {
    throw malformedState();
  }

  for (const [workspaceId, entry] of Object.entries(value.workspaces)) {
    if (!workspaceId || !entry || typeof entry !== 'object' || Array.isArray(entry)
      || !positiveInteger(entry.epoch)
      || !positiveInteger(entry.mutationRevision)
      || typeof entry.maintenance !== 'boolean'
      || !positiveInteger(entry.writerRevision)
      || !entry.activeWriters
      || typeof entry.activeWriters !== 'object'
      || Array.isArray(entry.activeWriters)) {
      throw malformedState();
    }
    for (const [writerId, writer] of Object.entries(entry.activeWriters)) {
      if (!writerId || !writer || typeof writer !== 'object' || Array.isArray(writer)
        || writer.writerId !== writerId
        || !positiveInteger(writer.pid)
        || typeof writer.authorityInstanceId !== 'string' || !writer.authorityInstanceId
        || !positiveInteger(writer.epoch)
        || !WRITER_MODES.has(writer.mode)
        || typeof writer.purpose !== 'string' || !writer.purpose
        || typeof writer.startedAt !== 'string' || !writer.startedAt) {
        throw malformedState();
      }
      assertStoredOwner(writer.owner);
    }
    if (value.schemaVersion === SCHEMA_VERSION) {
      if (entry.maintenance) assertMaintenanceOwner(entry.maintenanceOwner);
      else if (entry.maintenanceOwner !== null) throw malformedState();
    }
  }
  const migrated = value.schemaVersion === LEGACY_SCHEMA_VERSION;
  if (migrated) {
    value.schemaVersion = SCHEMA_VERSION;
    for (const entry of Object.values(value.workspaces)) {
      if (entry.maintenance) entry.writerRevision += 1;
      // A v2 lock has no live owner and therefore cannot authorize blocking a
      // workspace in a new Host process.
      entry.maintenance = false;
      entry.maintenanceOwner = null;
    }
  }
  return { document: value, migrated };
};

const processMayBeAlive = (processLike, pid) => {
  if (pid === processLike.pid) return true;
  if (typeof processLike.kill !== 'function') return true;
  try {
    processLike.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves that the process is gone. EPERM and unknown platform
    // failures must keep the writer fenced rather than creating a false negative.
    return error?.code !== 'ESRCH';
  }
};

const writerMayBeAlive = (processLike, writer) => {
  if (writer.pid === processLike.pid) {
    return liveAuthorityInstances.has(writer.authorityInstanceId);
  }
  return processMayBeAlive(processLike, writer.pid);
};

const cleanDeadWriters = (entry, processLike) => {
  let removed = false;
  for (const [writerId, writer] of Object.entries(entry.activeWriters)) {
    if (writerMayBeAlive(processLike, writer)) continue;
    delete entry.activeWriters[writerId];
    removed = true;
  }
  if (removed) entry.writerRevision += 1;
  return removed;
};

const cleanDeadMaintenance = (entry, processLike) => {
  if (!entry.maintenance) {
    if (entry.maintenanceOwner === null) return false;
    entry.maintenanceOwner = null;
    return true;
  }
  if (entry.maintenanceOwner && writerMayBeAlive(processLike, entry.maintenanceOwner)) return false;
  entry.maintenance = false;
  entry.maintenanceOwner = null;
  entry.writerRevision += 1;
  return true;
};

const durableWitness = (entry) => ({
  epoch: entry.epoch,
  maintenance: entry.maintenance,
  mutationRevision: entry.mutationRevision,
  writerRevision: entry.writerRevision,
});

const sameWorkspaceContentWitness = (left, right) => left
  && left.epoch === right.epoch
  && left.mutationRevision === right.mutationRevision;

const publicState = (runtime, entry) => ({
  workspaceId: runtime.workspaceId,
  epoch: entry.epoch,
  mutationRevision: entry.mutationRevision,
  maintenance: entry.maintenance,
  reconciliationRequired: runtime.reconciliationRequired,
  writerRevision: entry.writerRevision,
  activeWriters: Object.values(entry.activeWriters)
    .sort((left, right) => left.writerId.localeCompare(right.writerId))
    .map((writer) => ({
      writerId: writer.writerId,
      epoch: writer.epoch,
      mode: writer.mode,
      owner: { ...writer.owner },
      purpose: writer.purpose,
      startedAt: writer.startedAt,
    })),
  watch: runtime.watch ? { ...runtime.watch } : null,
});

export const createWorkspaceMutationAuthority = ({
  dataDir,
  hostId,
  fsModule,
  fsPromises,
  pathModule = path,
  processLike = process,
}) => {
  const store = createSettingsFileStore({
    filePath: pathModule.join(dataDir, 'documents', 'mutation-authority.json'),
    defaultValue: {
      schemaVersion: SCHEMA_VERSION,
      hostId,
      workspaces: {},
    },
    ...(fsModule ? { fsModule } : {}),
    ...(fsPromises ? { fsPromises } : {}),
    pathModule,
    processLike,
  });
  const authorityInstanceId = randomUUID();
  const runtimes = new Map();
  const queues = new Map();
  let disposed = false;
  let disposePromise = null;
  liveAuthorityInstances.add(authorityInstanceId);

  const ownsMaintenance = (entry) => entry.maintenanceOwner?.authorityInstanceId === authorityInstanceId
    && entry.maintenanceOwner.pid === processLike.pid;
  const maintenanceOwner = () => ({
    acquiredAt: new Date().toISOString(),
    authorityInstanceId,
    pid: processLike.pid,
  });
  const maintenanceConflict = (entry) => new DocumentAuthorityError(
    'Workspace maintenance is owned by another live Host process',
    { code: 'maintenance', statusCode: 409, currentEpoch: entry.epoch },
  );

  const assertAvailable = () => {
    if (disposed) {
      throw new DocumentAuthorityError('Workspace mutation authority is disposed', {
        code: 'failed',
        statusCode: 500,
      });
    }
  };

  const ensureRuntime = (workspaceId) => {
    let runtime = runtimes.get(workspaceId);
    if (!runtime) {
      runtime = {
        workspaceId,
        reconciliationRequired: true,
        watch: null,
        watchRevision: 1,
        lastDurableWitness: null,
      };
      runtimes.set(workspaceId, runtime);
    }
    return runtime;
  };

  const syncRuntime = (runtime, entry) => {
    const next = durableWitness(entry);
    // Writer admission/release is lifecycle metadata, not evidence that file
    // content changed. Only content/epoch movement invalidates a reusable head.
    if (runtime.lastDurableWitness && !sameWorkspaceContentWitness(runtime.lastDurableWitness, next)) {
      runtime.reconciliationRequired = true;
    }
    runtime.lastDurableWitness = next;
  };

  const mutateWorkspace = (workspaceId, operation = () => ({ changed: false })) => store.transact((raw) => {
    const normalized = assertDocument(raw, hostId);
    const { document } = normalized;
    let changed = normalized.migrated;
    let entry = document.workspaces[workspaceId];
    if (!entry) {
      entry = defaultEntry();
      document.workspaces[workspaceId] = entry;
      changed = true;
    }
    if (cleanDeadWriters(entry, processLike)) changed = true;
    if (cleanDeadMaintenance(entry, processLike)) changed = true;
    const outcome = operation(entry) ?? {};
    changed ||= outcome.changed === true;
    return {
      document,
      result: {
        entry: structuredClone(entry),
        value: outcome.result,
      },
      write: changed,
    };
  });

  const run = (workspaceId, operation) => {
    if (typeof workspaceId !== 'string' || !workspaceId) {
      return Promise.reject(new DocumentAuthorityError('workspaceId is required', { code: 'failed', statusCode: 400 }));
    }
    const previous = queues.get(workspaceId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => {
      assertAvailable();
      return operation(ensureRuntime(workspaceId));
    });
    queues.set(workspaceId, current);
    void current.finally(() => {
      if (queues.get(workspaceId) === current) queues.delete(workspaceId);
    }).catch(() => undefined);
    return current;
  };

  const validateTokenShape = (workspaceId, token) => {
    if (!token || typeof token !== 'object' || Array.isArray(token)
      || token.workspaceId !== workspaceId
      || !positiveInteger(token.epoch)) {
      throw new DocumentAuthorityError('Workspace mutation token is malformed', { code: 'failed', statusCode: 400 });
    }
    return assertOwner(token.owner);
  };

  const validateAdmission = (entry, token) => {
    if (token.epoch !== entry.epoch) {
      throw new DocumentAuthorityError('Workspace mutation epoch is stale', {
        code: 'stale-epoch',
        statusCode: 409,
        currentEpoch: entry.epoch,
      });
    }
    if (entry.maintenance) {
      throw new DocumentAuthorityError('Workspace is in maintenance mode', {
        code: 'maintenance',
        statusCode: 409,
        currentEpoch: entry.epoch,
      });
    }
  };

  const inspect = (workspaceId) => run(workspaceId, async (runtime) => {
    const { entry } = await mutateWorkspace(workspaceId);
    syncRuntime(runtime, entry);
    return publicState(runtime, entry);
  });

  const registerWriter = (token, options = {}) => run(token?.workspaceId, async (runtime) => {
    const owner = validateTokenShape(runtime.workspaceId, token);
    const writerId = randomUUID();
    const writer = {
      writerId,
      pid: processLike.pid,
      authorityInstanceId,
      epoch: token.epoch,
      mode: WRITER_MODES.has(options.mode) ? options.mode : 'controlled',
      owner,
      purpose: typeof options.purpose === 'string' && options.purpose ? options.purpose : 'workspace-mutation',
      startedAt: new Date().toISOString(),
    };
    const { entry } = await mutateWorkspace(runtime.workspaceId, (current) => {
      validateAdmission(current, token);
      current.activeWriters[writerId] = writer;
      current.writerRevision += 1;
      return { changed: true };
    });
    syncRuntime(runtime, entry);
    let closed = false;
    let mutationRecorded = false;
    return {
      writerId,
      owner,
      async markMutated() {
        if (closed || mutationRecorded) return;
        const recorded = await run(runtime.workspaceId, async (currentRuntime) => {
          const transaction = await mutateWorkspace(runtime.workspaceId, (current) => {
            if (!current.activeWriters[writerId]) return { changed: false, result: false };
            current.mutationRevision += 1;
            return { changed: true, result: true };
          });
          syncRuntime(currentRuntime, transaction.entry);
          return transaction.value;
        });
        if (recorded) mutationRecorded = true;
      },
      async close() {
        if (closed) return;
        await run(runtime.workspaceId, async (currentRuntime) => {
          const transaction = await mutateWorkspace(runtime.workspaceId, (current) => {
            if (!current.activeWriters[writerId]) return { changed: false };
            delete current.activeWriters[writerId];
            current.writerRevision += 1;
            return { changed: true };
          });
          syncRuntime(currentRuntime, transaction.entry);
        });
        closed = true;
      },
    };
  });

  // Native watch events are intentionally process-local. Durable controlled
  // mutations are witnessed by mutationRevision/writerRevision, while the
  // source/generation/sequence position detects filesystem activity without a
  // whole-file settings rewrite for every event.
  const observeWatchEvent = (workspaceId, event) => run(workspaceId, async (runtime) => {
    runtime.reconciliationRequired = true;
    runtime.watchRevision += 1;
    if (!event || typeof event !== 'object'
      || typeof event.sourceId !== 'string' || !event.sourceId
      || !positiveInteger(event.generation)
      || !positiveInteger(event.sequence)) {
      return null;
    }
    runtime.watch = {
      sourceId: event.sourceId,
      generation: event.generation,
      sequence: event.sequence,
    };
    return { ...runtime.watch };
  });

  const setWatchBaseline = (workspaceId, position) => run(workspaceId, async (runtime) => {
    if (!position || typeof position.sourceId !== 'string' || !position.sourceId
      || !positiveInteger(position.generation)
      || !Number.isSafeInteger(position.sequence)
      || position.sequence < 0) {
      runtime.reconciliationRequired = true;
      runtime.watchRevision += 1;
    } else {
      const authorityChanged = runtime.watch
        && (runtime.watch.sourceId !== position.sourceId || runtime.watch.generation !== position.generation);
      const positionChanged = !runtime.watch
        || runtime.watch.sourceId !== position.sourceId
        || runtime.watch.generation !== position.generation
        || runtime.watch.sequence !== position.sequence;
      runtime.watch = { ...position };
      if (positionChanged) runtime.watchRevision += 1;
      if (authorityChanged) runtime.reconciliationRequired = true;
    }
    const { entry } = await mutateWorkspace(workspaceId);
    syncRuntime(runtime, entry);
    return publicState(runtime, entry);
  });

  const beginCapture = (workspaceId, options = {}) => run(workspaceId, async (runtime) => {
    const { entry } = await mutateWorkspace(workspaceId);
    syncRuntime(runtime, entry);
    return {
      captureId: randomUUID(),
      workspaceId,
      epoch: entry.epoch,
      mutationRevision: entry.mutationRevision,
      writerRevision: entry.writerRevision,
      activeWriterIds: Object.keys(entry.activeWriters).sort(),
      allowMaintenance: options.allowMaintenance === true,
      maintenance: entry.maintenance,
      watchRevision: runtime.watchRevision,
      watch: runtime.watch ? { ...runtime.watch } : null,
    };
  });

  const completeCapture = (capture) => run(capture?.workspaceId, async (runtime) => {
    if (!capture || typeof capture.captureId !== 'string' || !capture.captureId
      || !Array.isArray(capture.activeWriterIds)) {
      throw new DocumentAuthorityError('Workspace capture token is malformed', { code: 'failed', statusCode: 400 });
    }
    const { entry } = await mutateWorkspace(runtime.workspaceId);
    syncRuntime(runtime, entry);
    const reasons = [];
    if (capture.epoch !== entry.epoch) reasons.push('epoch-changed');
    if (capture.mutationRevision !== entry.mutationRevision) reasons.push('mutation-observed');
    if (capture.writerRevision !== entry.writerRevision) reasons.push('writer-activity');
    if ((capture.maintenance || entry.maintenance) && capture.allowMaintenance !== true) reasons.push('maintenance');
    if (capture.activeWriterIds.length > 0 || Object.keys(entry.activeWriters).length > 0) reasons.push('active-writer');
    const beforeWatch = capture.watch;
    const afterWatch = runtime.watch;
    if (beforeWatch?.sourceId !== afterWatch?.sourceId) reasons.push('watch-source-changed');
    else if (beforeWatch?.generation !== afterWatch?.generation) reasons.push('watch-generation-changed');
    else if (beforeWatch?.sequence !== afterWatch?.sequence || capture.watchRevision !== runtime.watchRevision) {
      reasons.push('watch-sequence-changed');
    }
    const stable = reasons.length === 0;
    if (stable) runtime.reconciliationRequired = false;
    return {
      captureId: capture.captureId,
      workspaceId: runtime.workspaceId,
      stable,
      reasons,
      state: publicState(runtime, entry),
    };
  });

  const advanceEpoch = (workspaceId, options = {}) => run(workspaceId, async (runtime) => {
    const transaction = await mutateWorkspace(workspaceId, (entry) => {
      if (options.expectedEpoch !== undefined && options.expectedEpoch !== entry.epoch) {
        throw new DocumentAuthorityError('Workspace mutation epoch is stale', {
          code: 'stale-epoch',
          statusCode: 409,
          currentEpoch: entry.epoch,
        });
      }
      if (Object.keys(entry.activeWriters).length > 0) {
        throw new DocumentAuthorityError('Workspace has active controlled writers', {
          code: 'active-writer',
          statusCode: 409,
          currentEpoch: entry.epoch,
        });
      }
      if (entry.maintenance && !ownsMaintenance(entry)) throw maintenanceConflict(entry);
      entry.epoch += 1;
      entry.mutationRevision += 1;
      entry.writerRevision += 1;
      entry.maintenance = options.maintenance !== false;
      entry.maintenanceOwner = entry.maintenance
        ? (ownsMaintenance(entry) ? entry.maintenanceOwner : maintenanceOwner())
        : null;
      return { changed: true };
    });
    syncRuntime(runtime, transaction.entry);
    runtime.reconciliationRequired = true;
    return publicState(runtime, transaction.entry);
  });

  const setMaintenance = (workspaceId, enabled) => run(workspaceId, async (runtime) => {
    const next = Boolean(enabled);
    const transaction = await mutateWorkspace(workspaceId, (entry) => {
      if (entry.maintenance === next) {
        if (!next || ownsMaintenance(entry)) return { changed: false };
        throw maintenanceConflict(entry);
      }
      if (!next && !ownsMaintenance(entry)) throw maintenanceConflict(entry);
      entry.maintenance = next;
      entry.maintenanceOwner = next ? maintenanceOwner() : null;
      entry.writerRevision += 1;
      return { changed: true };
    });
    syncRuntime(runtime, transaction.entry);
    return publicState(runtime, transaction.entry);
  });

  const dispose = () => {
    if (disposePromise) return disposePromise;
    disposed = true;
    disposePromise = (async () => {
      await Promise.allSettled([...queues.values()]);
      await store.transact((raw) => {
        const normalized = assertDocument(raw, hostId);
        const { document } = normalized;
        let changed = normalized.migrated;
        for (const entry of Object.values(document.workspaces)) {
          let removed = false;
          for (const [writerId, writer] of Object.entries(entry.activeWriters)) {
            if (writer.pid !== processLike.pid || writer.authorityInstanceId !== authorityInstanceId) continue;
            delete entry.activeWriters[writerId];
            removed = true;
          }
          if (entry.maintenanceOwner?.authorityInstanceId === authorityInstanceId) {
            entry.maintenance = false;
            entry.maintenanceOwner = null;
            removed = true;
          }
          if (removed) {
            entry.writerRevision += 1;
            changed = true;
          }
        }
        return { document, write: changed };
      });
      // Keep the instance live until its durable writer records have been
      // removed. A peer in this process may otherwise mistake an in-progress
      // disposal for an abandoned instance and advance the epoch too early.
      liveAuthorityInstances.delete(authorityInstanceId);
      runtimes.clear();
    })();
    return disposePromise;
  };

  return {
    inspect,
    registerWriter,
    observeWatchEvent,
    setWatchBaseline,
    beginCapture,
    completeCapture,
    advanceEpoch,
    setMaintenance,
    dispose,
  };
};
