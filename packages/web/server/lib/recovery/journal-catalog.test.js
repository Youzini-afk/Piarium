import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  openRecoveryJournalCatalog,
  RECOVERY_JOURNAL_SCHEMA_VERSION,
} from './journal-catalog.js';

describe('recovery journal catalog', () => {
  it('replaces the retired full-snapshot schema instead of keeping a compatibility path', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'piarium-journal-catalog-'));
    await fs.promises.mkdir(root, { recursive: true });
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
        expect(database.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get())
          .toEqual({ value: String(RECOVERY_JOURNAL_SCHEMA_VERSION) });
        expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'snapshots'").get())
          .toBeUndefined();
        expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'checkpoint_changes'").get())
          .toEqual({ name: 'checkpoint_changes' });
      } finally {
        database.close();
      }
    } finally {
      await fs.promises.rm(root, { force: true, recursive: true });
    }
  });
});
