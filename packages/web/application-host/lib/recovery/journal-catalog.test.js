import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  inspectRecoveryJournalCatalog,
  inspectRetiredRecoveryCatalogs,
  initOperationFiles,
  openRecoveryJournalCatalog,
  operationFileRows,
  operationFromRow,
  rebuildObjectReferences,
  recoveryCatalogStatus,
  RECOVERY_JOURNAL_SCHEMA_VERSION,
  replaceObjectReferences,
  updateOperationFilePhase,
  writeOperationRow,
} from './journal-catalog.js';

const V3_SCHEMA = `
  CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO metadata(key, value) VALUES ('schema_version', '3');
  CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, sequence INTEGER NOT NULL,
    source TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, label TEXT,
    session_id TEXT, entry_id TEXT, execution_id TEXT, changed_path_count INTEGER NOT NULL DEFAULT 0,
    byte_length INTEGER NOT NULL DEFAULT 0, UNIQUE(workspace_id, sequence), UNIQUE(execution_id)
  );
  CREATE TABLE checkpoint_changes (
    checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
    path TEXT NOT NULL, tool_name TEXT NOT NULL, mutation_id TEXT NOT NULL,
    before_json TEXT NOT NULL, after_json TEXT, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY(checkpoint_id, path)
  );
  CREATE TABLE turn_bindings (
    execution_id TEXT PRIMARY KEY, runtime_key TEXT NOT NULL, runtime_generation INTEGER NOT NULL,
    worker_id TEXT NOT NULL, session_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    user_entry_id TEXT NOT NULL, assistant_entry_id TEXT,
    checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
    active_writer_scopes_json TEXT NOT NULL, provenance TEXT NOT NULL, status TEXT NOT NULL,
    journaled_resource_ids_json TEXT NOT NULL, unrecorded_resource_ids_json TEXT NOT NULL,
    failure_json TEXT, started_at TEXT NOT NULL, settled_at TEXT
  );
  CREATE TABLE operations (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
    data_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
`;

const makeRoot = () => fs.promises.mkdtemp(path.join(os.tmpdir(), 'piarium-journal-catalog-'));
const objectHash = (digit) => `sha256-${digit.repeat(64)}`;

const createV3 = (root) => {
  const database = new Database(path.join(root, 'catalog.sqlite'));
  database.exec(V3_SCHEMA);
  return database;
};

const createV4 = (root) => {
  const database = createV3(root);
  database.exec(`
    UPDATE metadata SET value = '4' WHERE key = 'schema_version';
    CREATE TABLE object_references (
      owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, slot TEXT NOT NULL,
      object_hash TEXT NOT NULL, PRIMARY KEY(owner_kind, owner_id, slot)
    );
    CREATE INDEX object_references_hash ON object_references(object_hash);
    CREATE TABLE operation_files (
      operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL, path TEXT NOT NULL, expected_json TEXT, target_json TEXT,
      safety_json TEXT, phase TEXT NOT NULL DEFAULT 'pending', observed_fingerprint TEXT,
      updated_at TEXT NOT NULL, PRIMARY KEY(operation_id, ordinal)
    );
    CREATE INDEX operation_files_path ON operation_files(operation_id, path);
  `);
  return database;
};

describe('recovery journal catalog', () => {
  it('initializes a new v5 catalog and reports a stable ready lifecycle', async () => {
    const root = await makeRoot();
    try {
      const database = await openRecoveryJournalCatalog(root, { create: true });
      try {
        expect(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get())
          .toEqual({ value: String(RECOVERY_JOURNAL_SCHEMA_VERSION) });
        expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'object_references'").get())
          .toEqual({ name: 'object_references' });
        expect(recoveryCatalogStatus(database)).toEqual({
          currentSchemaVersion: 5,
          retiredCatalogCount: 0,
          state: 'ready',
        });
      } finally {
        database.close();
      }
    } finally {
      await fs.promises.rm(root, { force: true, recursive: true });
    }
  });

  it('initializes an existing genuinely empty SQLite catalog without retiring it', async () => {
    const root = await makeRoot();
    const empty = new Database(path.join(root, 'catalog.sqlite'));
    empty.close();
    try {
      const database = await openRecoveryJournalCatalog(root, { create: true });
      try {
        expect(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get())
          .toEqual({ value: '5' });
        expect(recoveryCatalogStatus(database)).toMatchObject({
          retiredCatalogCount: 0,
          state: 'ready',
        });
      } finally {
        database.close();
      }
      expect((await fs.promises.readdir(path.dirname(root)))
        .filter((name) => name.startsWith(`${path.basename(root)}.retired-`))).toEqual([]);
    } finally {
      await fs.promises.rm(root, { force: true, recursive: true });
    }
  });

  it('rejects a future schema without changing catalog bytes, metadata, tables, or layout', async () => {
    const root = await makeRoot();
    const catalog = path.join(root, 'catalog.sqlite');
    const future = new Database(catalog);
    future.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata(key, value) VALUES ('schema_version', '6');
      CREATE TABLE future_records(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      INSERT INTO future_records(id, payload) VALUES ('future', 'preserve-me');
    `);
    future.close();
    const before = await fs.promises.readFile(catalog);
    const entriesBefore = await fs.promises.readdir(root);
    try {
      await expect(openRecoveryJournalCatalog(root, { create: true })).rejects.toMatchObject({
        code: 'storage-schema-newer',
      });
      expect(await fs.promises.readFile(catalog)).toEqual(before);
      expect(await fs.promises.readdir(root)).toEqual(entriesBefore);
      const preserved = new Database(catalog, { readonly: true });
      try {
        expect(preserved.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get())
          .toEqual({ value: '6' });
        expect(preserved.prepare('SELECT * FROM future_records').all())
          .toEqual([{ id: 'future', payload: 'preserve-me' }]);
      } finally {
        preserved.close();
      }
    } finally {
      await fs.promises.rm(root, { force: true, recursive: true });
    }
  });

  it.each([
    ['missing schema version', "INSERT INTO metadata(key, value) VALUES ('unrelated', '1')"],
    ['invalid schema version', "INSERT INTO metadata(key, value) VALUES ('schema_version', '4.0')"],
  ])('fails closed for malformed metadata: %s', async (_label, metadataSql) => {
    const root = await makeRoot();
    const catalog = path.join(root, 'catalog.sqlite');
    const malformed = new Database(catalog);
    malformed.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      ${metadataSql};
      CREATE TABLE sentinel(id TEXT PRIMARY KEY);
      INSERT INTO sentinel(id) VALUES ('preserve-me');
    `);
    malformed.close();
    const before = await fs.promises.readFile(catalog);
    try {
      await expect(openRecoveryJournalCatalog(root, { create: true })).rejects.toMatchObject({
        code: 'storage-malformed',
      });
      expect(await fs.promises.readFile(catalog)).toEqual(before);
      expect(await fs.promises.readdir(root)).toEqual(['catalog.sqlite']);
    } finally {
      await fs.promises.rm(root, { force: true, recursive: true });
    }
  });

  it('migrates v3 transactionally, preserves rows, and rebuilds normalized object references', async () => {
    const root = await makeRoot();
    const v3 = createV3(root);
    const beforeHash = objectHash('1');
    const afterHash = objectHash('2');
    const safetyHash = objectHash('3');
    v3.prepare(`
      INSERT INTO checkpoints(
        id, workspace_id, sequence, source, state, created_at, session_id, entry_id,
        execution_id, changed_path_count, byte_length
      ) VALUES ('checkpoint-1', 'workspace-1', 7, 'turn', 'ready', '2026-01-01T00:00:00.000Z',
        'session-1', 'entry-1', 'execution-1', 1, 12)
    `).run();
    v3.prepare(`
      INSERT INTO checkpoint_changes(
        checkpoint_id, path, tool_name, mutation_id, before_json, after_json, created_at, updated_at
      ) VALUES (?, ?, 'write', 'mutation-1', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z')
    `).run(
      'checkpoint-1',
      'src/file.js',
      JSON.stringify({ byteLength: 5, objectHash: beforeHash }),
      JSON.stringify({ byteLength: 7, objectHash: afterHash }),
    );
    v3.prepare(`
      INSERT INTO turn_bindings(
        execution_id, runtime_key, runtime_generation, worker_id, session_id, workspace_id,
        user_entry_id, assistant_entry_id, checkpoint_id, active_writer_scopes_json,
        provenance, status, journaled_resource_ids_json, unrecorded_resource_ids_json,
        started_at, settled_at
      ) VALUES ('execution-1', 'worker-1@1', 1, 'worker-1', 'session-1', 'workspace-1',
        'entry-1', 'entry-2', 'checkpoint-1', '[]', 'exact', 'ready', '["src/file.js"]',
        '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z')
    `).run();
    v3.prepare(`
      INSERT INTO operations(id, workspace_id, kind, state, data_json, created_at, updated_at)
      VALUES (?, 'workspace-1', 'combined', 'planned', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z')
    `).run('operation-1', JSON.stringify({
      safety: { 'src/file.js': { objectHash: safetyHash } },
      targets: {
        'src/file.js': {
          expected: { objectHash: afterHash },
          target: { objectHash: beforeHash },
        },
      },
    }));
    v3.close();
    try {
      const database = await openRecoveryJournalCatalog(root, { create: true });
      try {
        expect(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get())
          .toEqual({ value: '5' });
        expect(database.prepare("SELECT value FROM metadata WHERE key = 'migrated_from'").get())
          .toEqual({ value: '3' });
        expect(database.prepare('SELECT id, sequence, changed_path_count FROM checkpoints').all())
          .toEqual([{ changed_path_count: 1, id: 'checkpoint-1', sequence: 7 }]);
        expect(database.prepare('SELECT execution_id, checkpoint_id FROM turn_bindings').all())
          .toEqual([{ checkpoint_id: 'checkpoint-1', execution_id: 'execution-1' }]);
        expect(database.prepare('SELECT id, state FROM operations').all())
          .toEqual([{ id: 'operation-1', state: 'planned' }]);
        expect(database.prepare(`
          SELECT owner_kind, owner_id, slot, object_hash FROM object_references
          ORDER BY owner_kind, owner_id, slot
        `).all()).toEqual([
          { object_hash: afterHash, owner_id: '["checkpoint-1","src/file.js"]', owner_kind: 'checkpoint-change', slot: 'after' },
          { object_hash: beforeHash, owner_id: '["checkpoint-1","src/file.js"]', owner_kind: 'checkpoint-change', slot: 'before' },
          { object_hash: safetyHash, owner_id: 'operation-1', owner_kind: 'operation', slot: '["safety","src/file.js","value"]' },
          { object_hash: afterHash, owner_id: 'operation-1', owner_kind: 'operation', slot: '["targets","src/file.js","expected"]' },
          { object_hash: beforeHash, owner_id: 'operation-1', owner_kind: 'operation', slot: '["targets","src/file.js","target"]' },
          { object_hash: afterHash, owner_id: '["operation-1","src/file.js"]', owner_kind: 'operation-file', slot: 'expected' },
          { object_hash: beforeHash, owner_id: '["operation-1","src/file.js"]', owner_kind: 'operation-file', slot: 'target' },
        ]);
        expect(recoveryCatalogStatus(database)).toEqual({
          currentSchemaVersion: 5,
          migratedFrom: 3,
          retiredCatalogCount: 0,
          state: 'migrated',
        });
      } finally {
        database.close();
      }
      const reopened = await openRecoveryJournalCatalog(root, { create: false });
      try {
        expect(recoveryCatalogStatus(reopened)).toMatchObject({ migratedFrom: 3, state: 'migrated' });
      } finally {
        reopened.close();
      }
    } finally {
      await fs.promises.rm(root, { force: true, recursive: true });
    }
  });

  it('rolls back the entire v3 migration when reference source JSON is malformed', async () => {
    const root = await makeRoot();
    const v3 = createV3(root);
    v3.prepare(`
      INSERT INTO checkpoints(id, workspace_id, sequence, source, state, created_at)
      VALUES ('checkpoint-1', 'workspace-1', 1, 'turn', 'ready', '2026-01-01T00:00:00.000Z')
    `).run();
    v3.prepare(`
      INSERT INTO checkpoint_changes(
        checkpoint_id, path, tool_name, mutation_id, before_json, created_at, updated_at
      ) VALUES ('checkpoint-1', 'bad.js', 'write', 'mutation-1', '{bad json',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z')
    `).run();
    v3.close();
    try {
      await expect(openRecoveryJournalCatalog(root, { create: true })).rejects.toMatchObject({
        code: 'storage-malformed',
      });
      const preserved = new Database(path.join(root, 'catalog.sqlite'), { readonly: true });
      try {
        expect(preserved.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get())
          .toEqual({ value: '3' });
        expect(preserved.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'object_references'").get())
          .toBeUndefined();
        expect(preserved.prepare('SELECT before_json FROM checkpoint_changes').get())
          .toEqual({ before_json: '{bad json' });
      } finally {
        preserved.close();
      }
    } finally {
      await fs.promises.rm(root, { force: true, recursive: true });
    }
  });

  it('migrates v4 object references to workspace-scoped v5 rows', async () => {
    const root = await makeRoot();
    const v4 = createV4(root);
    const beforeHash = objectHash('5');
    v4.prepare(`
      INSERT INTO checkpoints(id, workspace_id, sequence, source, state, created_at)
      VALUES ('checkpoint-v4', 'workspace-v4', 1, 'turn', 'ready', '2026-01-01T00:00:00.000Z')
    `).run();
    v4.prepare(`
      INSERT INTO checkpoint_changes(
        checkpoint_id, path, tool_name, mutation_id, before_json, created_at, updated_at
      ) VALUES ('checkpoint-v4', 'note.txt', 'write', 'mutation-v4', ?,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z')
    `).run(JSON.stringify({ objectHash: beforeHash }));
    v4.prepare(`
      INSERT INTO object_references(owner_kind, owner_id, slot, object_hash)
      VALUES ('stale', 'stale', 'stale', ?)
    `).run(objectHash('6'));
    v4.close();
    try {
      const database = await openRecoveryJournalCatalog(root, { create: true });
      try {
        expect(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get())
          .toEqual({ value: '5' });
        expect(database.prepare("SELECT value FROM metadata WHERE key = 'migrated_from'").get())
          .toEqual({ value: '4' });
        expect(database.prepare(`
          SELECT workspace_id, owner_kind, owner_id, slot, object_hash FROM object_references
        `).all()).toEqual([{
          object_hash: beforeHash,
          owner_id: '["checkpoint-v4","note.txt"]',
          owner_kind: 'checkpoint-change',
          slot: 'before',
          workspace_id: 'workspace-v4',
        }]);
      } finally {
        database.close();
      }
    } finally {
      await fs.promises.rm(root, { force: true, recursive: true });
    }
  });

  it('retires an older root intact and restores retired-history status on reopen', async () => {
    const parent = await makeRoot();
    const root = path.join(parent, 'journal');
    await fs.promises.mkdir(root);
    await fs.promises.writeFile(path.join(root, 'legacy-object'), 'preserve-history');
    const legacy = new Database(path.join(root, 'catalog.sqlite'));
    legacy.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata(key, value) VALUES ('schema_version', '1');
      CREATE TABLE snapshots(id TEXT PRIMARY KEY);
      INSERT INTO snapshots(id) VALUES ('legacy-snapshot');
    `);
    legacy.close();
    try {
      const database = await openRecoveryJournalCatalog(root, { create: true });
      try {
        expect(recoveryCatalogStatus(database)).toMatchObject({
          currentSchemaVersion: 5,
          retiredCatalogCount: 1,
          state: 'retired-history',
        });
        const retired = await inspectRetiredRecoveryCatalogs(root);
        expect(retired).toMatchObject({ retiredCatalogCount: 1, state: 'retired-history' });
        expect(await fs.promises.readFile(path.join(retired.retiredCatalogs[0], 'legacy-object'), 'utf8'))
          .toBe('preserve-history');
        const retiredDatabase = new Database(path.join(retired.retiredCatalogs[0], 'catalog.sqlite'), { readonly: true });
        try {
          expect(retiredDatabase.prepare('SELECT * FROM snapshots').all())
            .toEqual([{ id: 'legacy-snapshot' }]);
        } finally {
          retiredDatabase.close();
        }
      } finally {
        database.close();
      }
      const reopened = await openRecoveryJournalCatalog(root, { create: false });
      try {
        expect(recoveryCatalogStatus(reopened)).toMatchObject({
          retiredCatalogCount: 1,
          state: 'retired-history',
        });
      } finally {
        reopened.close();
      }
    } finally {
      await fs.promises.rm(parent, { force: true, recursive: true });
    }
  });

  it('retires known metadata-less history but fails closed for an unknown schema', async () => {
    const parent = await makeRoot();
    const knownRoot = path.join(parent, 'known');
    await fs.promises.mkdir(knownRoot);
    const known = new Database(path.join(knownRoot, 'catalog.sqlite'));
    known.exec('CREATE TABLE snapshots(id TEXT PRIMARY KEY)');
    known.close();
    const unknownRoot = path.join(parent, 'unknown');
    await fs.promises.mkdir(unknownRoot);
    const unknownCatalog = path.join(unknownRoot, 'catalog.sqlite');
    const unknown = new Database(unknownCatalog);
    unknown.exec("CREATE TABLE third_party_records(id TEXT PRIMARY KEY, value TEXT); INSERT INTO third_party_records VALUES ('one', 'keep')");
    unknown.close();
    const unknownBefore = await fs.promises.readFile(unknownCatalog);
    try {
      const database = await openRecoveryJournalCatalog(knownRoot, { create: true });
      try {
        expect(recoveryCatalogStatus(database)).toMatchObject({ retiredCatalogCount: 1, state: 'retired-history' });
      } finally {
        database.close();
      }
      await expect(openRecoveryJournalCatalog(unknownRoot, { create: true })).rejects.toMatchObject({
        code: 'storage-malformed',
      });
      expect(await fs.promises.readFile(unknownCatalog)).toEqual(unknownBefore);
      expect(await fs.promises.readdir(unknownRoot)).toEqual(['catalog.sqlite']);
    } finally {
      await fs.promises.rm(parent, { force: true, recursive: true });
    }
  });

  it('leaves an older root in place when its atomic retirement rename is refused', async () => {
    const parent = await makeRoot();
    const root = path.join(parent, 'journal');
    await fs.promises.mkdir(root);
    const legacy = new Database(path.join(root, 'catalog.sqlite'));
    legacy.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata(key, value) VALUES ('schema_version', '1');
      CREATE TABLE snapshots(id TEXT PRIMARY KEY);
      INSERT INTO snapshots(id) VALUES ('legacy-snapshot');
    `);
    legacy.close();
    const fsPromises = Object.create(fs.promises);
    fsPromises.rename = vi.fn(async (source, destination) => {
      if (source === root) throw Object.assign(new Error('catalog busy'), { code: 'EBUSY' });
      return fs.promises.rename(source, destination);
    });
    try {
      await expect(openRecoveryJournalCatalog(root, { create: true, fsPromises })).rejects.toMatchObject({
        code: 'recovery-in-progress',
        retryable: true,
      });
      const preserved = new Database(path.join(root, 'catalog.sqlite'), { readonly: true });
      try {
        expect(preserved.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get())
          .toEqual({ value: '1' });
        expect(preserved.prepare('SELECT * FROM snapshots').all())
          .toEqual([{ id: 'legacy-snapshot' }]);
      } finally {
        preserved.close();
      }
      expect((await fs.promises.readdir(parent)).filter((name) => name !== 'journal')).toEqual([]);
    } finally {
      await fs.promises.rm(parent, { force: true, recursive: true });
    }
  });

  it('keeps the reference table replaceable and fully rebuildable from source rows', async () => {
    const root = await makeRoot();
    try {
      const database = await openRecoveryJournalCatalog(root, { create: true });
      try {
        replaceObjectReferences(database, 'workspace-1', 'operation', 'manual', [
          { objectHash: objectHash('4'), slot: 'one' },
        ]);
        expect(database.prepare('SELECT object_hash FROM object_references').all())
          .toEqual([{ object_hash: objectHash('4') }]);
        rebuildObjectReferences(database);
        expect(database.prepare('SELECT * FROM object_references').all()).toEqual([]);
      } finally {
        database.close();
      }
    } finally {
      await fs.promises.rm(root, { force: true, recursive: true });
    }
  });

  it('inspects a v3 catalog read-only without migrating it', async () => {
    const root = await makeRoot();
    try {
      createV3(root).close();
      const inspected = await inspectRecoveryJournalCatalog(root);
      expect(inspected.classification).toEqual({ kind: 'migrate', version: 3 });
      expect(inspected.database).toBeNull();
      expect(inspected.status.state).toBe('ready');
      // The catalog must still be v3 on disk — inspect must not migrate.
      const raw = new Database(path.join(root, 'catalog.sqlite'), { readonly: true });
      try {
        expect(raw.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get())
          .toEqual({ value: '3' });
      } finally {
        raw.close();
      }
    } finally {
      await fs.promises.rm(root, { force: true, recursive: true });
    }
  });

  it('inspects a current v5 catalog and returns a readonly database', async () => {
    const root = await makeRoot();
    try {
      const created = await openRecoveryJournalCatalog(root, { create: true });
      created.close();
      const inspected = await inspectRecoveryJournalCatalog(root);
      expect(inspected.classification.kind).toBe('current');
      expect(inspected.database).not.toBeNull();
      expect(inspected.status).toEqual({
        currentSchemaVersion: 5,
        retiredCatalogCount: 0,
        state: 'ready',
      });
      inspected.database.close();
    } finally {
      await fs.promises.rm(root, { force: true, recursive: true });
    }
  });

  it('inspects a missing catalog and returns null', async () => {
    const root = await makeRoot();
    try {
      const inspected = await inspectRecoveryJournalCatalog(path.join(root, 'nonexistent'));
      expect(inspected).toBeNull();
    } finally {
      await fs.promises.rm(root, { force: true, recursive: true });
    }
  });

  it('inspects a future schema catalog without mutating it', async () => {
    const root = await makeRoot();
    try {
      const future = new Database(path.join(root, 'catalog.sqlite'));
      future.exec(`
        CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO metadata(key, value) VALUES ('schema_version', '99');
        CREATE TABLE checkpoints(id TEXT PRIMARY KEY);
      `);
      future.close();
      const before = await fs.promises.readFile(path.join(root, 'catalog.sqlite'));
      await expect(inspectRecoveryJournalCatalog(root)).rejects.toThrow(/newer than supported/);
      // The catalog must not have been retired or modified.
      const after = await fs.promises.readFile(path.join(root, 'catalog.sqlite'));
      expect(after).toEqual(before);
    } finally {
      await fs.promises.rm(root, { force: true, recursive: true });
    }
  });

  it('tracks operation file phases through apply and compensate transitions', async () => {
    const root = await makeRoot();
    try {
      const database = await openRecoveryJournalCatalog(root, { create: true });
      try {
        const operationId = 'op-phase-test';
        const targets = {
          'a.txt': { expected: { kind: 'file', objectHash: 'sha256-' + 'a'.repeat(64) }, target: { kind: 'file', objectHash: 'sha256-' + 'b'.repeat(64) } },
          'b.txt': { expected: { kind: 'file', objectHash: 'sha256-' + 'c'.repeat(64) }, target: { kind: 'file', objectHash: 'sha256-' + 'd'.repeat(64) } },
        };
        writeOperationRow(database, {
          createdAt: new Date().toISOString(),
          data: { plan: { affectedPaths: ['a.txt', 'b.txt'] } },
          id: operationId,
          kind: 'combined',
          state: 'planned',
          updatedAt: new Date().toISOString(),
          workspaceId: 'ws-1',
        });
        initOperationFiles(database, operationId, targets);
        let rows = operationFileRows(database, operationId);
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.path)).toEqual(['a.txt', 'b.txt']);
        expect(rows.every((r) => r.phase === 'pending')).toBe(true);

        updateOperationFilePhase(database, operationId, 'a.txt', 'apply-intent', {
          safetyJson: JSON.stringify({ kind: 'file' }),
        });
        updateOperationFilePhase(database, operationId, 'a.txt', 'target-observed');
        rows = operationFileRows(database, operationId);
        expect(rows.find((r) => r.path === 'a.txt').phase).toBe('target-observed');
        expect(rows.find((r) => r.path === 'b.txt').phase).toBe('pending');

        updateOperationFilePhase(database, operationId, 'a.txt', 'compensate-intent');
        updateOperationFilePhase(database, operationId, 'a.txt', 'safety-observed');
        rows = operationFileRows(database, operationId);
        expect(rows.find((r) => r.path === 'a.txt').phase).toBe('safety-observed');
      } finally {
        database.close();
      }
    } finally {
      await fs.promises.rm(root, { force: true, recursive: true });
    }
  });
});
