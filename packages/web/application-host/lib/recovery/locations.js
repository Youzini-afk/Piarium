import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RecoveryPrimitiveError } from './errors.js';

const SCHEMA_VERSION = 1;
const MODES = new Set(['application-data', 'workspace-local', 'workspace-adjacent', 'custom']);
const DEFAULT_LOCATION = Object.freeze({ mode: 'application-data' });

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
  const previous = `${filePath}.previous`;
  let handle;
  try {
    handle = await fsPromises.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fsPromises.rename(temporary, filePath);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) throw error;
      await fsPromises.rm(previous, { force: true });
      let preserved = false;
      try {
        await fsPromises.rename(filePath, previous);
        preserved = true;
      } catch (preserveError) {
        if (preserveError?.code !== 'ENOENT') throw preserveError;
      }
      try {
        await fsPromises.rename(temporary, filePath);
      } catch (replaceError) {
        if (preserved) await fsPromises.rename(previous, filePath).catch(() => undefined);
        throw replaceError;
      }
      if (preserved) await fsPromises.rm(previous, { force: true });
    }
    await syncDirectory(directory, fsPromises);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fsPromises.unlink(temporary).catch(() => undefined);
    throw error;
  }
};

export const readRecoveryJsonAtomic = async (filePath, options = {}) => {
  const fsPromises = options.fsPromises ?? fs.promises;
  try {
    return JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return JSON.parse(await fsPromises.readFile(`${filePath}.previous`, 'utf8'));
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
  defaultLocation: DEFAULT_LOCATION,
  inheritedLocations: {},
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
  if (value.inheritedLocations !== undefined
    && (!value.inheritedLocations || typeof value.inheritedLocations !== 'object' || Array.isArray(value.inheritedLocations))) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery location registry inherited locations are malformed');
  }
  const inheritedLocations = value.inheritedLocations ?? {};
  return {
    authorityId,
    defaultLocation: normalizeLocation(value.defaultLocation ?? DEFAULT_LOCATION),
    inheritedLocations: Object.fromEntries(Object.entries(inheritedLocations)
      .map(([workspaceId, location]) => [workspaceId, normalizeLocation(location)])),
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
      return parseDocument(await readRecoveryJsonAtomic(registryPath, { fsPromises }), authorityId);
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

  const selectedFromDocument = (document, workspaceId) => {
    const override = document.locations[workspaceId];
    if (override) {
      return {
        defaultLocation: document.defaultLocation,
        document,
        location: override,
        migrationRequired: false,
        source: 'workspace',
      };
    }
    const inherited = document.inheritedLocations[workspaceId] ?? DEFAULT_LOCATION;
    return {
      defaultLocation: document.defaultLocation,
      document,
      location: inherited,
      migrationRequired: JSON.stringify(inherited) !== JSON.stringify(document.defaultLocation),
      source: 'global',
    };
  };

  return {
    authorityId,
    operationsRoot,
    registryPath,
    read,
    async globalSelection() {
      const document = await read();
      return { document, location: document.defaultLocation };
    },
    async selection(workspaceId) {
      return selectedFromDocument(await read(), workspaceId);
    },
    async materialize(workspaceId) {
      await update((next, current) => {
        if (current.locations[workspaceId] || current.inheritedLocations[workspaceId]) return false;
        next.inheritedLocations[workspaceId] = DEFAULT_LOCATION;
        return true;
      });
      return selectedFromDocument(await read(), workspaceId);
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
    async commit(workspaceId, expectedLocation, location, options = {}) {
      const normalized = normalizeLocation(location);
      return update((next, current) => {
        const authoritative = current.locations[workspaceId]
          ?? current.inheritedLocations[workspaceId]
          ?? DEFAULT_LOCATION;
        if (JSON.stringify(authoritative) !== JSON.stringify(normalizeLocation(expectedLocation))) {
          throw new RecoveryPrimitiveError('recovery-in-progress', 'Recovery storage authority changed while the move was running', { retryable: true });
        }
        if (options.source === 'global') {
          const expectedDefault = normalizeLocation(options.expectedDefaultLocation ?? location);
          if (JSON.stringify(current.defaultLocation) !== JSON.stringify(expectedDefault)) {
            throw new RecoveryPrimitiveError('recovery-in-progress', 'Global recovery storage changed while the move was running', { retryable: true });
          }
          delete next.locations[workspaceId];
          next.inheritedLocations[workspaceId] = normalized;
          return Boolean(current.locations[workspaceId])
            || JSON.stringify(current.inheritedLocations[workspaceId]) !== JSON.stringify(normalized);
        }
        next.locations[workspaceId] = normalized;
        delete next.inheritedLocations[workspaceId];
        return JSON.stringify(current.locations[workspaceId]) !== JSON.stringify(normalized)
          || Boolean(current.inheritedLocations[workspaceId]);
      });
    },
    async setDefault(location) {
      const normalized = normalizeLocation(location);
      return update((next, current) => {
        if (JSON.stringify(current.defaultLocation) === JSON.stringify(normalized)) return false;
        next.defaultLocation = normalized;
        return true;
      });
    },
    async validateLocation(location) {
      const normalized = normalizeLocation(location);
      if (normalized.mode === 'custom') {
        return {
          customRoot: await canonicalizeCreatableDirectory(normalized.customRoot, fsPromises, pathModule),
          mode: 'custom',
        };
      }
      return normalized;
    },
    async remove(workspaceId) {
      return update((next, current) => {
        if (!current.locations[workspaceId] && !current.inheritedLocations[workspaceId]) return false;
        delete next.locations[workspaceId];
        delete next.inheritedLocations[workspaceId];
        return true;
      });
    },
    samePath: (left, right) => samePath(left, right, pathModule),
  };
};
