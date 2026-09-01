import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { RecoveryPrimitiveError } from './errors.js';

type FsPromises = typeof fs.promises;
type PathModule = typeof path;

type RecoveryLocationMode = 'application-data' | 'workspace-local' | 'workspace-adjacent' | 'custom';
type NonCustomRecoveryLocationMode = Exclude<RecoveryLocationMode, 'custom'>;

interface CustomRecoveryLocation {
  mode: 'custom';
  customRoot: string;
}

interface DefaultRecoveryLocation {
  mode: NonCustomRecoveryLocationMode;
}

type RecoveryLocation = CustomRecoveryLocation | DefaultRecoveryLocation;

interface RecoveryLocationDocument {
  authorityId: string;
  defaultLocation: RecoveryLocation;
  inheritedLocations: Record<string, RecoveryLocation>;
  locations: Record<string, RecoveryLocation>;
  revision: number;
  schemaVersion: number;
  updatedAt: string;
}

interface RecoveryStorageIdentity {
  canonicalRoot: string;
  workspaceId: string;
}

interface RecoveryLocationSelection {
  defaultLocation: RecoveryLocation;
  document: RecoveryLocationDocument;
  location: RecoveryLocation;
  migrationRequired: boolean;
  source: 'workspace' | 'global';
}

interface ResolveRecoveryStorageRootOptions {
  authorityId: string;
  dataDir: string;
  defaultRecoveryDir?: string | undefined;
  fsPromises?: FsPromises | undefined;
  identity: RecoveryStorageIdentity;
  location: unknown;
  pathModule?: PathModule | undefined;
  storageOwnerId?: string | undefined;
}

interface CreateRecoveryLocationRegistryOptions {
  authorityId: string;
  dataDir: string;
  defaultRecoveryDir?: string | undefined;
  fsPromises?: FsPromises | undefined;
  pathModule?: PathModule | undefined;
  storageOwnerId?: string | undefined;
}

interface CommitOptions {
  source?: 'global' | undefined;
  expectedDefaultLocation?: unknown | undefined;
}

interface RecoveryLocationRegistry {
  authorityId: string;
  operationsRoot: string;
  registryPath: string;
  read(): Promise<RecoveryLocationDocument>;
  globalSelection(): Promise<{ document: RecoveryLocationDocument; location: RecoveryLocation }>;
  selection(workspaceId: string): Promise<RecoveryLocationSelection>;
  materialize(workspaceId: string): Promise<RecoveryLocationSelection>;
  resolve(identity: RecoveryStorageIdentity, location: unknown): Promise<string>;
  commit(
    workspaceId: string,
    expectedLocation: unknown,
    location: unknown,
    options?: CommitOptions,
  ): Promise<RecoveryLocationDocument>;
  setDefault(location: unknown): Promise<RecoveryLocationDocument>;
  validateLocation(location: unknown): Promise<RecoveryLocation>;
  remove(workspaceId: string): Promise<RecoveryLocationDocument>;
  samePath(left: string, right: string): boolean;
}

const SCHEMA_VERSION = 1;
const MODES = new Set<string>(['application-data', 'workspace-local', 'workspace-adjacent', 'custom']);
const DEFAULT_LOCATION: DefaultRecoveryLocation = Object.freeze({ mode: 'application-data' });

const samePath = (left: string, right: string, pathModule: PathModule = path): boolean => {
  const a = pathModule.resolve(left);
  const b = pathModule.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};

const syncDirectory = async (directory: string, fsPromises: FsPromises): Promise<void> => {
  let handle: FileHandle | undefined;
  try {
    handle = await fsPromises.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === undefined || !['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes(code)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

export const writeRecoveryJsonAtomic = async (
  filePath: string,
  value: unknown,
  options: { fsPromises?: FsPromises | undefined; pathModule?: PathModule | undefined } = {},
): Promise<void> => {
  const fsPromises = options.fsPromises ?? fs.promises;
  const pathModule = options.pathModule ?? path;
  const directory = pathModule.dirname(filePath);
  await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const previous = `${filePath}.previous`;
  let handle: FileHandle | undefined;
  try {
    handle = await fsPromises.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await fsPromises.rename(temporary, filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === undefined || !['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(code)) throw error;
      await fsPromises.rm(previous, { force: true });
      let preserved = false;
      try {
        await fsPromises.rename(filePath, previous);
        preserved = true;
      } catch (preserveError) {
        if ((preserveError as NodeJS.ErrnoException)?.code !== 'ENOENT') throw preserveError;
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

export const readRecoveryJsonAtomic = async (
  filePath: string,
  options: { fsPromises?: FsPromises | undefined } = {},
): Promise<unknown> => {
  const fsPromises = options.fsPromises ?? fs.promises;
  try {
    return JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    return JSON.parse(await fsPromises.readFile(`${filePath}.previous`, 'utf8'));
  }
};

const normalizeLocation = (value: unknown): RecoveryLocation => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !MODES.has((value as { mode?: unknown }).mode as string)) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery storage location is malformed');
  }
  const candidate = value as { mode: string; customRoot?: unknown };
  if (candidate.mode === 'custom') {
    if (typeof candidate.customRoot !== 'string' || !candidate.customRoot.trim()) {
      throw new RecoveryPrimitiveError('storage-malformed', 'Custom recovery storage requires an absolute root');
    }
    return { customRoot: candidate.customRoot, mode: 'custom' };
  }
  if (candidate.customRoot !== undefined) {
    throw new RecoveryPrimitiveError('storage-malformed', 'customRoot is only valid for custom recovery storage');
  }
  return { mode: candidate.mode as NonCustomRecoveryLocationMode };
};

const emptyDocument = (authorityId: string): RecoveryLocationDocument => ({
  authorityId,
  defaultLocation: DEFAULT_LOCATION,
  inheritedLocations: {},
  locations: {},
  revision: 0,
  schemaVersion: SCHEMA_VERSION,
  updatedAt: new Date(0).toISOString(),
});

const parseDocument = (value: unknown, authorityId: string): RecoveryLocationDocument => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery location registry must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== SCHEMA_VERSION || record.authorityId !== authorityId) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery location registry belongs to another schema or authority');
  }
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0 || !record.locations || typeof record.locations !== 'object' || Array.isArray(record.locations)) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery location registry revision or locations are malformed');
  }
  if (typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery location registry timestamp is malformed');
  }
  if (record.inheritedLocations !== undefined
    && (!record.inheritedLocations || typeof record.inheritedLocations !== 'object' || Array.isArray(record.inheritedLocations))) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery location registry inherited locations are malformed');
  }
  const inheritedLocations = (record.inheritedLocations ?? {}) as Record<string, unknown>;
  const locations = record.locations as Record<string, unknown>;
  return {
    authorityId,
    defaultLocation: normalizeLocation(record.defaultLocation ?? DEFAULT_LOCATION),
    inheritedLocations: Object.fromEntries(Object.entries(inheritedLocations)
      .map(([workspaceId, location]) => [workspaceId, normalizeLocation(location)])),
    locations: Object.fromEntries(Object.entries(locations).map(([workspaceId, location]) => [
      workspaceId,
      normalizeLocation(location),
    ])),
    revision: record.revision as number,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: record.updatedAt as string,
  };
};

const canonicalizeCreatableDirectory = async (
  target: string,
  fsPromises: FsPromises,
  pathModule: PathModule,
): Promise<string> => {
  if (!pathModule.isAbsolute(target)) {
    throw new RecoveryPrimitiveError('invalid-request', 'Custom recovery storage root must be absolute');
  }
  const suffix: string[] = [];
  let current = pathModule.resolve(target);
  for (;;) {
    try {
      const canonical = await fsPromises.realpath(current);
      return pathModule.resolve(canonical, ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
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
}: ResolveRecoveryStorageRootOptions): Promise<string> => {
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
}: CreateRecoveryLocationRegistryOptions): RecoveryLocationRegistry => {
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
  let queue: Promise<unknown> = Promise.resolve();

  const read = async (): Promise<RecoveryLocationDocument> => {
    try {
      return parseDocument(await readRecoveryJsonAtomic(registryPath, { fsPromises }), authorityId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return emptyDocument(authorityId);
      if (error instanceof RecoveryPrimitiveError) throw error;
      throw new RecoveryPrimitiveError('storage-malformed', 'Recovery location registry cannot be read', { cause: error });
    }
  };

  const run = <T>(operation: () => Promise<T> | T): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  const update = (
    mutator: (next: RecoveryLocationDocument, current: RecoveryLocationDocument) => Promise<boolean> | boolean,
  ): Promise<RecoveryLocationDocument> => run(async () => {
    const current = await read();
    const next = structuredClone(current);
    const changed = await mutator(next, current);
    if (!changed) return current;
    next.revision = current.revision + 1;
    next.updatedAt = new Date().toISOString();
    await writeRecoveryJsonAtomic(registryPath, next, { fsPromises, pathModule });
    return next;
  });

  const selectedFromDocument = (
    document: RecoveryLocationDocument,
    workspaceId: string,
  ): RecoveryLocationSelection => {
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
    async globalSelection(): Promise<{ document: RecoveryLocationDocument; location: RecoveryLocation }> {
      const document = await read();
      return { document, location: document.defaultLocation };
    },
    async selection(workspaceId: string): Promise<RecoveryLocationSelection> {
      return selectedFromDocument(await read(), workspaceId);
    },
    async materialize(workspaceId: string): Promise<RecoveryLocationSelection> {
      await update((next, current) => {
        if (current.locations[workspaceId] || current.inheritedLocations[workspaceId]) return false;
        next.inheritedLocations[workspaceId] = DEFAULT_LOCATION;
        return true;
      });
      return selectedFromDocument(await read(), workspaceId);
    },
    async resolve(identity: RecoveryStorageIdentity, location: unknown): Promise<string> {
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
    async commit(
      workspaceId: string,
      expectedLocation: unknown,
      location: unknown,
      options: CommitOptions = {},
    ): Promise<RecoveryLocationDocument> {
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
    async setDefault(location: unknown): Promise<RecoveryLocationDocument> {
      const normalized = normalizeLocation(location);
      return update((next, current) => {
        if (JSON.stringify(current.defaultLocation) === JSON.stringify(normalized)) return false;
        next.defaultLocation = normalized;
        return true;
      });
    },
    async validateLocation(location: unknown): Promise<RecoveryLocation> {
      const normalized = normalizeLocation(location);
      if (normalized.mode === 'custom') {
        return {
          customRoot: await canonicalizeCreatableDirectory(normalized.customRoot, fsPromises, pathModule),
          mode: 'custom',
        };
      }
      return normalized;
    },
    async remove(workspaceId: string): Promise<RecoveryLocationDocument> {
      return update((next, current) => {
        if (!current.locations[workspaceId] && !current.inheritedLocations[workspaceId]) return false;
        delete next.locations[workspaceId];
        delete next.inheritedLocations[workspaceId];
        return true;
      });
    },
    samePath: (left: string, right: string): boolean => samePath(left, right, pathModule),
  };
};
