import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createSettingsFileStore } from '@piarium/settings-store';
import { RecoveryPrimitiveError } from './errors.js';

const SCHEMA_VERSION = 1;
const MODES = new Set<string>(['shared', 'exclusive']);

interface LeaseOwner {
  acquiredAt: string;
  authorityInstanceId: string;
  leaseId: string;
  mode: string;
  pid: number;
  purpose: string;
  workspaceId: string;
}

interface LeaseDocument {
  owners: LeaseOwner[];
  revision: number;
  schemaVersion: number;
}

interface AcquireRequest {
  root: string;
  workspaceId: string;
  mode?: string;
  purpose: string;
}

interface LeaseHandle {
  leaseId: string;
  mode: string;
  workspaceId: string;
  release: () => Promise<void>;
}

interface OwnedRecord {
  leaseId: string;
  root: string;
  store: ReturnType<typeof createSettingsFileStore>;
}

interface LeaseManagerOptions {
  fsModule?: unknown;
  fsPromises?: unknown;
  pathModule?: typeof path;
  processLike?: Pick<NodeJS.Process, 'kill' | 'pid' | 'platform'>;
}

const liveAuthorityInstances = new Set<string>();

const malformed = (message = 'Recovery workspace lease state is malformed'): RecoveryPrimitiveError => (
  new RecoveryPrimitiveError('storage-malformed', message, { origin: 'storage' })
);

const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

const assertOwner = (owner: unknown): LeaseOwner => {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)
    || typeof (owner as Record<string, unknown>).leaseId !== 'string' || !(owner as Record<string, unknown>).leaseId
    || typeof (owner as Record<string, unknown>).authorityInstanceId !== 'string' || !(owner as Record<string, unknown>).authorityInstanceId
    || !positiveInteger((owner as Record<string, unknown>).pid)
    || !MODES.has((owner as Record<string, unknown>).mode as string)
    || typeof (owner as Record<string, unknown>).workspaceId !== 'string' || !(owner as Record<string, unknown>).workspaceId
    || typeof (owner as Record<string, unknown>).purpose !== 'string' || !(owner as Record<string, unknown>).purpose
    || typeof (owner as Record<string, unknown>).acquiredAt !== 'string' || !Number.isFinite(Date.parse((owner as Record<string, unknown>).acquiredAt as string))) {
    throw malformed();
  }
  return owner as LeaseOwner;
};

const assertDocument = (value: unknown): LeaseDocument => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (value as Record<string, unknown>).schemaVersion !== SCHEMA_VERSION
    || !Number.isSafeInteger((value as Record<string, unknown>).revision) || (value as Record<string, unknown>).revision as number < 0
    || !Array.isArray((value as Record<string, unknown>).owners)) {
    throw malformed();
  }
  const doc = value as LeaseDocument;
  for (const owner of doc.owners) assertOwner(owner);
  const ids = new Set(doc.owners.map((owner) => owner.leaseId));
  if (ids.size !== doc.owners.length) throw malformed();
  return doc;
};

const processMayBeAlive = (processLike: Pick<NodeJS.Process, 'kill' | 'pid' | 'platform'>, pid: number): boolean => {
  if (pid === processLike.pid) return true;
  if (typeof processLike.kill !== 'function') return true;
  try {
    processLike.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
};

const ownerMayBeAlive = (processLike: Pick<NodeJS.Process, 'kill' | 'pid' | 'platform'>, owner: LeaseOwner): boolean => (
  owner.pid === processLike.pid
    ? liveAuthorityInstances.has(owner.authorityInstanceId)
    : processMayBeAlive(processLike, owner.pid)
);

const leaseDocument = (): LeaseDocument => ({ owners: [], revision: 0, schemaVersion: SCHEMA_VERSION });

const leaseFilePath = (root: string, pathModule: typeof path): string => pathModule.join(
  pathModule.dirname(root),
  `.${pathModule.basename(root)}.workspace-lease.json`,
);

export const createRecoveryWorkspaceLeaseManager = ({
  fsModule,
  fsPromises,
  pathModule = path,
  processLike = process,
}: LeaseManagerOptions = {}) => {
  const authorityInstanceId = randomUUID();
  const owned = new Map<string, OwnedRecord>();
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  liveAuthorityInstances.add(authorityInstanceId);

  const storeFor = (root: string) => createSettingsFileStore({
    defaultValue: leaseDocument() as unknown as Record<string, unknown>,
    filePath: leaseFilePath(root, pathModule),
    ...(fsModule !== undefined ? { fsModule: fsModule as never } : {}),
    ...(fsPromises !== undefined ? { fsPromises: fsPromises as never } : {}),
    pathModule,
    processLike,
  });

  const unavailable = (workspaceId: string, owners: LeaseOwner[]): RecoveryPrimitiveError => new RecoveryPrimitiveError(
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

  const acquire = async ({ root, workspaceId, mode = 'exclusive', purpose }: AcquireRequest): Promise<LeaseHandle> => {
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
    const owner: LeaseOwner = {
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
      return { document: document as unknown as Record<string, unknown>, result: undefined, write: true };
    });
    const record: OwnedRecord = { leaseId, root, store };
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
          return { document: document as unknown as Record<string, unknown>, result: undefined, write: true };
        });
        owned.delete(leaseId);
        released = true;
      },
    };
  };

  const dispose = (): Promise<void> => {
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
        return { document: document as unknown as Record<string, unknown>, result: undefined, write: true };
      })));
      owned.clear();
      liveAuthorityInstances.delete(authorityInstanceId);
    })();
    return disposePromise;
  };

  return { acquire, dispose };
};
