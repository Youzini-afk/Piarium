import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { RecoveryPrimitiveError } from './errors.js';

export const RECOVERY_CATALOG_SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS snapshots (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    parent_snapshot_id TEXT,
    manifest_hash TEXT NOT NULL,
    policy_revision TEXT NOT NULL,
    consistency TEXT NOT NULL,
    availability TEXT NOT NULL,
    coverage_present INTEGER NOT NULL,
    coverage_known_absent INTEGER NOT NULL,
    coverage_excluded_unknown INTEGER NOT NULL,
    coverage_unstable INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    source TEXT NOT NULL,
    label TEXT,
    restored_from TEXT,
    entry_count INTEGER NOT NULL,
    byte_length INTEGER NOT NULL,
    UNIQUE(workspace_id, sequence)
  );
  CREATE TABLE IF NOT EXISTS snapshot_entries (
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    comparison_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    coverage TEXT NOT NULL,
    object_hash TEXT,
    byte_length INTEGER,
    mode INTEGER,
    readonly INTEGER,
    executable INTEGER,
    symlink_target TEXT,
    reason TEXT,
    platform_json TEXT,
    PRIMARY KEY(snapshot_id, path)
  );
  CREATE INDEX IF NOT EXISTS snapshot_entries_order ON snapshot_entries(snapshot_id, path);
  CREATE INDEX IF NOT EXISTS snapshot_entries_objects ON snapshot_entries(object_hash);
  CREATE TABLE IF NOT EXISTS staged_entries (
    capture_id TEXT NOT NULL,
    path TEXT NOT NULL,
    comparison_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    coverage TEXT NOT NULL,
    object_hash TEXT,
    byte_length INTEGER,
    mode INTEGER,
    readonly INTEGER,
    executable INTEGER,
    symlink_target TEXT,
    reason TEXT,
    platform_json TEXT,
    PRIMARY KEY(capture_id, path)
  );
  CREATE INDEX IF NOT EXISTS staged_entries_comparison ON staged_entries(capture_id, comparison_key);
  CREATE INDEX IF NOT EXISTS staged_entries_objects ON staged_entries(object_hash);
  CREATE TABLE IF NOT EXISTS pins (
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(snapshot_id, kind, key)
  );
  CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    type TEXT NOT NULL,
    state TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workspace_heads (
    workspace_id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    epoch INTEGER NOT NULL,
    mutation_revision INTEGER NOT NULL,
    writer_revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS turn_bindings (
    execution_id TEXT PRIMARY KEY,
    runtime_key TEXT NOT NULL,
    runtime_generation INTEGER NOT NULL,
    worker_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    user_entry_id TEXT,
    assistant_entry_id TEXT,
    before_snapshot_id TEXT REFERENCES snapshots(id) ON DELETE SET NULL,
    after_snapshot_id TEXT REFERENCES snapshots(id) ON DELETE SET NULL,
    active_writer_scopes_json TEXT NOT NULL,
    provenance TEXT NOT NULL,
    status TEXT NOT NULL,
    failure_json TEXT,
    started_at TEXT NOT NULL,
    settled_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS turn_bindings_user_entry
    ON turn_bindings(session_id, user_entry_id) WHERE user_entry_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS turn_bindings_assistant_entry
    ON turn_bindings(session_id, assistant_entry_id) WHERE assistant_entry_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS turn_bindings_workspace_time
    ON turn_bindings(workspace_id, started_at DESC);
`;

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

const initialize = (database) => {
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.pragma('foreign_keys = ON');
  database.exec(SCHEMA);
  const schema = database.prepare('SELECT value FROM metadata WHERE key = ?').get('schema_version');
  if (!schema) {
    database.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run('schema_version', String(RECOVERY_CATALOG_SCHEMA_VERSION));
  } else if (schema.value !== String(RECOVERY_CATALOG_SCHEMA_VERSION)) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery catalog schema version is unsupported');
  }
};

export const ensureRecoveryStoreLayout = async (root, fsPromises = fs.promises) => {
  await fsPromises.mkdir(root, { recursive: true, mode: 0o700 });
  await Promise.all(['objects', 'operations', 'staging'].map((name) => (
    fsPromises.mkdir(path.join(root, name), { recursive: true, mode: 0o700 })
  )));
  for (const directory of [root, ...['objects', 'operations', 'staging'].map((name) => path.join(root, name))]) {
    const stat = await fsPromises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new RecoveryPrimitiveError('storage-malformed', 'Recovery storage layout contains a symbolic link or non-directory');
    }
  }
};

export const openRecoveryCatalog = async (root, options = {}) => {
  const create = options.create === true;
  const fsPromises = options.fsPromises ?? fs.promises;
  if (create) await ensureRecoveryStoreLayout(root, fsPromises);
  else {
    try {
      const stat = await fsPromises.lstat(catalogPath(root));
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new RecoveryPrimitiveError('storage-malformed', 'Recovery catalog is not a direct regular file');
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
  let database;
  try {
    if (create) {
      try {
        const stat = await fsPromises.lstat(catalogPath(root));
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new RecoveryPrimitiveError('storage-malformed', 'Recovery catalog is not a direct regular file');
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    database = new Database(catalogPath(root), create ? undefined : { fileMustExist: true });
    initialize(database);
    if (create) {
      await fsPromises.chmod(catalogPath(root), 0o600);
      await syncDirectory(root, fsPromises);
    }
    return database;
  } catch (error) {
    database?.close();
    if (error instanceof RecoveryPrimitiveError) throw error;
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery catalog cannot be opened', { cause: error });
  }
};

const optionalBoolean = (value) => value === null || value === undefined ? undefined : value === 1;

export const entryDtoFromRow = (row) => {
  const entry = {
    comparisonKey: row.comparison_key,
    coverage: row.coverage,
    kind: row.kind,
    path: row.path,
  };
  if (row.object_hash !== null && row.object_hash !== undefined) entry.objectHash = row.object_hash;
  if (row.byte_length !== null && row.byte_length !== undefined) entry.byteLength = row.byte_length;
  if (row.mode !== null && row.mode !== undefined) entry.mode = row.mode;
  const readonly = optionalBoolean(row.readonly);
  const executable = optionalBoolean(row.executable);
  if (readonly !== undefined) entry.readonly = readonly;
  if (executable !== undefined) entry.executable = executable;
  if (row.symlink_target !== null && row.symlink_target !== undefined) entry.symlinkTarget = row.symlink_target;
  if (row.reason !== null && row.reason !== undefined) entry.reason = row.reason;
  if (row.platform_json !== null && row.platform_json !== undefined) {
    try {
      const parsed = JSON.parse(row.platform_json);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      entry.platformMetadata = parsed;
    } catch (error) {
      throw new RecoveryPrimitiveError('snapshot-malformed', `Snapshot entry metadata is malformed: ${row.path}`, { cause: error });
    }
  }
  return entry;
};

export const manifestLine = (entry) => `${JSON.stringify(entry)}\n`;

export const objectPath = (root, objectHash) => {
  const match = /^sha256-([0-9a-f]{64})$/.exec(objectHash);
  if (!match) throw new RecoveryPrimitiveError('snapshot-malformed', `Snapshot object hash is malformed: ${objectHash}`);
  return path.join(root, 'objects', match[1].slice(0, 2), match[1].slice(2));
};

export const hashFileStream = async (filePath, fsModule = fs) => {
  const hash = createHash('sha256');
  let byteLength = 0;
  try {
    const stat = await fsModule.promises.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new RecoveryPrimitiveError('object-corrupt', 'Snapshot object is not a direct regular file');
    }
    for await (const chunk of fsModule.createReadStream(filePath)) {
      hash.update(chunk);
      byteLength += chunk.length;
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new RecoveryPrimitiveError('object-missing', 'Snapshot object is missing', { details: { objectPath: path.basename(filePath) } });
    }
    throw error;
  }
  return { byteLength, objectHash: `sha256-${hash.digest('hex')}` };
};

export const verifyRecoveryObject = async (root, objectHash, options = {}) => {
  const target = objectPath(root, objectHash);
  const actual = await hashFileStream(target, options.fsModule ?? fs);
  if (actual.objectHash !== objectHash) {
    throw new RecoveryPrimitiveError('object-corrupt', `Snapshot object failed SHA-256 verification: ${objectHash}`, {
      details: { actualHash: actual.objectHash, objectHash },
    });
  }
  return actual;
};

const coverageFromRow = (row) => ({
  excludedUnknown: row.coverage_excluded_unknown,
  issues: [],
  knownAbsent: row.coverage_known_absent,
  present: row.coverage_present,
  unstable: row.coverage_unstable,
});

export const snapshotSummaryFromRow = (row, availability = row.availability) => ({
  availability,
  byteLength: row.byte_length,
  consistency: row.consistency,
  coverage: coverageFromRow(row),
  createdAt: row.created_at,
  entryCount: row.entry_count,
  id: row.id,
  manifestHash: row.manifest_hash,
  parentSnapshotId: row.parent_snapshot_id,
  policyRevision: row.policy_revision,
  sequence: row.sequence,
  source: row.source,
  workspaceId: row.workspace_id,
  ...(row.label ? { label: row.label } : {}),
  ...(row.restored_from ? { restoredFrom: row.restored_from } : {}),
});

export const calculateManifestHash = (database, table, idColumn, id) => {
  if (table !== 'snapshot_entries' && table !== 'staged_entries') throw new Error('Unsupported manifest source table');
  if (idColumn !== 'snapshot_id' && idColumn !== 'capture_id') throw new Error('Unsupported manifest identity column');
  const hash = createHash('sha256');
  hash.update('piarium-workspace-manifest-v1\n');
  const statement = database.prepare(`SELECT * FROM ${table} WHERE ${idColumn} = ? ORDER BY path COLLATE BINARY`);
  for (const row of statement.iterate(id)) hash.update(manifestLine(entryDtoFromRow(row)));
  return `sha256-${hash.digest('hex')}`;
};

export const inspectStoredSnapshot = async (database, root, workspaceId, snapshotId, options = {}) => {
  const row = database.prepare('SELECT * FROM snapshots WHERE id = ? AND workspace_id = ?').get(snapshotId, workspaceId);
  if (!row) return { availability: 'missing', row: null };
  let calculated;
  try {
    calculated = calculateManifestHash(database, 'snapshot_entries', 'snapshot_id', snapshotId);
  } catch (error) {
    if (error instanceof RecoveryPrimitiveError && error.code === 'snapshot-malformed') {
      return { availability: 'malformed', error, row };
    }
    throw error;
  }
  if (calculated !== row.manifest_hash) {
    return {
      availability: 'corrupt',
      error: new RecoveryPrimitiveError('snapshot-corrupt', 'Snapshot manifest root hash does not match its entries', {
        details: { actualHash: calculated, manifestHash: row.manifest_hash, snapshotId },
      }),
      row,
    };
  }
  if (options.verifyObjects !== false) {
    for (const entry of database.prepare(
      'SELECT object_hash FROM snapshot_entries WHERE snapshot_id = ? AND object_hash IS NOT NULL ORDER BY path COLLATE BINARY',
    ).iterate(snapshotId)) {
      try {
        await verifyRecoveryObject(root, entry.object_hash, options);
      } catch (error) {
        if (error instanceof RecoveryPrimitiveError) return { availability: 'corrupt', error, row };
        throw error;
      }
    }
  }
  return { availability: row.availability, row };
};

export const verifyRecoveryStore = async (root, options = {}) => {
  const database = await openRecoveryCatalog(root, { create: false, fsPromises: options.fsPromises });
  if (!database) return { snapshots: 0 };
  try {
    const integrity = database.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new RecoveryPrimitiveError('storage-malformed', `Recovery catalog integrity check failed: ${integrity}`);
    let snapshots = 0;
    for (const row of database.prepare('SELECT id, workspace_id FROM snapshots ORDER BY sequence').iterate()) {
      snapshots += 1;
      const inspected = await inspectStoredSnapshot(database, root, row.workspace_id, row.id, options);
      if (inspected.availability === 'corrupt' || inspected.availability === 'malformed') throw inspected.error;
    }
    return { snapshots };
  } finally {
    database.close();
  }
};

export const recordCatalogOperation = (database, operation) => {
  database.prepare(`
    INSERT INTO operations(id, workspace_id, type, state, data_json, created_at, updated_at)
    VALUES (@id, @workspaceId, @type, @state, @dataJson, @createdAt, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET state = excluded.state, data_json = excluded.data_json, updated_at = excluded.updated_at
  `).run({
    ...operation,
    dataJson: JSON.stringify(operation.data ?? {}),
  });
};
