import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createSettingsFileStore } from '@piarium/settings-store';
import { RecoveryPrimitiveError } from './errors.js';

const SCHEMA_VERSION = 1;
const MODES = new Set(['shared', 'exclusive']);

// A PID cannot distinguish two authority instances in the same process. Keep
// the process-local instance set until durable owners have been removed so a
// replacement engine can safely reclaim an abandoned same-PID lease.
const liveAuthorityInstances = new Set();

const malformed = (message = 'Recovery workspace lease state is malformed') => (
  new RecoveryPrimitiveError('storage-malformed', message, { origin: 'storage' })
);

const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

const assertOwner = (owner) => {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)
    || typeof owner.leaseId !== 'string' || !owner.leaseId
    || typeof owner.authorityInstanceId !== 'string' || !owner.authorityInstanceId
    || !positiveInteger(owner.pid)
    || !MODES.has(owner.mode)
    || typeof owner.workspaceId !== 'string' || !owner.workspaceId
    || typeof owner.purpose !== 'string' || !owner.purpose
    || typeof owner.acquiredAt !== 'string' || !Number.isFinite(Date.parse(owner.acquiredAt))) {
    throw malformed();
  }
  return owner;
};

const assertDocument = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Array.isArray(value.owners)) {
    throw malformed();
  }
  for (const owner of value.owners) assertOwner(owner);
  const ids = new Set(value.owners.map((owner) => owner.leaseId));
  if (ids.size !== value.owners.length) throw malformed();
  return value;
};

const processMayBeAlive = (processLike, pid) => {
  if (pid === processLike.pid) return true;
  if (typeof processLike.kill !== 'function') return true;
  try {
    processLike.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves the process is gone. Permission and platform errors
    // retain the fence instead of risking two concurrent recovery writers.
    return error?.code !== 'ESRCH';
  }
};

const ownerMayBeAlive = (processLike, owner) => (
  owner.pid === processLike.pid
    ? liveAuthorityInstances.has(owner.authorityInstanceId)
    : processMayBeAlive(processLike, owner.pid)
);

const leaseDocument = () => ({ owners: [], revision: 0, schemaVersion: SCHEMA_VERSION });

const leaseFilePath = (root, pathModule) => pathModule.join(
  pathModule.dirname(root),
  `.${pathModule.basename(root)}.workspace-lease.json`,
);

export const createRecoveryWorkspaceLeaseManager = ({
  fsModule,
  fsPromises,
  pathModule = path,
  processLike = process,
} = {}) => {
  const authorityInstanceId = randomUUID();
  const owned = new Map();
  let disposed = false;
  let disposePromise = null;
  liveAuthorityInstances.add(authorityInstanceId);

  const storeFor = (root) => createSettingsFileStore({
    defaultValue: leaseDocument(),
    filePath: leaseFilePath(root, pathModule),
    ...(fsModule ? { fsModule } : {}),
    ...(fsPromises ? { fsPromises } : {}),
    pathModule,
    processLike,
  });

  const unavailable = (workspaceId, owners) => new RecoveryPrimitiveError(
    'lease-unavailable',
    'Another application Host is changing this workspace recovery history',
    {
      details: {
        workspaceId,
        owners: owners.map((owner) => ({
          acquiredAt: owner.acquiredAt,
          mode: owner.mode,
          purpose: owner.purpose,
        })),
      },
      origin: 'concurrency',
      retryable: true,
    },
  );

  const acquire = async ({ root, workspaceId, mode = 'exclusive', purpose }) => {
    if (disposed) {
      throw new RecoveryPrimitiveError('lease-unavailable', 'Recovery workspace lease manager is disposed', {
        origin: 'concurrency',
        retryable: true,
      });
    }
    if (typeof root !== 'string' || !root || typeof workspaceId !== 'string' || !workspaceId
      || !MODES.has(mode) || typeof purpose !== 'string' || !purpose) {
      throw new TypeError('Recovery workspace lease requires root, workspaceId, mode, and purpose');
    }
    const store = storeFor(root);
    const leaseId = randomUUID();
    const owner = {
      acquiredAt: new Date().toISOString(),
      authorityInstanceId,
      leaseId,
      mode,
      pid: processLike.pid,
      purpose,
      workspaceId,
    };
    await store.transact((raw) => {
      const document = assertDocument(raw);
      const liveOwners = document.owners.filter((candidate) => ownerMayBeAlive(processLike, candidate));
      const conflicting = liveOwners.filter((candidate) => (
        mode === 'exclusive' || candidate.mode === 'exclusive'
      ));
      if (conflicting.length > 0) throw unavailable(workspaceId, conflicting);
      document.owners = [...liveOwners, owner];
      document.revision += 1;
      return { document, result: undefined, write: true };
    });
    const record = { leaseId, root, store };
    owned.set(leaseId, record);
    let released = false;
    return {
      leaseId,
      mode,
      workspaceId,
      async release() {
        if (released) return;
        await store.transact((raw) => {
          const document = assertDocument(raw);
          const before = document.owners.length;
          document.owners = document.owners.filter((candidate) => candidate.leaseId !== leaseId);
          if (document.owners.length === before) return { result: undefined, write: false };
          document.revision += 1;
          return { document, result: undefined, write: true };
        });
        owned.delete(leaseId);
        released = true;
      },
    };
  };

  const dispose = () => {
    if (disposePromise) return disposePromise;
    disposed = true;
    disposePromise = (async () => {
      const records = [...owned.values()];
      await Promise.allSettled(records.map(({ leaseId, store }) => store.transact((raw) => {
        const document = assertDocument(raw);
        const before = document.owners.length;
        document.owners = document.owners.filter((candidate) => candidate.leaseId !== leaseId);
        if (document.owners.length === before) return { result: undefined, write: false };
        document.revision += 1;
        return { document, result: undefined, write: true };
      })));
      owned.clear();
      liveAuthorityInstances.delete(authorityInstanceId);
    })();
    return disposePromise;
  };

  return { acquire, dispose };
};
