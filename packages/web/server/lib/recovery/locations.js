import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RecoveryPrimitiveError } from './errors.js';

const SCHEMA_VERSION = 1;
const MODES = new Set(['application-data', 'workspace-local', 'workspace-adjacent', 'custom']);

const samePath = (left, right, pathModule = path) => {
  const a = pathModule.resolve(left);
  const b = pathModule.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};

const syncDirectory = async (directory, fsPromises) => {
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

export const writeRecoveryJsonAtomic = async (filePath, value, options = {}) => {
  const fsPromises = options.fsPromises ?? fs.promises;
  const pathModule = options.pathModule ?? path;
  const directory = pathModule.dirname(filePath);
  await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fsPromises.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsPromises.rename(temporary, filePath);
    await syncDirectory(directory, fsPromises);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fsPromises.unlink(temporary).catch(() => undefined);
    throw error;
  }
};

const normalizeLocation = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !MODES.has(value.mode)) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery storage location is malformed');
  }
  if (value.mode === 'custom') {
    if (typeof value.customRoot !== 'string' || !value.customRoot.trim()) {
      throw new RecoveryPrimitiveError('storage-malformed', 'Custom recovery storage requires an absolute root');
    }
    return { customRoot: value.customRoot, mode: 'custom' };
  }
  if (value.customRoot !== undefined) {
    throw new RecoveryPrimitiveError('storage-malformed', 'customRoot is only valid for custom recovery storage');
  }
  return { mode: value.mode };
};

const emptyDocument = (authorityId) => ({
  authorityId,
  locations: {},
  revision: 0,
  schemaVersion: SCHEMA_VERSION,
  updatedAt: new Date(0).toISOString(),
});

const parseDocument = (value, authorityId) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery location registry must be an object');
  }
  if (value.schemaVersion !== SCHEMA_VERSION || value.authorityId !== authorityId) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery location registry belongs to another schema or authority');
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !value.locations || typeof value.locations !== 'object' || Array.isArray(value.locations)) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery location registry revision or locations are malformed');
  }
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery location registry timestamp is malformed');
  }
  return {
    authorityId,
    locations: Object.fromEntries(Object.entries(value.locations).map(([workspaceId, location]) => [
      workspaceId,
      normalizeLocation(location),
    ])),
    revision: value.revision,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: value.updatedAt,
  };
};

const canonicalizeCreatableDirectory = async (target, fsPromises, pathModule) => {
  if (!pathModule.isAbsolute(target)) {
    throw new RecoveryPrimitiveError('invalid-request', 'Custom recovery storage root must be absolute');
  }
  const suffix = [];
  let current = pathModule.resolve(target);
  for (;;) {
    try {
      const canonical = await fsPromises.realpath(current);
      return pathModule.resolve(canonical, ...suffix.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = pathModule.dirname(current);
      if (parent === current) throw error;
      suffix.push(pathModule.basename(current));
      current = parent;
    }
  }
};

export const resolveRecoveryStorageRoot = async ({
  authorityId,
  dataDir,
  defaultRecoveryDir,
  fsPromises = fs.promises,
  identity,
  location,
  pathModule = path,
  storageOwnerId = 'piarium.builtin.recovery',
}) => {
  const selected = normalizeLocation(location);
  const ownerSegments = storageOwnerId === 'piarium.builtin.recovery' ? [] : [storageOwnerId];
  if (selected.mode === 'workspace-local') {
    return pathModule.join(identity.canonicalRoot, '.piarium', 'recovery', ...ownerSegments, 'v1');
  }
  if (selected.mode === 'workspace-adjacent') {
    return pathModule.join(
      pathModule.dirname(identity.canonicalRoot),
      '.piarium-recovery',
      identity.workspaceId,
      ...ownerSegments,
      'v1',
    );
  }
  if (selected.mode === 'custom') {
    const root = await canonicalizeCreatableDirectory(selected.customRoot, fsPromises, pathModule);
    return pathModule.join(root, ...ownerSegments, authorityId, identity.workspaceId, 'v1');
  }
  if (defaultRecoveryDir) {
    const root = await canonicalizeCreatableDirectory(defaultRecoveryDir, fsPromises, pathModule);
    return pathModule.join(root, ...ownerSegments, authorityId, identity.workspaceId, 'v1');
  }
  const applicationDataRoot = await canonicalizeCreatableDirectory(dataDir, fsPromises, pathModule);
  return pathModule.join(
    applicationDataRoot,
    'extensions',
    'storage',
    storageOwnerId,
    'recovery',
    'v1',
    authorityId,
    identity.workspaceId,
  );
};

export const createRecoveryLocationRegistry = ({
  authorityId,
  dataDir,
  defaultRecoveryDir,
  fsPromises = fs.promises,
  pathModule = path,
  storageOwnerId = 'piarium.builtin.recovery',
}) => {
  const registryPath = pathModule.join(
    dataDir,
    'extensions',
    'storage',
    storageOwnerId,
    'recovery-locations.v1.json',
  );
  const operationsRoot = pathModule.join(
    dataDir,
    'extensions',
    'storage',
    storageOwnerId,
    'recovery-location-operations',
  );
  let queue = Promise.resolve();

  const read = async () => {
    try {
      return parseDocument(JSON.parse(await fsPromises.readFile(registryPath, 'utf8')), authorityId);
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyDocument(authorityId);
      if (error instanceof RecoveryPrimitiveError) throw error;
      throw new RecoveryPrimitiveError('storage-malformed', 'Recovery location registry cannot be read', { cause: error });
    }
  };

  const run = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  const update = (mutator) => run(async () => {
    const current = await read();
    const next = structuredClone(current);
    const changed = await mutator(next, current);
    if (!changed) return current;
    next.revision = current.revision + 1;
    next.updatedAt = new Date().toISOString();
    await writeRecoveryJsonAtomic(registryPath, next, { fsPromises, pathModule });
    return next;
  });

  return {
    authorityId,
    operationsRoot,
    registryPath,
    read,
    async selection(workspaceId) {
      const document = await read();
      return {
        document,
        location: document.locations[workspaceId] ?? { mode: 'application-data' },
      };
    },
    async resolve(identity, location) {
      return resolveRecoveryStorageRoot({
        authorityId,
        dataDir,
        defaultRecoveryDir,
        fsPromises,
        identity,
        location,
        pathModule,
        storageOwnerId,
      });
    },
    async commit(workspaceId, expectedLocation, location) {
      const normalized = normalizeLocation(location);
      return update((next, current) => {
        const authoritative = current.locations[workspaceId] ?? { mode: 'application-data' };
        if (JSON.stringify(authoritative) !== JSON.stringify(normalizeLocation(expectedLocation))) {
          throw new RecoveryPrimitiveError('recovery-in-progress', 'Recovery storage authority changed while the move was running', { retryable: true });
        }
        next.locations[workspaceId] = normalized;
        return JSON.stringify(authoritative) !== JSON.stringify(normalized);
      });
    },
    async remove(workspaceId) {
      return update((next, current) => {
        if (!current.locations[workspaceId]) return false;
        delete next.locations[workspaceId];
        return true;
      });
    },
    samePath: (left, right) => samePath(left, right, pathModule),
  };
};
