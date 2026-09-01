import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { RecoveryPrimitiveError } from './errors.js';

export const RECOVERY_JOURNAL_SCHEMA_VERSION = 5;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    source TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    label TEXT,
    session_id TEXT,
    entry_id TEXT,
    execution_id TEXT,
    changed_path_count INTEGER NOT NULL DEFAULT 0,
    byte_length INTEGER NOT NULL DEFAULT 0,
    UNIQUE(workspace_id, sequence),
    UNIQUE(execution_id)
  );
  CREATE INDEX IF NOT EXISTS checkpoints_workspace_sequence
    ON checkpoints(workspace_id, sequence DESC);
  CREATE TABLE IF NOT EXISTS checkpoint_changes (
    checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    mutation_id TEXT NOT NULL,
    before_json TEXT NOT NULL,
    after_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(checkpoint_id, path)
  );
  CREATE INDEX IF NOT EXISTS checkpoint_changes_checkpoint
    ON checkpoint_changes(checkpoint_id, path);
  CREATE TABLE IF NOT EXISTS turn_bindings (
    execution_id TEXT PRIMARY KEY,
    runtime_key TEXT NOT NULL,
    runtime_generation INTEGER NOT NULL,
    worker_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    user_entry_id TEXT NOT NULL,
    assistant_entry_id TEXT,
    checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
    active_writer_scopes_json TEXT NOT NULL,
    provenance TEXT NOT NULL,
    status TEXT NOT NULL,
    journaled_resource_ids_json TEXT NOT NULL,
    unrecorded_resource_ids_json TEXT NOT NULL,
    failure_json TEXT,
    started_at TEXT NOT NULL,
    settled_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS turn_bindings_user_entry
    ON turn_bindings(session_id, user_entry_id);
  CREATE UNIQUE INDEX IF NOT EXISTS turn_bindings_assistant_entry
    ON turn_bindings(session_id, assistant_entry_id) WHERE assistant_entry_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS turn_bindings_workspace_time
    ON turn_bindings(workspace_id, started_at DESC);
  CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS operations_workspace_time
    ON operations(workspace_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS object_references (
    workspace_id TEXT NOT NULL,
    owner_kind TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    slot TEXT NOT NULL,
    object_hash TEXT NOT NULL,
    PRIMARY KEY(owner_kind, owner_id, slot)
  );
  CREATE INDEX IF NOT EXISTS object_references_hash
    ON object_references(object_hash);
  CREATE INDEX IF NOT EXISTS object_references_workspace
    ON object_references(workspace_id);
  CREATE TABLE IF NOT EXISTS operation_files (
    operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    path TEXT NOT NULL,
    expected_json TEXT,
    target_json TEXT,
    safety_json TEXT,
    phase TEXT NOT NULL DEFAULT 'pending',
    observed_fingerprint TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(operation_id, ordinal)
  );
  CREATE INDEX IF NOT EXISTS operation_files_path
    ON operation_files(operation_id, path);
`;

const V3_TABLES = [
  'metadata',
  'checkpoints',
  'checkpoint_changes',
  'turn_bindings',
  'operations',
];

const V4_TABLES = [...V3_TABLES, 'object_references', 'operation_files'];
const V5_TABLES = V4_TABLES;

const KNOWN_METADATALESS_LEGACY_TABLES = new Set([
  'snapshot_entries',
  'staged_entries',
  'workspace_heads',
  'pins',
  'snapshots',
  'turn_bindings',
  'operations',
  'checkpoint_changes',
  'checkpoints',
]);

const RETIRED_CATALOG_MARKER = '.retired-recovery-schema-';
const catalogStatuses = new WeakMap();

const catalogPath = (root) => path.join(root, 'catalog.sqlite');

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

const databasePath = (root) => process.platform === 'win32'
  ? path.toNamespacedPath(catalogPath(root))
  : catalogPath(root);

const storageMalformed = (message, cause) => new RecoveryPrimitiveError(
  'storage-malformed',
  message,
  cause ? { cause } : undefined,
);

const parseSchemaVersion = (value, label = 'Recovery catalog schema version') => {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw storageMalformed(`${label} is malformed`);
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version)) throw storageMalformed(`${label} is malformed`);
  return version;
};

const requireTables = (tableNames, required, version) => {
  const missing = required.filter((name) => !tableNames.has(name));
  if (missing.length > 0) {
    throw storageMalformed(
      `Recovery catalog schema ${version} is missing required tables: ${missing.join(', ')}`,
    );
  }
};

const classifyCatalog = (root) => {
  let database;
  try {
    database = new Database(databasePath(root), { fileMustExist: true, readonly: true });
    const schemaObjects = database.prepare(`
      SELECT type, name FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
    `).all();
    const tableNames = new Set(
      schemaObjects.filter((entry) => entry.type === 'table').map((entry) => entry.name),
    );
    if (!tableNames.has('metadata')) {
      const nonIndexObjects = schemaObjects.filter((entry) => entry.type !== 'index');
      if (nonIndexObjects.length === 0) return { kind: 'empty' };
      const knownTables = nonIndexObjects.every((entry) => (
        entry.type === 'table' && KNOWN_METADATALESS_LEGACY_TABLES.has(entry.name)
      ));
      if (knownTables) return { kind: 'retire', version: 'metadata-less' };
      throw storageMalformed('Recovery catalog without metadata contains an unknown schema');
    }
    const versions = database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").all();
    if (versions.length !== 1) throw storageMalformed('Recovery catalog schema metadata is malformed');
    const version = parseSchemaVersion(versions[0].value);
    if (version > RECOVERY_JOURNAL_SCHEMA_VERSION) {
      throw new RecoveryPrimitiveError(
        'storage-schema-newer',
        `Recovery catalog schema ${version} is newer than supported schema ${RECOVERY_JOURNAL_SCHEMA_VERSION}`,
      );
    }
    const migratedRows = database.prepare("SELECT value FROM metadata WHERE key = 'migrated_from'").all();
    if (migratedRows.length > 1) throw storageMalformed('Recovery catalog migration metadata is malformed');
    const migratedFrom = migratedRows.length === 1
      ? parseSchemaVersion(migratedRows[0].value, 'Recovery catalog migrated-from version')
      : undefined;
    if (migratedFrom !== undefined && migratedFrom >= RECOVERY_JOURNAL_SCHEMA_VERSION) {
      throw storageMalformed('Recovery catalog migration metadata is malformed');
    }
    if (version === RECOVERY_JOURNAL_SCHEMA_VERSION) {
      requireTables(tableNames, V5_TABLES, version);
      return { kind: 'current', migratedFrom };
    }
    if (version === 3 || version === 4) {
      requireTables(tableNames, version === 3 ? V3_TABLES : V4_TABLES, version);
      return { kind: 'migrate', version };
    }
    return { kind: 'retire', version };
  } catch (error) {
    if (error instanceof RecoveryPrimitiveError) throw error;
    throw storageMalformed(
      `Recovery catalog cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  } finally {
    database?.close();
  }
};

export const ensureRecoveryJournalLayout = async (root, fsPromises = fs.promises) => {
  await fsPromises.mkdir(root, { recursive: true, mode: 0o700 });
  await Promise.all(['objects', 'staging'].map((name) => (
    fsPromises.mkdir(path.join(root, name), { recursive: true, mode: 0o700 })
  )));
  for (const directory of [root, path.join(root, 'objects'), path.join(root, 'staging')]) {
    const stat = await fsPromises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new RecoveryPrimitiveError('storage-malformed', 'Recovery storage contains a symbolic link or non-directory');
    }
  }
};

const configureWritableCatalog = (database) => {
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.pragma('foreign_keys = ON');
};

const initializeEmptyCatalog = (database) => {
  database.transaction(() => {
    database.exec(SCHEMA);
    database.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)')
      .run('schema_version', String(RECOVERY_JOURNAL_SCHEMA_VERSION));
  })();
};

const referenceSlot = (...parts) => JSON.stringify(parts);

const stateReference = (slot, state) => (
  typeof state?.objectHash === 'string' ? [{ objectHash: state.objectHash, slot }] : []
);

const referencesFromOperationCollection = (collectionName, collection) => {
  if (collection === undefined || collection === null) return [];
  if (typeof collection !== 'object' || Array.isArray(collection)) {
    throw storageMalformed(`Recovery operation ${collectionName} is malformed`);
  }
  const references = [];
  for (const [resourceId, value] of Object.entries(collection)) {
    references.push(...stateReference(referenceSlot(collectionName, resourceId, 'value'), value));
    references.push(...stateReference(referenceSlot(collectionName, resourceId, 'expected'), value?.expected));
    references.push(...stateReference(referenceSlot(collectionName, resourceId, 'target'), value?.target));
  }
  return references;
};

const normalizedReferences = (references) => {
  if (!Array.isArray(references)) throw new TypeError('Object references must be an array');
  const bySlot = new Map();
  for (const reference of references) {
    if (typeof reference?.slot !== 'string' || typeof reference?.objectHash !== 'string') {
      throw new TypeError('Each object reference requires string slot and objectHash fields');
    }
    bySlot.set(reference.slot, reference.objectHash);
  }
  return [...bySlot].map(([slot, objectHash]) => ({ objectHash, slot }));
};

export const deleteObjectReferences = (database, workspaceId, ownerKind, ownerId) => {
  database.prepare(`
    DELETE FROM object_references
    WHERE workspace_id = ? AND owner_kind = ? AND owner_id = ?
  `).run(workspaceId, ownerKind, ownerId);
};

export const replaceObjectReferences = (database, workspaceId, ownerKind, ownerId, references) => {
  if (typeof workspaceId !== 'string' || !workspaceId
    || typeof ownerKind !== 'string' || typeof ownerId !== 'string') {
    throw new TypeError('Object reference workspaceId, ownerKind, and ownerId must be strings');
  }
  const normalized = normalizedReferences(references);
  deleteObjectReferences(database, workspaceId, ownerKind, ownerId);
  const insert = database.prepare(`
    INSERT INTO object_references(workspace_id, owner_kind, owner_id, slot, object_hash)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const reference of normalized) {
    insert.run(workspaceId, ownerKind, ownerId, reference.slot, reference.objectHash);
  }
};

const rebuildObjectReferencesInTransaction = (database) => {
  database.prepare('DELETE FROM object_references').run();
  for (const row of database.prepare(`
    SELECT c.workspace_id, cc.checkpoint_id, cc.path, cc.before_json, cc.after_json
    FROM checkpoint_changes cc
    JOIN checkpoints c ON c.id = cc.checkpoint_id
  `).all()) {
    const before = parseJson(row.before_json, `Before state for ${row.path}`);
    const after = row.after_json ? parseJson(row.after_json, `After state for ${row.path}`) : null;
    replaceObjectReferences(
      database,
      row.workspace_id,
      'checkpoint-change',
      JSON.stringify([row.checkpoint_id, row.path]),
      [
        ...stateReference('before', before),
        ...stateReference('after', after),
      ],
    );
  }
  for (const row of database.prepare('SELECT id, workspace_id, data_json FROM operations').all()) {
    const operation = parseJson(row.data_json, `Recovery operation ${row.id}`);
    replaceObjectReferences(database, row.workspace_id, 'operation', row.id, [
      ...referencesFromOperationCollection('targets', operation.targets),
      ...referencesFromOperationCollection('safety', operation.safety),
    ]);
  }
  for (const row of database.prepare(`
    SELECT o.workspace_id, f.operation_id, f.path, f.expected_json, f.target_json, f.safety_json
    FROM operation_files f
    JOIN operations o ON o.id = f.operation_id
  `).all()) {
    replaceObjectReferences(
      database,
      row.workspace_id,
      'operation-file',
      JSON.stringify([row.operation_id, row.path]),
      [
        ...stateReference('expected', row.expected_json ? parseJson(row.expected_json, `Expected state for ${row.path}`) : null),
        ...stateReference('target', row.target_json ? parseJson(row.target_json, `Target state for ${row.path}`) : null),
        ...stateReference('safety', row.safety_json ? parseJson(row.safety_json, `Safety state for ${row.path}`) : null),
      ],
    );
  }
};

export const rebuildObjectReferences = (database) => {
  database.transaction(() => rebuildObjectReferencesInTransaction(database))();
};

const migrateV3Catalog = (database) => {
  database.transaction(() => {
    database.exec(`
      CREATE TABLE object_references (
        workspace_id TEXT NOT NULL,
        owner_kind TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        slot TEXT NOT NULL,
        object_hash TEXT NOT NULL,
        PRIMARY KEY(owner_kind, owner_id, slot)
      );
      CREATE INDEX object_references_hash ON object_references(object_hash);
      CREATE INDEX object_references_workspace ON object_references(workspace_id);
      CREATE TABLE operation_files (
        operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        path TEXT NOT NULL,
        expected_json TEXT,
        target_json TEXT,
        safety_json TEXT,
        phase TEXT NOT NULL DEFAULT 'pending',
        observed_fingerprint TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(operation_id, ordinal)
      );
      CREATE INDEX operation_files_path
        ON operation_files(operation_id, path);
    `);
    // Backfill operation_files for existing operations from their data_json.
    // Operations that were in-progress (planned, applying-files, etc.) cannot
    // have their per-file phase reliably reconstructed from v3 data, so they
    // are marked 'needs-attention' to prevent false success on resume.
    // Completed/aborted/compensated operations get 'safety-observed' for all
    // their files since no further action is needed.
    const TERMINAL_V3_STATES = new Set(['complete', 'aborted', 'compensated', 'needs-attention']);
    const insertFile = database.prepare(`
      INSERT INTO operation_files(operation_id, ordinal, path, expected_json, target_json, phase, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    for (const row of database.prepare("SELECT id, state, data_json FROM operations WHERE kind = 'combined'").all()) {
      const operation = parseJson(row.data_json, `Recovery operation ${row.id}`);
      const targets = operation.targets ?? {};
      const affectedPaths = operation.plan?.affectedPaths ?? Object.keys(targets).sort();
      const phase = TERMINAL_V3_STATES.has(row.state) ? 'safety-observed' : 'needs-attention';
      let ordinal = 0;
      for (const relativePath of affectedPaths) {
        const states = targets[relativePath];
        insertFile.run(
          row.id,
          ordinal,
          relativePath,
          states?.expected ? JSON.stringify(states.expected) : null,
          states?.target ? JSON.stringify(states.target) : null,
          phase,
          now,
        );
        ordinal += 1;
      }
    }
    rebuildObjectReferencesInTransaction(database);
    database.prepare('UPDATE metadata SET value = ? WHERE key = ?')
      .run(String(RECOVERY_JOURNAL_SCHEMA_VERSION), 'schema_version');
    database.prepare(`
      INSERT INTO metadata(key, value) VALUES ('migrated_from', '3')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
  })();
};

const migrateV4Catalog = (database) => {
  database.transaction(() => {
    database.exec(`
      DROP INDEX IF EXISTS object_references_hash;
      ALTER TABLE object_references RENAME TO object_references_v4;
      CREATE TABLE object_references (
        workspace_id TEXT NOT NULL,
        owner_kind TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        slot TEXT NOT NULL,
        object_hash TEXT NOT NULL,
        PRIMARY KEY(owner_kind, owner_id, slot)
      );
      CREATE INDEX object_references_hash ON object_references(object_hash);
      CREATE INDEX object_references_workspace ON object_references(workspace_id);
    `);
    rebuildObjectReferencesInTransaction(database);
    database.exec('DROP TABLE object_references_v4');
    database.prepare('UPDATE metadata SET value = ? WHERE key = ?')
      .run(String(RECOVERY_JOURNAL_SCHEMA_VERSION), 'schema_version');
    database.prepare(`
      INSERT INTO metadata(key, value) VALUES ('migrated_from', '4')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
  })();
};

const retiredCatalogPrefix = (root) => `${path.basename(root)}${RETIRED_CATALOG_MARKER}`;

export const inspectRetiredRecoveryCatalogs = async (root, options = {}) => {
  const fsPromises = options.fsPromises ?? fs.promises;
  const parent = path.dirname(root);
  let entries;
  try {
    entries = await fsPromises.readdir(parent, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { retiredCatalogCount: 0, state: 'ready' };
    }
    throw storageMalformed('Recovery catalog history cannot be inspected', error);
  }
  const prefix = retiredCatalogPrefix(root);
  const retiredCatalogs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(parent, entry.name))
    .sort();
  return {
    retiredCatalogCount: retiredCatalogs.length,
    retiredCatalogs,
    state: retiredCatalogs.length > 0 ? 'retired-history' : 'ready',
  };
};

const attachCatalogStatus = async (database, root, migratedFrom, fsPromises) => {
  const retired = await inspectRetiredRecoveryCatalogs(root, { fsPromises });
  const status = Object.freeze({
    currentSchemaVersion: RECOVERY_JOURNAL_SCHEMA_VERSION,
    state: retired.retiredCatalogCount > 0
      ? 'retired-history'
      : migratedFrom === undefined ? 'ready' : 'migrated',
    ...(migratedFrom === undefined ? {} : { migratedFrom }),
    retiredCatalogCount: retired.retiredCatalogCount,
  });
  catalogStatuses.set(database, status);
  return database;
};

export const recoveryCatalogStatus = (database) => {
  const status = catalogStatuses.get(database);
  return status ? { ...status } : null;
};

const finishCreatedCatalog = async (root, fsPromises) => {
  await fsPromises.chmod(catalogPath(root), 0o600);
  await syncDirectory(root, fsPromises);
};

const createFreshCatalog = async (root, fsPromises) => {
  await ensureRecoveryJournalLayout(root, fsPromises);
  let database;
  try {
    database = new Database(databasePath(root));
    configureWritableCatalog(database);
    initializeEmptyCatalog(database);
    await finishCreatedCatalog(root, fsPromises);
    return database;
  } catch (error) {
    database?.close();
    throw error;
  }
};

const retirementFailure = (error) => {
  if (['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error?.code)) {
    return new RecoveryPrimitiveError(
      'recovery-in-progress',
      'Recovery catalog is in use and cannot be retired',
      { cause: error, retryable: true },
    );
  }
  return new RecoveryPrimitiveError(
    'storage-move-failed',
    `Recovery catalog cannot be retired: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
};

const retireCatalogRoot = async (root, version, fsPromises) => {
  const parent = path.dirname(root);
  const nonce = randomUUID();
  const replacementRoot = path.join(parent, `.${path.basename(root)}.replacement-${nonce}`);
  const retiredRoot = path.join(
    parent,
    `${retiredCatalogPrefix(root)}${version}-${Date.now()}-${nonce}`,
  );
  let replacement;
  try {
    replacement = await createFreshCatalog(replacementRoot, fsPromises);
    replacement.close();
    replacement = null;
    await syncDirectory(parent, fsPromises);
    try {
      await fsPromises.rename(root, retiredRoot);
    } catch (error) {
      throw retirementFailure(error);
    }
    try {
      await fsPromises.rename(replacementRoot, root);
    } catch (error) {
      try {
        await fsPromises.rename(retiredRoot, root);
      } catch (rollbackError) {
        throw new RecoveryPrimitiveError(
          'storage-move-failed',
          'Recovery catalog replacement failed and the original root could not be restored',
          { cause: rollbackError },
        );
      }
      throw retirementFailure(error);
    }
    await syncDirectory(parent, fsPromises);
  } finally {
    replacement?.close();
    await fsPromises.rm(replacementRoot, { force: true, recursive: true }).catch(() => undefined);
  }
};

/**
 * Inspect a recovery catalog without mutating it.
 *
 * This is the read-only classification path. It never migrates, retires,
 * creates, or writes metadata. It returns:
 *   - null if the catalog root or catalog file does not exist
 *   - { database, status } for a current or already-migrated v5 catalog
 *     (database is opened readonly)
 *   - { database: null, status, classification } for a catalog that needs
 *     activation (migration, retirement, initialization) or is
 *     future/malformed — the caller can report status without touching disk
 *
 * Callers that need to write must use openRecoveryJournalCatalog (activate).
 */
export const inspectRecoveryJournalCatalog = async (root, options = {}) => {
  const fsPromises = options.fsPromises ?? fs.promises;
  let rootStat;
  try {
    rootStat = await fsPromises.lstat(root);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery storage contains a symbolic link or non-directory');
  }
  let catalogStat;
  try {
    catalogStat = await fsPromises.lstat(catalogPath(root));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (catalogStat && (!catalogStat.isFile() || catalogStat.isSymbolicLink())) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery catalog is not a direct regular file');
  }
  if (!catalogStat) {
    const retired = await inspectRetiredRecoveryCatalogs(root, { fsPromises });
    return {
      classification: { kind: 'missing' },
      database: null,
      status: {
        currentSchemaVersion: 0,
        retiredCatalogCount: retired.retiredCatalogCount,
        state: retired.retiredCatalogCount > 0 ? 'retired-history' : 'missing',
      },
    };
  }
  const classification = classifyCatalog(root);
  const retired = await inspectRetiredRecoveryCatalogs(root, { fsPromises });
  if (classification.kind === 'current') {
    const database = new Database(databasePath(root), { readonly: true });
    configureReadableCatalog(database);
    const status = Object.freeze({
      currentSchemaVersion: RECOVERY_JOURNAL_SCHEMA_VERSION,
      state: retired.retiredCatalogCount > 0
        ? 'retired-history'
        : classification.migratedFrom === undefined ? 'ready' : 'migrated',
      ...(classification.migratedFrom === undefined ? {} : { migratedFrom: classification.migratedFrom }),
      retiredCatalogCount: retired.retiredCatalogCount,
    });
    catalogStatuses.set(database, status);
    return { classification, database, status };
  }
  // For migrate, retire, empty, or future schemas: return classification
  // without opening a writable handle. The caller can report status and
  // decide whether to activate (which may migrate or retire).
  const state = classification.kind === 'migrate' ? 'ready'
    : classification.kind === 'retire' ? 'ready'
    : classification.kind === 'empty' ? 'missing'
    : 'missing';
  return {
    classification,
    database: null,
    status: {
      currentSchemaVersion: classification.kind === 'migrate' ? classification.version
        : classification.kind === 'retire' && typeof classification.version === 'number' ? classification.version
        : 0,
      retiredCatalogCount: retired.retiredCatalogCount,
      state: retired.retiredCatalogCount > 0 ? 'retired-history' : state,
    },
  };
};

const configureReadableCatalog = (database) => {
  // Do NOT set journal_mode on a readonly connection — SQLite will reject
  // the implicit write with SQLITE_READONLY. Only enable foreign_keys,
  // which is a connection-level pragma that doesn't touch the database file.
  database.pragma('foreign_keys = ON');
};

export const openRecoveryJournalCatalog = async (root, options = {}) => {
  const create = options.create === true;
  const fsPromises = options.fsPromises ?? fs.promises;
  let rootStat;
  try {
    rootStat = await fsPromises.lstat(root);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (!create) return null;
  }
  if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink())) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery storage contains a symbolic link or non-directory');
  }
  let catalogStat;
  if (rootStat) {
    try {
      catalogStat = await fsPromises.lstat(catalogPath(root));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (catalogStat && (!catalogStat.isFile() || catalogStat.isSymbolicLink())) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery catalog is not a direct regular file');
  }
  if (!catalogStat) {
    if (!create) return null;
    let database;
    try {
      database = await createFreshCatalog(root, fsPromises);
      return await attachCatalogStatus(database, root, undefined, fsPromises);
    } catch (error) {
      database?.close();
      if (error instanceof RecoveryPrimitiveError) throw error;
      throw storageMalformed(
        `Recovery catalog cannot be opened: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }
  const classification = classifyCatalog(root);
  if (classification.kind === 'retire') {
    try {
      await retireCatalogRoot(root, classification.version, fsPromises);
    } catch (error) {
      if (error instanceof RecoveryPrimitiveError) throw error;
      throw storageMalformed(
        `Recovery catalog cannot be retired: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }
  let database;
  try {
    if (classification.kind === 'empty') {
      if (create) await ensureRecoveryJournalLayout(root, fsPromises);
      database = new Database(databasePath(root), { fileMustExist: true });
      configureWritableCatalog(database);
      initializeEmptyCatalog(database);
      if (create) await finishCreatedCatalog(root, fsPromises);
      return await attachCatalogStatus(database, root, undefined, fsPromises);
    }
    if (classification.kind === 'retire') {
      database = new Database(databasePath(root), { fileMustExist: true });
      configureWritableCatalog(database);
      return await attachCatalogStatus(database, root, undefined, fsPromises);
    }
    if (create) await ensureRecoveryJournalLayout(root, fsPromises);
    database = new Database(databasePath(root), { fileMustExist: true });
    configureWritableCatalog(database);
    if (classification.kind === 'migrate') {
      if (classification.version === 3) migrateV3Catalog(database);
      else migrateV4Catalog(database);
    }
    else database.exec(SCHEMA);
    if (create) await finishCreatedCatalog(root, fsPromises);
    return await attachCatalogStatus(
      database,
      root,
      classification.kind === 'migrate' ? classification.version : classification.migratedFrom,
      fsPromises,
    );
  } catch (error) {
    database?.close();
    if (error instanceof RecoveryPrimitiveError) throw error;
    throw storageMalformed(
      `Recovery catalog cannot be opened: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
};

export const objectPath = (root, objectHash) => {
  const match = /^sha256-([0-9a-f]{64})$/.exec(objectHash);
  if (!match) throw new RecoveryPrimitiveError('checkpoint-corrupt', `Recovery object hash is malformed: ${objectHash}`);
  return path.join(root, 'objects', match[1].slice(0, 2), match[1].slice(2));
};

export const checkpointFromRow = (row) => ({
  byteLength: row.byte_length,
  changedPathCount: row.changed_path_count,
  createdAt: row.created_at,
  id: row.id,
  sequence: row.sequence,
  source: row.source,
  state: row.state,
  workspaceId: row.workspace_id,
  ...(row.entry_id ? { entryId: row.entry_id } : {}),
  ...(row.execution_id ? { executionId: row.execution_id } : {}),
  ...(row.label ? { label: row.label } : {}),
  ...(row.session_id ? { sessionId: row.session_id } : {}),
});

const parseJson = (value, label) => {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new RecoveryPrimitiveError('storage-malformed', `${label} is malformed`, { cause: error });
  }
};

export const changeFromRow = (row) => ({
  after: row.after_json ? parseJson(row.after_json, `After state for ${row.path}`) : null,
  before: parseJson(row.before_json, `Before state for ${row.path}`),
  checkpointId: row.checkpoint_id,
  mutationId: row.mutation_id,
  path: row.path,
  toolName: row.tool_name,
});

export const bindingFromRow = (row) => ({
  activeWriterScopes: parseJson(row.active_writer_scopes_json, 'Binding writer scopes'),
  checkpointId: row.checkpoint_id,
  executionId: row.execution_id,
  provenance: row.provenance,
  runtimeGeneration: row.runtime_generation,
  runtimeKey: row.runtime_key,
  sessionId: row.session_id,
  startedAt: row.started_at,
  status: row.status,
  unrecordedResourceIds: parseJson(row.unrecorded_resource_ids_json, 'Binding unrecorded paths'),
  userEntryId: row.user_entry_id,
  workerId: row.worker_id,
  workspaceId: row.workspace_id,
  ...(row.assistant_entry_id ? { assistantEntryId: row.assistant_entry_id } : {}),
  ...(row.failure_json ? { failure: parseJson(row.failure_json, 'Binding failure') } : {}),
  ...(row.settled_at ? { settledAt: row.settled_at } : {}),
});

export const operationFromRow = (row) => ({
  ...parseJson(row.data_json, `Recovery operation ${row.id}`),
  id: row.id,
  state: row.state,
  workspaceId: row.workspace_id,
});

export const writeOperationRow = (database, operation) => {
  database.transaction(() => {
    database.prepare(`
      INSERT INTO operations(id, workspace_id, kind, state, data_json, created_at, updated_at)
      VALUES (@id, @workspaceId, @kind, @state, @dataJson, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `).run({
      createdAt: operation.createdAt,
      dataJson: JSON.stringify(operation.data),
      id: operation.id,
      kind: operation.kind,
      state: operation.state,
      updatedAt: operation.updatedAt,
      workspaceId: operation.workspaceId,
    });
    replaceObjectReferences(database, operation.workspaceId, 'operation', operation.id, [
      ...referencesFromOperationCollection('targets', operation.data.targets),
      ...referencesFromOperationCollection('safety', operation.data.safety),
    ]);
  })();
};

const OPERATION_FILE_PHASES = [
  'pending', 'apply-intent', 'target-observed',
  'compensate-intent', 'safety-observed', 'needs-attention',
];

export const initOperationFiles = (database, operationId, targets) => {
  const previousPaths = database.prepare('SELECT path FROM operation_files WHERE operation_id = ?')
    .all(operationId).map((row) => row.path);
  const operation = database.prepare('SELECT workspace_id FROM operations WHERE id = ?').get(operationId);
  if (!operation) throw storageMalformed(`Recovery operation ${operationId} is missing`);
  for (const previousPath of previousPaths) {
    deleteObjectReferences(
      database,
      operation.workspace_id,
      'operation-file',
      JSON.stringify([operationId, previousPath]),
    );
  }
  database.prepare('DELETE FROM operation_files WHERE operation_id = ?').run(operationId);
  const insert = database.prepare(`
    INSERT INTO operation_files(operation_id, ordinal, path, expected_json, target_json, phase, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `);
  const now = new Date().toISOString();
  let ordinal = 0;
  for (const relativePath of Object.keys(targets).sort()) {
    const states = targets[relativePath];
    insert.run(
      operationId,
      ordinal,
      relativePath,
      states.expected ? JSON.stringify(states.expected) : null,
      states.target ? JSON.stringify(states.target) : null,
      now,
    );
    replaceObjectReferences(
      database,
      operation.workspace_id,
      'operation-file',
      JSON.stringify([operationId, relativePath]),
      [
        ...stateReference('expected', states.expected),
        ...stateReference('target', states.target),
      ],
    );
    ordinal += 1;
  }
};

export const updateOperationFilePhase = (database, operationId, path, phase, options = {}) => {
  if (!OPERATION_FILE_PHASES.includes(phase)) {
    throw new TypeError(`Invalid operation file phase: ${phase}`);
  }
  const now = new Date().toISOString();
  if (options.safetyJson !== undefined) {
    database.prepare(`
      UPDATE operation_files
      SET phase = ?, safety_json = ?, observed_fingerprint = ?, updated_at = ?
      WHERE operation_id = ? AND path = ?
    `).run(phase, options.safetyJson, options.observedFingerprint ?? null, now, operationId, path);
  } else {
    database.prepare(`
      UPDATE operation_files
      SET phase = ?, observed_fingerprint = ?, updated_at = ?
      WHERE operation_id = ? AND path = ?
    `).run(phase, options.observedFingerprint ?? null, now, operationId, path);
  }
  const row = database.prepare(`
    SELECT o.workspace_id, f.expected_json, f.target_json, f.safety_json
    FROM operation_files f
    JOIN operations o ON o.id = f.operation_id
    WHERE f.operation_id = ? AND f.path = ?
  `).get(operationId, path);
  if (!row) throw storageMalformed(`Recovery operation file ${operationId}:${path} is missing`);
  replaceObjectReferences(
    database,
    row.workspace_id,
    'operation-file',
    JSON.stringify([operationId, path]),
    [
      ...stateReference('expected', row.expected_json ? parseJson(row.expected_json, `Expected state for ${path}`) : null),
      ...stateReference('target', row.target_json ? parseJson(row.target_json, `Target state for ${path}`) : null),
      ...stateReference('safety', row.safety_json ? parseJson(row.safety_json, `Safety state for ${path}`) : null),
    ],
  );
};

export const operationFileRows = (database, operationId) => (
  database.prepare(`
    SELECT * FROM operation_files WHERE operation_id = ?
    ORDER BY ordinal ASC
  `).all(operationId)
);

export const operationFileByPath = (database, operationId, path) => (
  database.prepare(`
    SELECT * FROM operation_files WHERE operation_id = ? AND path = ?
  `).get(operationId, path)
);

export const verifyRecoveryJournalStore = async (root, options = {}) => {
  const database = await openRecoveryJournalCatalog(root, { create: false, fsPromises: options.fsPromises });
  if (!database) return { checkpoints: 0 };
  try {
    const integrity = database.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new RecoveryPrimitiveError('storage-malformed', `Recovery catalog integrity check failed: ${integrity}`);
    const refs = new Set();
    for (const row of database.prepare('SELECT before_json, after_json FROM checkpoint_changes').iterate()) {
      for (const raw of [row.before_json, row.after_json]) {
        if (!raw) continue;
        const state = parseJson(raw, 'Checkpoint file state');
        if (typeof state.objectHash === 'string') refs.add(state.objectHash);
      }
    }
    for (const row of database.prepare("SELECT data_json FROM operations WHERE kind = 'combined'").iterate()) {
      const operation = parseJson(row.data_json, 'Recovery operation');
      for (const collection of [operation.targets, operation.safety]) {
        for (const value of Object.values(collection ?? {})) {
          for (const state of [value, value?.expected, value?.target]) {
            if (typeof state?.objectHash === 'string') refs.add(state.objectHash);
          }
        }
      }
    }
    for (const hash of refs) {
      let stat;
      try {
        stat = await (options.fsPromises ?? fs.promises).lstat(objectPath(root, hash));
      } catch (error) {
        if (error?.code === 'ENOENT') throw new RecoveryPrimitiveError('object-missing', `Recovery object is missing: ${hash}`);
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new RecoveryPrimitiveError('object-corrupt', `Recovery object is invalid: ${hash}`);
    }
    return { checkpoints: database.prepare('SELECT COUNT(*) AS count FROM checkpoints').get().count };
  } finally {
    database.close();
  }
};
