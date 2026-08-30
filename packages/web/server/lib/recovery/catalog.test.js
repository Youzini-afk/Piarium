import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  openRecoveryCatalog,
  RECOVERY_CATALOG_SCHEMA_VERSION,
} from './catalog.js';

describe('recovery catalog migrations', () => {
  it('adds backward-compatible turn witnesses to a version 1 catalog without deleting history', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piarium-catalog-migration-'));
    const catalogPath = path.join(root, 'catalog.sqlite');
    const legacy = new Database(catalogPath);
    try {
      legacy.exec(`
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO metadata(key, value) VALUES ('schema_version', '1');
        CREATE TABLE turn_bindings (
          execution_id TEXT PRIMARY KEY,
          runtime_key TEXT NOT NULL,
          runtime_generation INTEGER NOT NULL,
          worker_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          user_entry_id TEXT,
          assistant_entry_id TEXT,
          before_snapshot_id TEXT,
          after_snapshot_id TEXT,
          active_writer_scopes_json TEXT NOT NULL,
          provenance TEXT NOT NULL,
          status TEXT NOT NULL,
          failure_json TEXT,
          started_at TEXT NOT NULL,
          settled_at TEXT
        );
        INSERT INTO turn_bindings(
          execution_id, runtime_key, runtime_generation, worker_id, session_id, workspace_id,
          user_entry_id, active_writer_scopes_json, provenance, status, started_at
        ) VALUES ('execution-1', '1:worker-1', 1, 'worker-1', 'session-1', 'workspace-1',
          'user-1', '[]', 'observed-during', 'incomplete', '2026-08-30T00:00:00.000Z');
      `);
    } finally {
      legacy.close();
    }

    const migrated = await openRecoveryCatalog(root, { create: true });
    try {
      expect(migrated.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get().value)
        .toBe(String(RECOVERY_CATALOG_SCHEMA_VERSION));
      const columns = migrated.pragma('table_info(turn_bindings)').map((column) => column.name);
      expect(columns).toEqual(expect.arrayContaining(['before_witness_json', 'after_witness_json']));
      expect(migrated.prepare('SELECT execution_id FROM turn_bindings').get().execution_id).toBe('execution-1');
    } finally {
      migrated.close();
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
