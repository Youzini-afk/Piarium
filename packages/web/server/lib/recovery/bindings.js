import { openRecoveryCatalog } from './catalog.js';
import { RecoveryPrimitiveError } from './errors.js';

const parseStoredJson = (value, fallback) => {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery binding metadata is malformed');
  }
};

const bindingFromRow = (row) => ({
  activeWriterScopes: parseStoredJson(row.active_writer_scopes_json, []),
  executionId: row.execution_id,
  provenance: row.provenance,
  runtimeGeneration: row.runtime_generation,
  runtimeKey: row.runtime_key,
  sessionId: row.session_id,
  startedAt: row.started_at,
  status: row.status,
  userEntryId: row.user_entry_id,
  workerId: row.worker_id,
  workspaceId: row.workspace_id,
  ...(row.after_snapshot_id ? { afterSnapshotId: row.after_snapshot_id } : {}),
  ...(row.assistant_entry_id ? { assistantEntryId: row.assistant_entry_id } : {}),
  ...(row.before_snapshot_id ? { beforeSnapshotId: row.before_snapshot_id } : {}),
  ...(row.failure_json ? { failure: parseStoredJson(row.failure_json, null) } : {}),
  ...(row.settled_at ? { settledAt: row.settled_at } : {}),
});

const snapshotRow = (database, workspaceId, snapshotId) => {
  if (!snapshotId) return null;
  const row = database.prepare('SELECT * FROM snapshots WHERE id = ? AND workspace_id = ?')
    .get(snapshotId, workspaceId);
  if (!row) throw new RecoveryPrimitiveError('snapshot-missing', `Unknown workspace snapshot: ${snapshotId}`);
  return row;
};

const mergeWriterScopes = (...groups) => [...new Set(groups.flat().filter(Boolean))].sort();

const mergeProvenance = (left, right) => {
  if (left === 'overlapped' || right === 'overlapped') return 'overlapped';
  if (left === 'observed-during' || right === 'observed-during') return 'observed-during';
  return 'caused-by';
};

export const createRecoveryBindingStore = ({ fsPromises, inspectIdentity, storageFor }) => {
  const openWorkspace = async (workspaceId, create) => {
    const identity = await inspectIdentity(workspaceId);
    const storage = await storageFor(identity);
    const database = await openRecoveryCatalog(storage.root, { create, fsPromises });
    return { database, identity };
  };

  return {
    async recordTurnStart(input) {
      const { database, identity } = await openWorkspace(input.workspaceId, true);
      try {
        const existing = database.prepare('SELECT * FROM turn_bindings WHERE execution_id = ?').get(input.executionId);
        if (existing) {
          const binding = bindingFromRow(existing);
          if (binding.sessionId !== input.sessionId
            || binding.workspaceId !== input.workspaceId
            || binding.userEntryId !== input.userEntryId
            || binding.runtimeGeneration !== input.runtimeGeneration
            || binding.workerId !== input.workerId) {
            throw new RecoveryPrimitiveError('invalid-request', 'Turn execution identity is already bound to another lifecycle');
          }
          return { binding, status: 'ready' };
        }
        const entryCollision = database.prepare(`
          SELECT execution_id FROM turn_bindings WHERE session_id = ? AND user_entry_id = ?
        `).get(input.sessionId, input.userEntryId);
        if (entryCollision) {
          throw new RecoveryPrimitiveError('invalid-request', 'Session entry is already bound to another turn');
        }
        const before = snapshotRow(database, identity.workspaceId, input.beforeSnapshotId);
        const ready = before?.availability === 'ready' && !input.failure;
        const startedAt = new Date().toISOString();
        database.transaction(() => {
          database.prepare(`
            INSERT INTO turn_bindings(
              execution_id, runtime_key, runtime_generation, worker_id, session_id, workspace_id,
              user_entry_id, assistant_entry_id, before_snapshot_id, after_snapshot_id,
              active_writer_scopes_json, provenance, status, failure_json, started_at, settled_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, NULL)
          `).run(
            input.executionId,
            `${input.runtimeGeneration}:${input.workerId}`,
            input.runtimeGeneration,
            input.workerId,
            input.sessionId,
            input.workspaceId,
            input.userEntryId,
            input.beforeSnapshotId ?? null,
            JSON.stringify(mergeWriterScopes(input.activeWriterScopes)),
            input.provenance,
            ready ? 'pending' : 'incomplete',
            input.failure ? JSON.stringify(input.failure) : null,
            startedAt,
          );
          if (before) {
            database.prepare(`
              INSERT OR IGNORE INTO pins(snapshot_id, kind, key, created_at)
              VALUES (?, 'turn-before', ?, ?)
            `).run(before.id, input.executionId, startedAt);
          }
        })();
        return {
          binding: bindingFromRow(database.prepare('SELECT * FROM turn_bindings WHERE execution_id = ?').get(input.executionId)),
          status: 'ready',
        };
      } finally {
        database.close();
      }
    },

    async recordTurnSettled(input) {
      const { database } = await openWorkspace(input.workspaceId, false);
      if (!database) throw new RecoveryPrimitiveError('invalid-request', `Unknown turn execution: ${input.executionId}`);
      try {
        const existing = database.prepare('SELECT * FROM turn_bindings WHERE execution_id = ?').get(input.executionId);
        if (!existing || existing.workspace_id !== input.workspaceId) {
          throw new RecoveryPrimitiveError('invalid-request', `Unknown turn execution: ${input.executionId}`);
        }
        if (input.assistantEntryId) {
          const collision = database.prepare(`
            SELECT execution_id FROM turn_bindings
            WHERE session_id = ? AND assistant_entry_id = ? AND execution_id <> ?
          `).get(existing.session_id, input.assistantEntryId, input.executionId);
          if (collision) throw new RecoveryPrimitiveError('invalid-request', 'Assistant entry is already bound to another turn');
        }
        const after = snapshotRow(database, existing.workspace_id, input.afterSnapshotId);
        const before = snapshotRow(database, existing.workspace_id, existing.before_snapshot_id);
        const ready = Boolean(
          input.assistantEntryId
          && before?.availability === 'ready'
          && after?.availability === 'ready'
          && !input.failure
          && !existing.failure_json,
        );
        const settledAt = new Date().toISOString();
        database.transaction(() => {
          database.prepare(`
            UPDATE turn_bindings SET
              assistant_entry_id = ?, after_snapshot_id = ?, active_writer_scopes_json = ?,
              provenance = ?, status = ?, failure_json = ?, settled_at = ?
            WHERE execution_id = ?
          `).run(
            input.assistantEntryId ?? null,
            input.afterSnapshotId ?? null,
            JSON.stringify(mergeWriterScopes(
              parseStoredJson(existing.active_writer_scopes_json, []),
              input.activeWriterScopes,
            )),
            mergeProvenance(existing.provenance, input.provenance),
            ready ? 'ready' : 'incomplete',
            input.failure ? JSON.stringify(input.failure) : existing.failure_json,
            settledAt,
            input.executionId,
          );
          if (after) {
            database.prepare(`
              INSERT OR IGNORE INTO pins(snapshot_id, kind, key, created_at)
              VALUES (?, 'turn-after', ?, ?)
            `).run(after.id, input.executionId, settledAt);
          }
        })();
        return {
          binding: bindingFromRow(database.prepare('SELECT * FROM turn_bindings WHERE execution_id = ?').get(input.executionId)),
          status: 'ready',
        };
      } finally {
        database.close();
      }
    },

    async resolveEntry(input) {
      const { database } = await openWorkspace(input.workspaceId, false);
      if (!database) return { reason: 'session-unbound', status: 'unbound' };
      try {
        const row = database.prepare(`
          SELECT * FROM turn_bindings
          WHERE workspace_id = ? AND session_id = ? AND (user_entry_id = ? OR assistant_entry_id = ?)
          ORDER BY started_at DESC LIMIT 1
        `).get(input.workspaceId, input.sessionId, input.entryId, input.entryId);
        if (!row) {
          const session = database.prepare(`
            SELECT 1 AS present FROM turn_bindings WHERE workspace_id = ? AND session_id = ? LIMIT 1
          `).get(input.workspaceId, input.sessionId);
          return { reason: session ? 'entry-unbound' : 'session-unbound', status: 'unbound' };
        }
        const binding = bindingFromRow(row);
        const position = row.user_entry_id === input.entryId ? 'before' : 'after';
        const snapshotId = position === 'before' ? row.before_snapshot_id : row.after_snapshot_id;
        if (!snapshotId) return { binding, reason: 'snapshot-incomplete', status: 'incomplete' };
        const snapshot = snapshotRow(database, row.workspace_id, snapshotId);
        if (snapshot.availability !== 'ready') {
          return { binding, reason: 'snapshot-incomplete', status: 'incomplete' };
        }
        return { binding, position, snapshotId, status: 'ready' };
      } finally {
        database.close();
      }
    },

    async pinCheckpoint(workspaceId, snapshotId, name) {
      const { database } = await openWorkspace(workspaceId, false);
      if (!database) throw new RecoveryPrimitiveError('snapshot-missing', `Unknown workspace snapshot: ${snapshotId}`);
      try {
        const snapshot = snapshotRow(database, workspaceId, snapshotId);
        const createdAt = new Date().toISOString();
        database.prepare(`
          INSERT OR IGNORE INTO pins(snapshot_id, kind, key, created_at) VALUES (?, 'named', ?, ?)
        `).run(snapshot.id, name, createdAt);
      } finally {
        database.close();
      }
    },
  };
};
