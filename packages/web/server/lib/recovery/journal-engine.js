import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  bindingFromRow,
  changeFromRow,
  checkpointFromRow,
  objectPath,
  openRecoveryJournalCatalog,
  operationFromRow,
  verifyRecoveryJournalStore,
  writeOperationRow,
} from './journal-catalog.js';
import { failedRecoveryResult, RecoveryPrimitiveError, recoveryFailure } from './errors.js';
import {
  createRecoveryFileStore,
  normalizeResourceId,
  sameState,
  statTree,
} from './journal-files.js';
import {
  createRecoveryLocationRegistry,
  readRecoveryJsonAtomic,
  writeRecoveryJsonAtomic,
} from './locations.js';

const IGNORED_WATCH_PATH = /\.piarium-(?:tmp|restore|recovery)-/;
const TERMINAL_STATES = new Set(['complete', 'aborted', 'compensated', 'needs-attention']);

const operationRevision = (value) => `sha256-${createHash('sha256')
  .update(JSON.stringify(value))
  .digest('hex')}`;

const publicOperation = (record) => ({
  affectedPathCount: record.plan.affectedPaths.length,
  appliedPathCount: record.appliedPaths.length,
  conversationState: record.conversationState,
  createdAt: record.createdAt,
  entryId: record.plan.entryId,
  expectedLeafId: record.plan.expectedLeafId,
  fileState: record.fileState,
  id: record.id,
  revision: record.plan.revision,
  sessionId: record.plan.sessionId,
  state: record.state,
  targetLeafId: record.plan.targetLeafId,
  updatedAt: record.updatedAt,
  workspaceId: record.plan.workspaceId,
  ...(record.editorImages ? { editorImages: record.editorImages } : {}),
  ...(record.editorText !== undefined ? { editorText: record.editorText } : {}),
  ...(record.failure ? { failure: record.failure } : {}),
  ...(record.navigationMarkerId ? { navigationMarkerId: record.navigationMarkerId } : {}),
  ...(record.plan.undoOf ? { undoOf: record.plan.undoOf } : {}),
});

const bindingFailure = (message, paths = []) => ({
  code: 'checkpoint-incomplete',
  message,
  retryable: false,
  ...(paths.length > 0 ? { details: { paths } } : {}),
});

export const createWorkspaceRecoveryEngine = (options) => {
  const {
    authorityId,
    dataDir,
    defaultRecoveryDir,
    documents,
    fsModule = fs,
    fsPromises = fs.promises,
    pathModule = path,
    sessionNavigation,
    storageOwnerId = 'piarium.builtin.recovery',
  } = options;
  const locations = createRecoveryLocationRegistry({
    authorityId,
    dataDir,
    defaultRecoveryDir,
    fsPromises,
    pathModule,
    storageOwnerId,
  });
  const fileStore = createRecoveryFileStore({ fsModule, fsPromises, pathModule });
  const queues = new Map();

  const runWorkspace = (workspaceId, operation) => {
    const previous = queues.get(workspaceId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    queues.set(workspaceId, current);
    void current.finally(() => {
      if (queues.get(workspaceId) === current) queues.delete(workspaceId);
    }).catch(() => undefined);
    return current;
  };

  const inspectIdentity = async (workspaceId) => {
    const workspace = await documents.inspectWorkspace(workspaceId);
    return {
      authorityId,
      canonicalRoot: workspace.root,
      filesystemProfile: process.platform === 'win32' ? 'windows-local' : `${process.platform}-local`,
      workspaceId,
    };
  };

  const inspectStorageIdentity = async (workspaceId) => {
    try {
      return { identity: await inspectIdentity(workspaceId), workspaceAvailable: true };
    } catch (error) {
      const registration = (await documents.listWorkspaceRegistrations())
        .find((entry) => entry.workspaceId === workspaceId);
      if (!registration) throw error;
      return {
        identity: {
          authorityId,
          canonicalRoot: registration.canonicalPath,
          filesystemProfile: process.platform === 'win32' ? 'windows-local' : `${process.platform}-local`,
          workspaceId,
        },
        workspaceAvailable: false,
      };
    }
  };

  const storageFor = async (identity, create = true) => {
    const selected = create
      ? await locations.materialize(identity.workspaceId)
      : await locations.selection(identity.workspaceId);
    return {
      root: await locations.resolve(identity, selected.location),
      selected,
    };
  };

  const nextSequence = (database, workspaceId) => (
    database.prepare('SELECT COALESCE(MAX(sequence), 0) AS value FROM checkpoints WHERE workspace_id = ?')
      .get(workspaceId).value + 1
  );

  const checkpointFor = (database, checkpointId) => {
    const row = database.prepare('SELECT * FROM checkpoints WHERE id = ?').get(checkpointId);
    return row ? checkpointFromRow(row) : null;
  };

  const bindingFor = (database, executionId) => {
    const row = database.prepare('SELECT * FROM turn_bindings WHERE execution_id = ?').get(executionId);
    return row ? bindingFromRow(row) : null;
  };

  const addJournaledPath = (database, executionId, relativePath) => {
    const row = database.prepare(`
      SELECT journaled_resource_ids_json FROM turn_bindings WHERE execution_id = ?
    `).get(executionId);
    if (!row) return;
    const paths = new Set(JSON.parse(row.journaled_resource_ids_json));
    paths.add(relativePath);
    database.prepare(`
      UPDATE turn_bindings SET journaled_resource_ids_json = ? WHERE execution_id = ?
    `).run(JSON.stringify([...paths].sort()), executionId);
  };

  const updateCheckpointStats = (database, checkpointId) => {
    const rows = database.prepare(`
      SELECT before_json, after_json FROM checkpoint_changes
      WHERE checkpoint_id = ? AND after_json IS NOT NULL
    `).all(checkpointId);
    let byteLength = 0;
    let changedPathCount = 0;
    for (const row of rows) {
      const before = JSON.parse(row.before_json);
      const after = JSON.parse(row.after_json);
      if (sameState(before, after)) continue;
      changedPathCount += 1;
      byteLength += Math.max(before.byteLength ?? 0, after.byteLength ?? 0);
    }
    database.prepare(`
      UPDATE checkpoints SET changed_path_count = ?, byte_length = ? WHERE id = ?
    `).run(changedPathCount, byteLength, checkpointId);
  };

  const setBindingIncomplete = (database, binding, failure, paths = binding.unrecordedResourceIds) => {
    database.transaction(() => {
      database.prepare(`
        UPDATE turn_bindings
        SET status = 'incomplete', failure_json = ?, unrecorded_resource_ids_json = ?
        WHERE execution_id = ?
      `).run(JSON.stringify(failure), JSON.stringify(paths), binding.executionId);
      database.prepare("UPDATE checkpoints SET state = 'incomplete' WHERE id = ?")
        .run(binding.checkpointId);
    })();
  };

  const recordTurnStartInternal = async (input) => {
    const identity = await inspectIdentity(input.workspaceId);
    const storage = await storageFor(identity);
    const database = await openRecoveryJournalCatalog(storage.root, { create: true, fsPromises });
    try {
      const existing = bindingFor(database, input.executionId);
      if (existing) return existing;
      const checkpointId = randomUUID();
      const createdAt = new Date().toISOString();
      database.transaction(() => {
        database.prepare(`
          INSERT INTO checkpoints(
            id, workspace_id, sequence, source, state, created_at, session_id, entry_id, execution_id
          ) VALUES (?, ?, ?, 'turn', ?, ?, ?, ?, ?)
        `).run(
          checkpointId,
          input.workspaceId,
          nextSequence(database, input.workspaceId),
          input.failure ? 'incomplete' : 'pending',
          createdAt,
          input.sessionId,
          input.userEntryId,
          input.executionId,
        );
        database.prepare(`
          INSERT INTO turn_bindings(
            execution_id, runtime_key, runtime_generation, worker_id, session_id, workspace_id,
            user_entry_id, checkpoint_id, active_writer_scopes_json, provenance, status,
            journaled_resource_ids_json, unrecorded_resource_ids_json, failure_json, started_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?)
        `).run(
          input.executionId,
          `${input.workerId}@${input.runtimeGeneration}`,
          input.runtimeGeneration,
          input.workerId,
          input.sessionId,
          input.workspaceId,
          input.userEntryId,
          checkpointId,
          JSON.stringify(input.activeWriterScopes),
          input.provenance,
          input.failure ? 'incomplete' : 'pending',
          input.failure ? JSON.stringify(input.failure) : null,
          createdAt,
        );
      })();
      return bindingFor(database, input.executionId);
    } finally {
      database.close();
    }
  };

  const recordMutationBeforeInternal = async (input) => {
    const identity = await inspectIdentity(input.workspaceId);
    const storage = await storageFor(identity);
    const database = await openRecoveryJournalCatalog(storage.root, { create: true, fsPromises });
    try {
      const binding = bindingFor(database, input.executionId);
      if (!binding || binding.workspaceId !== input.workspaceId || binding.status === 'incomplete') return false;
      const captured = await fileStore.captureState(identity, storage.root, input.path, { store: true });
      const existing = database.prepare(`
        SELECT 1 FROM checkpoint_changes WHERE checkpoint_id = ? AND path = ?
      `).get(binding.checkpointId, captured.path);
      if (!existing) {
        const now = new Date().toISOString();
        database.prepare(`
          INSERT INTO checkpoint_changes(
            checkpoint_id, path, tool_name, mutation_id, before_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          binding.checkpointId,
          captured.path,
          input.toolName,
          input.mutationId,
          JSON.stringify(captured.state),
          now,
          now,
        );
      }
      addJournaledPath(database, input.executionId, captured.path);
      return true;
    } catch (error) {
      const binding = bindingFor(database, input.executionId);
      if (binding) setBindingIncomplete(database, binding, bindingFailure(
        error instanceof Error ? error.message : 'Unable to record the file before mutation',
      ));
      throw error;
    } finally {
      database.close();
    }
  };

  const recordMutationAfterInternal = async (input) => {
    const identity = await inspectIdentity(input.workspaceId);
    const storage = await storageFor(identity);
    const database = await openRecoveryJournalCatalog(storage.root, { create: true, fsPromises });
    try {
      const binding = bindingFor(database, input.executionId);
      if (!binding || binding.workspaceId !== input.workspaceId || binding.status === 'incomplete') return false;
      const captured = await fileStore.captureState(identity, storage.root, input.path, { store: true });
      const row = database.prepare(`
        SELECT * FROM checkpoint_changes WHERE checkpoint_id = ? AND path = ?
      `).get(binding.checkpointId, captured.path);
      if (!row) {
        setBindingIncomplete(database, binding, bindingFailure(
          `Mutation finished without a durable before-image: ${captured.path}`,
          [captured.path],
        ), [captured.path]);
        return false;
      }
      const change = changeFromRow(row);
      const changed = !sameState(change.before, captured.state);
      if (changed) {
        database.prepare(`
          UPDATE checkpoint_changes
          SET after_json = ?, mutation_id = ?, tool_name = ?, updated_at = ?
          WHERE checkpoint_id = ? AND path = ?
        `).run(
          JSON.stringify(captured.state),
          input.mutationId,
          input.toolName,
          new Date().toISOString(),
          binding.checkpointId,
          captured.path,
        );
      } else {
        database.prepare('DELETE FROM checkpoint_changes WHERE checkpoint_id = ? AND path = ?')
          .run(binding.checkpointId, captured.path);
      }
      updateCheckpointStats(database, binding.checkpointId);
      return changed;
    } finally {
      database.close();
    }
  };

  const recordTurnSettledInternal = async (input) => {
    const identity = await inspectIdentity(input.workspaceId);
    const storage = await storageFor(identity);
    const database = await openRecoveryJournalCatalog(storage.root, { create: true, fsPromises });
    try {
      const binding = bindingFor(database, input.executionId);
      if (!binding) throw new RecoveryPrimitiveError('checkpoint-missing', 'Turn checkpoint was not created');
      const coverageRow = database.prepare(`
        SELECT journaled_resource_ids_json FROM turn_bindings WHERE execution_id = ?
      `).get(input.executionId);
      const recorded = JSON.parse(coverageRow.journaled_resource_ids_json).map(normalizeResourceId);
      const comparison = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
      const recordedKeys = new Set(recorded.map(comparison));
      const observed = [...new Set(input.observedResourceIds
        .map(normalizeResourceId)
        .filter((value) => value && !IGNORED_WATCH_PATH.test(value)))].sort();
      const unrecorded = observed.filter((value) => !recordedKeys.has(comparison(value)));
      const exact = !input.failure
        && (!input.mutationObserved || input.observationComplete)
        && unrecorded.length === 0
        && !(input.mutationObserved && recorded.length === 0 && observed.length === 0);
      const failure = input.failure ?? (exact ? undefined : bindingFailure(
        unrecorded.length > 0
          ? `Some changed paths were not captured before mutation: ${unrecorded.join(', ')}`
          : 'Workspace activity was observed outside the exact write/edit journal',
        unrecorded,
      ));
      const settledAt = new Date().toISOString();
      database.transaction(() => {
        database.prepare(`
          UPDATE turn_bindings SET assistant_entry_id = ?, active_writer_scopes_json = ?,
            provenance = ?, status = ?, unrecorded_resource_ids_json = ?, failure_json = ?, settled_at = ?
          WHERE execution_id = ?
        `).run(
          input.assistantEntryId ?? null,
          JSON.stringify(input.activeWriterScopes),
          input.provenance,
          exact ? 'ready' : 'incomplete',
          JSON.stringify(unrecorded),
          failure ? JSON.stringify(failure) : null,
          settledAt,
          input.executionId,
        );
        database.prepare('UPDATE checkpoints SET state = ? WHERE id = ?')
          .run(exact ? 'ready' : 'incomplete', binding.checkpointId);
        updateCheckpointStats(database, binding.checkpointId);
      })();
      return bindingFor(database, input.executionId);
    } finally {
      database.close();
    }
  };

  const resolveEntryInternal = async (input) => {
    const identity = await inspectIdentity(input.workspaceId);
    const storage = await storageFor(identity, false);
    const database = await openRecoveryJournalCatalog(storage.root, { create: false, fsPromises });
    if (!database) return { reason: 'session-unbound', status: 'unbound' };
    try {
      const row = database.prepare(`
        SELECT * FROM turn_bindings
        WHERE session_id = ? AND workspace_id = ?
          AND (user_entry_id = ? OR assistant_entry_id = ?)
        LIMIT 1
      `).get(input.sessionId, input.workspaceId, input.entryId, input.entryId);
      if (!row) return { reason: 'entry-unbound', status: 'unbound' };
      const binding = bindingFromRow(row);
      if (binding.status !== 'ready') return { binding, reason: 'checkpoint-incomplete', status: 'incomplete' };
      const checkpoint = checkpointFor(database, binding.checkpointId);
      if (!checkpoint || checkpoint.state !== 'ready') {
        return { binding, reason: 'checkpoint-incomplete', status: 'incomplete' };
      }
      return {
        binding,
        checkpoint,
        position: binding.userEntryId === input.entryId ? 'before' : 'after',
        status: 'ready',
      };
    } finally {
      database.close();
    }
  };

  const changesForEntries = (database, sessionId, entryIds) => {
    if (entryIds.length === 0) return { changes: [], incomplete: [] };
    const placeholders = entryIds.map(() => '?').join(', ');
    const checkpoints = database.prepare(`
      SELECT DISTINCT b.checkpoint_id, b.status, c.sequence
      FROM turn_bindings b
      JOIN checkpoints c ON c.id = b.checkpoint_id
      WHERE b.session_id = ?
        AND (b.user_entry_id IN (${placeholders}) OR b.assistant_entry_id IN (${placeholders}))
      ORDER BY c.sequence ASC
    `).all(sessionId, ...entryIds, ...entryIds);
    const changes = [];
    for (const checkpoint of checkpoints.filter((row) => row.status === 'ready')) {
      for (const row of database.prepare(`
        SELECT * FROM checkpoint_changes WHERE checkpoint_id = ? AND after_json IS NOT NULL
        ORDER BY path
      `).all(checkpoint.checkpoint_id)) {
        const change = changeFromRow(row);
        if (!sameState(change.before, change.after)) {
          changes.push({ ...change, sequence: checkpoint.sequence });
        }
      }
    }
    return {
      changes,
      incomplete: checkpoints.filter((row) => row.status !== 'ready').map((row) => row.checkpoint_id),
    };
  };

  const mergeInverseTargets = (changes) => {
    const byPath = new Map();
    const chainConflicts = new Set();
    for (const change of changes.sort((left, right) => left.sequence - right.sequence)) {
      const current = byPath.get(change.path);
      if (!current) byPath.set(change.path, { expected: change.after, target: change.before });
      else {
        if (!sameState(current.expected, change.before)) chainConflicts.add(change.path);
        current.expected = change.after;
      }
    }
    return { byPath, chainConflicts: [...chainConflicts] };
  };

  const buildConflicts = async (identity, root, targets) => {
    const dirtyOwners = await documents.inspectDirtyBuffers(identity.workspaceId).catch(() => []);
    const dirtyPaths = new Set(dirtyOwners.flatMap((owner) => owner.resources.map((entry) => (
      normalizeResourceId(entry.resource.resourceId)
    ))));
    const conflicts = [];
    for (const [relativePath, states] of Object.entries(targets)) {
      if (dirtyPaths.has(relativePath)) {
        conflicts.push({ kind: 'dirty-buffer', message: 'This file has unsaved editor changes', path: relativePath });
        continue;
      }
      try {
        const current = (await fileStore.captureState(identity, root, relativePath, { store: false })).state;
        if (!sameState(current, states.expected)) {
          conflicts.push({ kind: 'content-changed', message: 'The file changed after this checkpoint', path: relativePath });
        }
      } catch (error) {
        conflicts.push({ kind: 'unsupported', message: error instanceof Error ? error.message : String(error), path: relativePath });
      }
    }
    return conflicts;
  };

  const persistOperation = (database, record) => {
    record.updatedAt = new Date().toISOString();
    writeOperationRow(database, {
      createdAt: record.createdAt,
      data: record,
      id: record.id,
      kind: 'combined',
      state: record.state,
      updatedAt: record.updatedAt,
      workspaceId: record.plan.workspaceId,
    });
  };

  const locateOperation = async (operationId) => {
    const registrations = await documents.listWorkspaceRegistrations();
    for (const registration of registrations) {
      let identity;
      try {
        identity = await inspectIdentity(registration.workspaceId);
      } catch {
        continue;
      }
      const storage = await storageFor(identity, false).catch(() => null);
      if (!storage) continue;
      const database = await openRecoveryJournalCatalog(storage.root, { create: false, fsPromises }).catch(() => null);
      if (!database) continue;
      try {
        const row = database.prepare("SELECT * FROM operations WHERE id = ? AND kind = 'combined'").get(operationId);
        if (row) return { identity, record: operationFromRow(row), root: storage.root };
      } finally {
        database.close();
      }
    }
    throw new RecoveryPrimitiveError('operation-not-found', `Unknown recovery operation: ${operationId}`);
  };

  const prepareCombinedInternal = async (input) => {
    const identity = await inspectIdentity(input.workspaceId);
    const storage = await storageFor(identity);
    const navigation = await sessionNavigation.prepare(input);
    const removedEntryIds = [...new Set(navigation.removedEntryIds ?? [])];
    const database = await openRecoveryJournalCatalog(storage.root, { create: true, fsPromises });
    try {
      const targetBinding = await resolveEntryInternal(input);
      const loaded = changesForEntries(database, input.sessionId, removedEntryIds);
      const merged = mergeInverseTargets(loaded.changes);
      const targets = Object.fromEntries(merged.byPath);
      const conflicts = await buildConflicts(identity, storage.root, targets);
      for (const relativePath of merged.chainConflicts) {
        conflicts.push({ kind: 'unsupported', message: 'Recorded file history is not contiguous', path: relativePath });
      }
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const affectedPaths = Object.keys(targets).sort();
      const changedBytes = Object.values(targets).reduce((total, states) => (
        total + Math.max(states.target.byteLength ?? 0, states.expected.byteLength ?? 0)
      ), 0);
      const draft = {
        affectedPaths,
        changedBytes,
        conflicts,
        coverage: targetBinding.status === 'ready' && loaded.incomplete.length === 0 ? 'ready' : 'incomplete',
        createdAt,
        entryId: input.entryId,
        expectedLeafId: navigation.expectedLeafId,
        id,
        removedEntryIds,
        sessionId: input.sessionId,
        targetLeafId: navigation.targetLeafId,
        workspaceId: input.workspaceId,
      };
      const plan = { ...draft, revision: operationRevision(draft) };
      const record = {
        appliedPaths: [],
        conversationState: 'unchanged',
        createdAt,
        editorImages: navigation.editorImages,
        editorText: navigation.editorText,
        failure: null,
        fileState: 'unchanged',
        id,
        navigationMarkerId: null,
        plan,
        safety: {},
        state: 'planned',
        targets,
        updatedAt: createdAt,
      };
      persistOperation(database, record);
      return plan;
    } finally {
      database.close();
    }
  };

  const compensate = async (record, identity, root, database) => {
    record.state = 'compensating-files';
    persistOperation(database, record);
    for (const relativePath of [...record.appliedPaths].reverse()) {
      const current = (await fileStore.captureState(identity, root, relativePath, { store: false })).state;
      if (!sameState(current, record.targets[relativePath].target)) {
        throw new RecoveryPrimitiveError('needs-attention', `Cannot compensate a file changed after recovery: ${relativePath}`);
      }
      await fileStore.applyState(identity, root, relativePath, record.safety[relativePath]);
    }
    record.fileState = 'compensated';
    record.state = 'compensated';
    persistOperation(database, record);
  };

  const applyLocatedOperation = async (located, input) => {
    const { identity, root } = located;
    const database = await openRecoveryJournalCatalog(root, { create: false, fsPromises });
    if (!database) throw new RecoveryPrimitiveError('operation-not-found', `Unknown recovery operation: ${input.operationId}`);
    try {
      const row = database.prepare("SELECT * FROM operations WHERE id = ? AND kind = 'combined'").get(input.operationId);
      if (!row) throw new RecoveryPrimitiveError('operation-not-found', `Unknown recovery operation: ${input.operationId}`);
      const record = operationFromRow(row);
      if (record.plan.revision !== input.expectedRevision) {
        throw new RecoveryPrimitiveError('stale-plan', 'Recovery plan changed before it was applied', { retryable: true });
      }
      if (TERMINAL_STATES.has(record.state)) return publicOperation(record);
      if (record.plan.coverage !== 'ready') {
        throw new RecoveryPrimitiveError('checkpoint-incomplete', 'This conversation range contains changes without an exact before-image');
      }
      if (input.conflictPolicy === 'abort' && record.plan.conflicts.length > 0) {
        throw new RecoveryPrimitiveError('path-conflict', 'Some affected files changed after the checkpoint', {
          details: { paths: record.plan.conflicts.map((conflict) => conflict.path) },
        });
      }
      if (record.state === 'planned') {
        for (const [relativePath, states] of Object.entries(record.targets)) {
          const current = await fileStore.captureState(identity, root, relativePath, { store: true });
          if (input.conflictPolicy === 'abort' && !sameState(current.state, states.expected)) {
            throw new RecoveryPrimitiveError('path-conflict', `File changed after recovery planning: ${relativePath}`, {
              details: { paths: [relativePath] },
            });
          }
          record.safety[relativePath] = current.state;
        }
        record.state = 'applying-files';
        persistOperation(database, record);
      }
      try {
        for (const relativePath of record.plan.affectedPaths) {
          if (record.appliedPaths.includes(relativePath)) continue;
          const current = (await fileStore.captureState(identity, root, relativePath, { store: false })).state;
          if (input.conflictPolicy === 'abort' && !sameState(current, record.targets[relativePath].expected)) {
            throw new RecoveryPrimitiveError('path-conflict', `File changed while recovery was applying: ${relativePath}`);
          }
          await fileStore.applyState(identity, root, relativePath, record.targets[relativePath].target);
          const verified = (await fileStore.captureState(identity, root, relativePath, { store: false })).state;
          if (!sameState(verified, record.targets[relativePath].target)) {
            throw new RecoveryPrimitiveError('needs-attention', `Restored file did not match its checkpoint: ${relativePath}`);
          }
          record.appliedPaths.push(relativePath);
          persistOperation(database, record);
        }
        record.fileState = record.plan.affectedPaths.length > 0 ? 'restored' : 'unchanged';
        record.state = 'files-restored';
        persistOperation(database, record);
      } catch (error) {
        if (record.appliedPaths.length > 0) {
          try {
            await compensate(record, identity, root, database);
          } catch (compensationError) {
            record.failure = recoveryFailure(compensationError, 'needs-attention');
            record.fileState = 'needs-attention';
            record.state = 'needs-attention';
            persistOperation(database, record);
            throw compensationError;
          }
        }
        throw error;
      }
      record.state = 'navigating-conversation';
      persistOperation(database, record);
      try {
        const navigation = record.plan.undoOf
          ? await sessionNavigation.commitLeaf({
              expectedLeafId: record.plan.expectedLeafId,
              operationId: record.id,
              preparedTargetLeafId: record.plan.targetLeafId,
              sessionId: record.plan.sessionId,
              workspaceId: record.plan.workspaceId,
            })
          : await sessionNavigation.commit({
              entryId: record.plan.entryId,
              expectedLeafId: record.plan.expectedLeafId,
              operationId: record.id,
              preparedTargetLeafId: record.plan.targetLeafId,
              sessionId: record.plan.sessionId,
              workspaceId: record.plan.workspaceId,
            });
        record.conversationState = 'navigated';
        record.editorImages = navigation.editorImages ?? record.editorImages;
        record.editorText = navigation.editorText ?? record.editorText;
        record.navigationMarkerId = navigation.markerId ?? navigation.navigationMarkerId;
      } catch (error) {
        record.conversationState = 'diverged';
        if (record.appliedPaths.length > 0) await compensate(record, identity, root, database);
        record.failure = recoveryFailure(error, 'navigation-conflict');
        persistOperation(database, record);
        throw new RecoveryPrimitiveError('navigation-conflict', error instanceof Error ? error.message : 'Conversation navigation failed', {
          cause: error,
          operationId: record.id,
        });
      }
      record.failure = null;
      record.state = 'complete';
      persistOperation(database, record);
      return publicOperation(record);
    } finally {
      database.close();
    }
  };

  const getOperationInternal = async (operationId) => {
    const located = await locateOperation(operationId);
    return publicOperation(located.record);
  };

  const cancelOperationInternal = async (operationId) => {
    const located = await locateOperation(operationId);
    const database = await openRecoveryJournalCatalog(located.root, { create: false, fsPromises });
    try {
      const record = operationFromRow(database.prepare('SELECT * FROM operations WHERE id = ?').get(operationId));
      if (record.state === 'planned') {
        record.state = 'aborted';
        persistOperation(database, record);
      }
      return publicOperation(record);
    } finally {
      database.close();
    }
  };

  const prepareUndoInternal = async (operationId) => {
    const located = await locateOperation(operationId);
    const database = await openRecoveryJournalCatalog(located.root, { create: false, fsPromises });
    try {
      const original = operationFromRow(database.prepare('SELECT * FROM operations WHERE id = ?').get(operationId));
      if (original.state !== 'complete') {
        throw new RecoveryPrimitiveError('recovery-in-progress', 'Only a completed recovery can be undone');
      }
      const navigation = await sessionNavigation.prepareLeaf({
        sessionId: original.plan.sessionId,
        targetLeafId: original.plan.expectedLeafId,
        workspaceId: original.plan.workspaceId,
      });
      const targets = {};
      for (const relativePath of original.plan.affectedPaths) {
        targets[relativePath] = {
          expected: original.targets[relativePath].target,
          target: original.safety[relativePath],
        };
      }
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const draft = {
        affectedPaths: Object.keys(targets).sort(),
        changedBytes: Object.values(targets).reduce((total, states) => (
          total + Math.max(states.expected.byteLength ?? 0, states.target.byteLength ?? 0)
        ), 0),
        conflicts: await buildConflicts(located.identity, located.root, targets),
        coverage: 'ready',
        createdAt,
        entryId: original.plan.entryId,
        expectedLeafId: navigation.expectedLeafId,
        id,
        removedEntryIds: [],
        sessionId: original.plan.sessionId,
        targetLeafId: navigation.targetLeafId,
        undoOf: original.id,
        workspaceId: original.plan.workspaceId,
      };
      const plan = { ...draft, revision: operationRevision(draft) };
      persistOperation(database, {
        appliedPaths: [],
        conversationState: 'unchanged',
        createdAt,
        failure: null,
        fileState: 'unchanged',
        id,
        navigationMarkerId: null,
        plan,
        safety: {},
        state: 'planned',
        targets,
        updatedAt: createdAt,
      });
      return plan;
    } finally {
      database.close();
    }
  };

  const createCheckpointInternal = async (input) => {
    const identity = await inspectIdentity(input.workspaceId);
    const storage = await storageFor(identity);
    const database = await openRecoveryJournalCatalog(storage.root, { create: true, fsPromises });
    try {
      const id = randomUUID();
      database.prepare(`
        INSERT INTO checkpoints(id, workspace_id, sequence, source, state, created_at, label)
        VALUES (?, ?, ?, 'named', 'ready', ?, ?)
      `).run(id, input.workspaceId, nextSequence(database, input.workspaceId), new Date().toISOString(), input.name);
      return checkpointFor(database, id);
    } finally {
      database.close();
    }
  };

  const listCheckpointsInternal = async (input) => {
    const identity = await inspectIdentity(input.workspaceId);
    const storage = await storageFor(identity, false);
    const database = await openRecoveryJournalCatalog(storage.root, { create: false, fsPromises });
    if (!database) return { checkpoints: [], nextCursor: null };
    try {
      const limit = input.limit;
      const rows = database.prepare(`
        SELECT * FROM checkpoints
        WHERE workspace_id = ? AND (? IS NULL OR sequence < ?)
        ORDER BY sequence DESC LIMIT ?
      `).all(
        input.workspaceId,
        input.cursor ?? null,
        input.cursor ?? null,
        limit === undefined ? -1 : limit + 1,
      );
      const hasMore = limit !== undefined && rows.length > limit;
      const checkpoints = (limit === undefined ? rows : rows.slice(0, limit)).map(checkpointFromRow);
      return { checkpoints, nextCursor: hasMore ? checkpoints.at(-1).sequence : null };
    } finally {
      database.close();
    }
  };

  const listOperationsInternal = async (workspaceId) => {
    const { identity } = await inspectStorageIdentity(workspaceId);
    const storage = await storageFor(identity, false);
    const database = await openRecoveryJournalCatalog(storage.root, { create: false, fsPromises });
    if (!database) return [];
    try {
      return database.prepare(`
        SELECT * FROM operations WHERE workspace_id = ? AND kind = 'combined'
        ORDER BY created_at DESC
      `).all(workspaceId).map(operationFromRow).map(publicOperation);
    } finally {
      database.close();
    }
  };

  const storageStatusInternal = async (workspaceId) => {
    const locationDocument = await locations.read();
    if (!workspaceId) {
      return {
        authorityId,
        byteLength: 0,
        checkpointCount: 0,
        encryption: { available: false, enabled: false },
        location: locationDocument.defaultLocation,
        locationSource: 'global',
        objectCount: 0,
        readyCheckpointCount: 0,
        registryRevision: locationDocument.revision,
        state: 'missing',
      };
    }
    const { identity } = await inspectStorageIdentity(workspaceId);
    const selected = await locations.selection(workspaceId);
    const root = await locations.resolve(identity, selected.location);
    const stats = await statTree(root, fsPromises, pathModule).catch(() => ({ byteLength: 0, objectCount: 0 }));
    const objectStats = await statTree(pathModule.join(root, 'objects'), fsPromises, pathModule)
      .catch(() => ({ byteLength: 0, objectCount: 0 }));
    let checkpointCount = 0;
    let readyCheckpointCount = 0;
    let state = 'missing';
    const database = await openRecoveryJournalCatalog(root, { create: false, fsPromises }).catch((error) => {
      state = error?.code === 'storage-malformed' ? 'malformed' : 'corrupt';
      return null;
    });
    if (database) {
      try {
        const counts = database.prepare(`
          SELECT COUNT(*) AS count,
            SUM(CASE WHEN state = 'ready' THEN 1 ELSE 0 END) AS ready
          FROM checkpoints WHERE workspace_id = ?
        `).get(workspaceId);
        checkpointCount = counts.count;
        readyCheckpointCount = counts.ready ?? 0;
        state = 'ready';
      } finally {
        database.close();
      }
    }
    return {
      authorityId,
      byteLength: stats.byteLength,
      checkpointCount,
      encryption: { available: false, enabled: false },
      location: selected.location,
      locationSource: selected.source,
      objectCount: objectStats.objectCount,
      readyCheckpointCount,
      registryRevision: selected.document.revision,
      state,
      workspaceId,
    };
  };

  const writeMoveOperation = (operation) => writeRecoveryJsonAtomic(
    pathModule.join(locations.operationsRoot, `${operation.id}.json`),
    operation,
    { fsPromises, pathModule },
  );

  const moveStorageInternal = async (workspaceId, targetLocation, sourceKind) => {
    const identity = await inspectIdentity(workspaceId);
    const selected = await locations.selection(workspaceId);
    const from = selected.location;
    const to = await locations.validateLocation(targetLocation);
    const sourceRoot = await locations.resolve(identity, from);
    const destinationRoot = await locations.resolve(identity, to);
    const now = new Date().toISOString();
    const operation = {
      byteLength: 0,
      from,
      id: randomUUID(),
      startedAt: now,
      state: 'copying',
      to,
      updatedAt: now,
      workspaceId,
    };
    await writeMoveOperation(operation);
    const staging = `${destinationRoot}.piarium-move-${operation.id}`;
    try {
      if (!locations.samePath(sourceRoot, destinationRoot)) {
        await fsPromises.rm(staging, { force: true, recursive: true });
        let sourceExists = true;
        try {
          await fsPromises.lstat(sourceRoot);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          sourceExists = false;
        }
        if (sourceExists) {
          await fsPromises.mkdir(pathModule.dirname(staging), { recursive: true });
          await fsPromises.cp(sourceRoot, staging, { recursive: true, errorOnExist: true, force: false });
          operation.byteLength = (await statTree(staging, fsPromises, pathModule)).byteLength;
          operation.state = 'verifying';
          operation.updatedAt = new Date().toISOString();
          await writeMoveOperation(operation);
          await verifyRecoveryJournalStore(staging, { fsPromises });
          try {
            await fsPromises.lstat(destinationRoot);
            throw new RecoveryPrimitiveError('storage-move-failed', `Recovery destination already exists: ${destinationRoot}`);
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
          await fsPromises.rename(staging, destinationRoot);
        } else {
          await fsPromises.mkdir(destinationRoot, { recursive: true });
        }
        operation.state = 'switching';
        operation.updatedAt = new Date().toISOString();
        await writeMoveOperation(operation);
      }
      await locations.commit(workspaceId, from, to, {
        ...(sourceKind === 'global' ? { source: 'global', expectedDefaultLocation: to } : {}),
      });
      if (!locations.samePath(sourceRoot, destinationRoot)) {
        // The verified destination is authoritative after the registry switch.
        // Failure to remove the old copy must not turn a completed move into a
        // false rollback or make callers retry the already-committed decision.
        await fsPromises.rm(sourceRoot, { force: true, recursive: true }).catch(() => undefined);
      }
      operation.state = 'complete';
    } catch (error) {
      await fsPromises.rm(staging, { force: true, recursive: true }).catch(() => undefined);
      operation.failure = recoveryFailure(error, 'storage-move-failed');
      operation.state = 'failed';
    }
    operation.updatedAt = new Date().toISOString();
    await writeMoveOperation(operation);
    return operation;
  };

  const listStorageWorkspacesInternal = async () => {
    const registrations = await documents.listWorkspaceRegistrations();
    const document = await locations.read();
    const known = new Map(registrations.map((entry) => [entry.workspaceId, entry]));
    for (const workspaceId of [...Object.keys(document.locations), ...Object.keys(document.inheritedLocations)]) {
      if (!known.has(workspaceId)) known.set(workspaceId, { canonicalPath: workspaceId, workspaceId });
    }
    const results = [];
    for (const entry of known.values()) {
      const selected = await locations.selection(entry.workspaceId);
      try {
        const storageIdentity = await inspectStorageIdentity(entry.workspaceId);
        const { identity } = storageIdentity;
        const status = await storageStatusInternal(entry.workspaceId);
        const storage = await storageFor(identity, false);
        let lastActivityAt = null;
        const database = await openRecoveryJournalCatalog(storage.root, { create: false, fsPromises });
        if (database) {
          try {
            lastActivityAt = database.prepare(`
              SELECT MAX(value) AS value FROM (
                SELECT MAX(created_at) AS value FROM checkpoints WHERE workspace_id = ?
                UNION ALL SELECT MAX(updated_at) AS value FROM operations WHERE workspace_id = ?
              )
            `).get(entry.workspaceId, entry.workspaceId).value ?? null;
          } finally {
            database.close();
          }
        }
        results.push({
          byteLength: status.byteLength,
          canonicalRoot: identity.canonicalRoot,
          checkpointCount: status.checkpointCount,
          lastActivityAt,
          location: selected.location,
          locationSource: selected.source,
          migrationRequired: selected.migrationRequired,
          objectCount: status.objectCount,
          state: status.state,
          storageAvailable: true,
          workspaceAvailable: storageIdentity.workspaceAvailable,
          workspaceId: entry.workspaceId,
        });
      } catch (error) {
        results.push({
          byteLength: 0,
          canonicalRoot: entry.canonicalPath,
          checkpointCount: 0,
          failure: recoveryFailure(error, 'unavailable'),
          lastActivityAt: null,
          location: selected.location,
          locationSource: selected.source,
          migrationRequired: selected.migrationRequired,
          objectCount: 0,
          state: 'unavailable',
          storageAvailable: false,
          workspaceAvailable: false,
          workspaceId: entry.workspaceId,
        });
      }
    }
    return results.sort((left, right) => String(right.lastActivityAt ?? '').localeCompare(String(left.lastActivityAt ?? '')));
  };

  const referencedObjects = (database) => {
    const refs = new Set();
    const add = (state) => {
      if (state && typeof state.objectHash === 'string') refs.add(state.objectHash);
    };
    for (const row of database.prepare('SELECT before_json, after_json FROM checkpoint_changes').iterate()) {
      add(JSON.parse(row.before_json));
      if (row.after_json) add(JSON.parse(row.after_json));
    }
    for (const row of database.prepare("SELECT data_json FROM operations WHERE kind = 'combined'").iterate()) {
      const operation = JSON.parse(row.data_json);
      for (const states of Object.values(operation.targets ?? {})) {
        add(states.expected);
        add(states.target);
      }
      for (const state of Object.values(operation.safety ?? {})) add(state);
    }
    return refs;
  };

  const cleanupStorageInternal = async (workspaceId) => {
    const { identity } = await inspectStorageIdentity(workspaceId);
    const storage = await storageFor(identity, false);
    const database = await openRecoveryJournalCatalog(storage.root, { create: false, fsPromises });
    const operationId = randomUUID();
    if (!database) return { byteLengthReclaimed: 0, failures: [], objectsDeleted: 0, operationId, recordsDeleted: 0, status: 'complete', workspaceId };
    try {
      const refs = referencedObjects(database);
      const objectsRoot = pathModule.join(storage.root, 'objects');
      let byteLengthReclaimed = 0;
      let objectsDeleted = 0;
      const walk = async (directory) => {
        let entries;
        try {
          entries = await fsPromises.readdir(directory, { withFileTypes: true });
        } catch (error) {
          if (error?.code === 'ENOENT') return;
          throw error;
        }
        for (const entry of entries) {
          const target = pathModule.join(directory, entry.name);
          if (entry.isDirectory()) await walk(target);
          else if (entry.isFile()) {
            const relative = pathModule.relative(objectsRoot, target).replace(/[\\/]/g, '');
            if (refs.has(`sha256-${relative}`)) continue;
            byteLengthReclaimed += (await fsPromises.stat(target)).size;
            await fsPromises.rm(target, { force: true });
            objectsDeleted += 1;
          }
        }
      };
      await walk(objectsRoot);
      return { byteLengthReclaimed, failures: [], objectsDeleted, operationId, recordsDeleted: 0, status: 'complete', workspaceId };
    } finally {
      database.close();
    }
  };

  const deleteWorkspaceHistoryInternal = async (workspaceId) => {
    const { identity } = await inspectStorageIdentity(workspaceId);
    const storage = await storageFor(identity, false);
    const stats = await statTree(storage.root, fsPromises, pathModule).catch(() => ({ byteLength: 0, objectCount: 0 }));
    const objectStats = await statTree(pathModule.join(storage.root, 'objects'), fsPromises, pathModule)
      .catch(() => ({ byteLength: 0, objectCount: 0 }));
    await fsPromises.rm(storage.root, { force: true, recursive: true });
    await locations.remove(workspaceId);
    return {
      byteLengthReclaimed: stats.byteLength,
      failures: [],
      objectsDeleted: objectStats.objectCount,
      operationId: randomUUID(),
      recordsDeleted: 0,
      status: 'complete',
      workspaceId,
    };
  };

  const resumeUnfinished = async () => {
    const registrations = await documents.listWorkspaceRegistrations();
    const resolved = [];
    for (const registration of registrations) {
      const identity = await inspectIdentity(registration.workspaceId).catch(() => null);
      if (!identity) continue;
      const storage = await storageFor(identity, false).catch(() => null);
      if (!storage) continue;
      const database = await openRecoveryJournalCatalog(storage.root, { create: false, fsPromises }).catch(() => null);
      if (!database) continue;
      try {
        const rows = database.prepare(`
          SELECT * FROM operations WHERE kind = 'combined'
          AND state NOT IN ('complete', 'aborted', 'compensated', 'needs-attention')
        `).all();
        for (const row of rows) {
          const record = operationFromRow(row);
          if (record.state === 'planned') continue;
          try {
            if (record.appliedPaths.length > 0 && Object.keys(record.safety ?? {}).length > 0) {
              await compensate(record, identity, storage.root, database);
            } else {
              record.state = 'aborted';
              persistOperation(database, record);
            }
          } catch (error) {
            record.failure = recoveryFailure(error, 'needs-attention');
            record.fileState = 'needs-attention';
            record.state = 'needs-attention';
            persistOperation(database, record);
          }
          resolved.push(publicOperation(record));
        }
      } finally {
        database.close();
      }
    }
    return resolved;
  };

  const safe = (operation, fallbackCode) => operation().catch((error) => failedRecoveryResult(error, fallbackCode));

  return {
    locations,
    applyCombinedRecovery: (input) => safe(async () => {
      const located = await locateOperation(input.operationId);
      return {
        operation: await runWorkspace(located.identity.workspaceId, async () => (
          applyLocatedOperation(await locateOperation(input.operationId), input)
        )),
        status: 'ready',
      };
    }),
    cancelCombinedOperation: (operationId) => safe(async () => {
      const located = await locateOperation(operationId);
      return {
        operation: await runWorkspace(located.identity.workspaceId, () => cancelOperationInternal(operationId)),
        status: 'ready',
      };
    }),
    clearStorageLocationOverride: (workspaceId) => safe(() => runWorkspace(workspaceId, async () => {
      const global = await locations.globalSelection();
      return { operation: await moveStorageInternal(workspaceId, global.location, 'global'), status: 'ready' };
    })),
    cleanupStorage: (input) => safe(() => runWorkspace(input.workspaceId, async () => ({
      result: await cleanupStorageInternal(input.workspaceId),
      status: 'ready',
    }))),
    createCheckpoint: (input) => safe(async () => ({ checkpoint: await runWorkspace(input.workspaceId, () => createCheckpointInternal(input)), status: 'ready' })),
    deleteWorkspaceHistory: (workspaceId) => safe(() => runWorkspace(workspaceId, async () => ({
      result: await deleteWorkspaceHistoryInternal(workspaceId),
      status: 'ready',
    }))),
    fenceUnfinishedOperations: resumeUnfinished,
    getCombinedOperation: (operationId) => safe(async () => ({ operation: await getOperationInternal(operationId), status: 'ready' })),
    getStorageMove: (operationId) => safe(async () => ({
      operation: await readRecoveryJsonAtomic(pathModule.join(locations.operationsRoot, `${operationId}.json`), { fsPromises }),
      status: 'ready',
    })),
    listCheckpoints: (input) => safe(async () => ({ page: await listCheckpointsInternal(input), status: 'ready' })),
    listCombinedOperations: (workspaceId) => safe(async () => ({ operations: await listOperationsInternal(workspaceId), status: 'ready' })),
    listStorageWorkspaces: () => safe(async () => ({ status: 'ready', workspaces: await listStorageWorkspacesInternal() })),
    prepareCombinedRecovery: (input) => safe(async () => ({ plan: await runWorkspace(input.workspaceId, () => prepareCombinedInternal(input)), status: 'ready' })),
    prepareCombinedUndo: (operationId) => safe(async () => {
      const located = await locateOperation(operationId);
      return {
        plan: await runWorkspace(located.identity.workspaceId, () => prepareUndoInternal(operationId)),
        status: 'ready',
      };
    }),
    recordMutationAfter: (input) => safe(async () => ({ recorded: await runWorkspace(input.workspaceId, () => recordMutationAfterInternal(input)), status: 'ready' })),
    recordMutationBefore: (input) => safe(async () => ({ recorded: await runWorkspace(input.workspaceId, () => recordMutationBeforeInternal(input)), status: 'ready' })),
    recordTurnSettled: (input) => safe(async () => ({ binding: await runWorkspace(input.workspaceId, () => recordTurnSettledInternal(input)), status: 'ready' })),
    recordTurnStart: (input) => safe(async () => ({ binding: await runWorkspace(input.workspaceId, () => recordTurnStartInternal(input)), status: 'ready' })),
    resolveEntry: (input) => safe(() => resolveEntryInternal(input)),
    resumeCombinedOperations: resumeUnfinished,
    resumeWorkspaceOperations: async () => [],
    setDefaultStorageLocation: (location) => safe(async () => {
      await locations.setDefault(await locations.validateLocation(location));
      return { status: 'ready', storage: await storageStatusInternal() };
    }),
    setStorageLocation: (input) => safe(() => runWorkspace(input.workspaceId, async () => ({
      operation: await moveStorageInternal(input.workspaceId, input.location, 'workspace'),
      status: 'ready',
    }))),
    status: (workspaceId) => safe(async () => ({
      capabilities: { bindings: true, checkpoints: true, combined: true, journal: true, redo: true, storageManagement: true },
      identity: await inspectIdentity(workspaceId),
      status: 'ready',
      storage: await storageStatusInternal(workspaceId),
    })),
    storageStatus: (workspaceId) => safe(async () => ({ status: 'ready', storage: await storageStatusInternal(workspaceId) })),
  };
};
