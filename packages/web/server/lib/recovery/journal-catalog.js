import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { RecoveryPrimitiveError } from './errors.js';

export const RECOVERY_JOURNAL_SCHEMA_VERSION = 3;

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
`;

const LEGACY_TABLES = [
  'snapshot_entries',
  'staged_entries',
  'workspace_heads',
  'pins',
  'snapshots',
  'turn_bindings',
  'operations',
  'checkpoint_changes',
  'checkpoints',
  'metadata',
];

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

const initialize = (database) => {
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.pragma('foreign_keys = ON');
  const metadataExists = database.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'metadata'",
  ).get();
  const stored = metadataExists
    ? database.prepare('SELECT value FROM metadata WHERE key = ?').get('schema_version')
    : null;
  if (stored?.value !== String(RECOVERY_JOURNAL_SCHEMA_VERSION)) {
    database.pragma('foreign_keys = OFF');
    database.transaction(() => {
      for (const table of LEGACY_TABLES) database.exec(`DROP TABLE IF EXISTS ${table}`);
      database.exec(SCHEMA);
      database.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)')
        .run('schema_version', String(RECOVERY_JOURNAL_SCHEMA_VERSION));
    })();
    database.pragma('foreign_keys = ON');
    return { reset: Boolean(stored || metadataExists) };
  }
  database.exec(SCHEMA);
  return { reset: false };
};

export const openRecoveryJournalCatalog = async (root, options = {}) => {
  const create = options.create === true;
  const fsPromises = options.fsPromises ?? fs.promises;
  if (create) await ensureRecoveryJournalLayout(root, fsPromises);
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
    const databasePath = process.platform === 'win32'
      ? path.toNamespacedPath(catalogPath(root))
      : catalogPath(root);
    database = new Database(databasePath, create ? undefined : { fileMustExist: true });
    const initialized = initialize(database);
    if (initialized.reset) {
      await fsPromises.rm(path.join(root, 'operations'), { force: true, recursive: true });
      await fsPromises.rm(path.join(root, 'staging'), { force: true, recursive: true });
      await fsPromises.mkdir(path.join(root, 'staging'), { recursive: true, mode: 0o700 });
    }
    if (create) {
      await fsPromises.chmod(catalogPath(root), 0o600);
      await syncDirectory(root, fsPromises);
    }
    return database;
  } catch (error) {
    database?.close();
    if (error instanceof RecoveryPrimitiveError) throw error;
    throw new RecoveryPrimitiveError(
      'storage-malformed',
      `Recovery catalog cannot be opened: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
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
};

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
