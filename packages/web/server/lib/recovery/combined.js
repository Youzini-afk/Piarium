import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { openRecoveryCatalog, recordCatalogOperation } from './catalog.js';
import { RecoveryPrimitiveError, recoveryFailure } from './errors.js';
import { writeRecoveryJsonAtomic } from './locations.js';

const SCHEMA_VERSION = 1;
const TERMINAL_STATES = new Set(['complete', 'alternate-ready', 'aborted', 'compensated', 'needs-attention']);

const canonicalJson = (value) => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  throw new RecoveryPrimitiveError('invalid-request', 'Combined recovery plan contains a non-JSON value');
};

const revisionOf = (value) => `sha256-${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;

const sameLeaf = (left, right) => (left ?? null) === (right ?? null);

const publicOperation = (record, workspaceOperation) => ({
  conversationState: record.conversationState,
  createdAt: record.createdAt,
  ...(record.destinationPath ? { destinationPath: record.destinationPath } : {}),
  entryId: record.plan.entryId,
  expectedLeafId: record.plan.expectedLeafId,
  id: record.id,
  ...(record.mode ? { mode: record.mode } : {}),
  ...(record.navigationMarkerId ? { navigationMarkerId: record.navigationMarkerId } : {}),
  restoreOperationId: record.plan.restore.id,
  revision: record.plan.revision,
  sessionId: record.plan.sessionId,
  state: record.state,
  targetLeafId: record.plan.targetLeafId,
  targetSnapshotId: record.plan.targetSnapshotId,
  ...(record.plan.undoOf ? { undoOf: record.plan.undoOf } : {}),
  updatedAt: record.updatedAt,
  workspaceId: record.plan.workspaceId,
  workspaceState: record.workspaceState,
  ...(workspaceOperation ? {
    workspaceAppliedOperations: workspaceOperation.appliedOperations,
    workspaceTotalOperations: workspaceOperation.totalOperations,
  } : {}),
  ...(record.editorImages ? { editorImages: record.editorImages } : {}),
  ...(record.editorText !== undefined ? { editorText: record.editorText } : {}),
  ...(record.failure ? { failure: record.failure } : {}),
});

const assertRecord = (value, operationId) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || value.kind !== 'combined-recovery'
    || value.id !== operationId
    || !value.plan
    || typeof value.state !== 'string') {
    throw new RecoveryPrimitiveError('storage-malformed', `Combined recovery operation is malformed: ${operationId}`);
  }
  return value;
};

const bindingFailure = (resolved) => {
  if (resolved?.status === 'failed') {
    return new RecoveryPrimitiveError(
      resolved.failure.code,
      resolved.failure.message,
      {
        details: resolved.failure.details,
        operationId: resolved.failure.operationId,
        retryable: resolved.failure.retryable,
      },
    );
  }
  if (resolved?.status === 'incomplete') {
    return new RecoveryPrimitiveError('snapshot-incomplete', 'The selected message has no complete workspace checkpoint');
  }
  return new RecoveryPrimitiveError('snapshot-unavailable', 'The selected message is not bound to this workspace');
};

const navigationCode = (error) => typeof error?.code === 'string' ? error.code : '';
const isLeafConflict = (error) => navigationCode(error) === 'session_leaf_conflict';
const isDivergedNavigation = (error) => [
  'session_navigation_divergence',
  'session_navigation_operation_conflict',
  'session_navigation_target_conflict',
].includes(navigationCode(error));
const isWorkspaceDivergence = (error) => ['stale-plan', 'needs-attention'].includes(navigationCode(error));

export const createCombinedRecoveryManager = ({
  bindings,
  fsPromises,
  inspectIdentity,
  locations,
  pathModule = path,
  restore,
  sessionNavigation,
  storageFor,
}) => {
  const operationQueues = new Map();
  const workspaceQueues = new Map();
  const operationPath = (operationId) => pathModule.join(
    locations.operationsRoot,
    `combined-${operationId}.json`,
  );

  const runOperation = (operationId, operation) => {
    const previous = operationQueues.get(operationId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    operationQueues.set(operationId, current);
    void current.finally(() => {
      if (operationQueues.get(operationId) === current) operationQueues.delete(operationId);
    }).catch(() => undefined);
    return current;
  };

  const runWorkspace = (workspaceId, operation) => {
    const previous = workspaceQueues.get(workspaceId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    workspaceQueues.set(workspaceId, current);
    void current.finally(() => {
      if (workspaceQueues.get(workspaceId) === current) workspaceQueues.delete(workspaceId);
    }).catch(() => undefined);
    return current;
  };

  const writeOperation = async (record) => {
    record.updatedAt = new Date().toISOString();
    await writeRecoveryJsonAtomic(operationPath(record.id), record, { fsPromises, pathModule });
    const identity = await inspectIdentity(record.plan.workspaceId);
    const storage = await storageFor(identity);
    const database = await openRecoveryCatalog(storage.root, { create: false, fsPromises });
    try {
      if (database) {
        recordCatalogOperation(database, {
          createdAt: record.createdAt,
          data: {
            conversationState: record.conversationState,
            restoreOperationId: record.plan.restore.id,
            revision: record.plan.revision,
            workspaceState: record.workspaceState,
          },
          id: record.id,
          state: record.state,
          type: 'combined-recovery',
          updatedAt: record.updatedAt,
          workspaceId: record.plan.workspaceId,
        });
      }
    } finally {
      database?.close();
    }
  };

  const readOperation = async (operationId) => {
    try {
      return assertRecord(
        JSON.parse(await fsPromises.readFile(operationPath(operationId), 'utf8')),
        operationId,
      );
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new RecoveryPrimitiveError('operation-not-found', `Unknown combined recovery operation: ${operationId}`);
      }
      if (error instanceof RecoveryPrimitiveError) throw error;
      throw new RecoveryPrimitiveError(
        'storage-malformed',
        `Combined recovery operation cannot be read: ${operationId}`,
        { cause: error },
      );
    }
  };

  const listOperationRecords = async () => {
    let entries;
    try {
      entries = await fsPromises.readdir(locations.operationsRoot);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const records = [];
    for (const name of entries) {
      if (!name.startsWith('combined-') || !name.endsWith('.json')) continue;
      const operationId = name.slice('combined-'.length, -'.json'.length);
      records.push(await readOperation(operationId));
    }
    return records;
  };

  const prepare = async (input) => {
    if (!sessionNavigation) {
      throw new RecoveryPrimitiveError('unavailable', 'Pi conversation navigation is unavailable');
    }
    const [resolved, navigation] = await Promise.all([
      bindings.resolveEntry({
        entryId: input.entryId,
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
      }),
      sessionNavigation.prepare({
        sessionId: input.sessionId,
        targetId: input.entryId,
        workspaceId: input.workspaceId,
      }),
    ]);
    if (resolved.status !== 'ready') throw bindingFailure(resolved);
    const restorePlan = await restore.prepare({
      ...(input.newWorkspacePath ? { newWorkspacePath: input.newWorkspacePath } : {}),
      targetSnapshotId: resolved.snapshotId,
      workspaceId: input.workspaceId,
    });
    let confirmed;
    try {
      confirmed = await sessionNavigation.prepare({
        sessionId: input.sessionId,
        targetId: input.entryId,
        workspaceId: input.workspaceId,
      });
      if (!sameLeaf(confirmed.expectedLeafId, navigation.expectedLeafId)
        || !sameLeaf(confirmed.targetLeafId, navigation.targetLeafId)) {
        throw new RecoveryPrimitiveError('stale-plan', 'Conversation changed while combined recovery was prepared', {
          retryable: true,
        });
      }
    } catch (error) {
      await restore.cancel(restorePlan.id).catch(() => undefined);
      throw error;
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const draft = {
      allowedModes: restorePlan.allowedModes,
      createdAt,
      entryId: input.entryId,
      expectedLeafId: confirmed.expectedLeafId ?? null,
      id,
      navigationKind: 'entry',
      restore: restorePlan,
      sessionId: input.sessionId,
      targetLeafId: confirmed.targetLeafId ?? null,
      targetSnapshotId: resolved.snapshotId,
      workspaceId: input.workspaceId,
    };
    const plan = { ...draft, revision: revisionOf(draft) };
    const record = {
      conversationState: 'unchanged',
      createdAt,
      failure: null,
      id,
      kind: 'combined-recovery',
      navigationMarkerId: null,
      plan,
      schemaVersion: SCHEMA_VERSION,
      state: 'planned',
      updatedAt: createdAt,
      workspaceState: 'unchanged',
    };
    try {
      await writeOperation(record);
    } catch (error) {
      await restore.cancel(restorePlan.id).catch(() => undefined);
      throw error;
    }
    return plan;
  };

  const prepareUndo = async (operationId) => {
    if (!sessionNavigation?.prepareLeaf) {
      throw new RecoveryPrimitiveError('unavailable', 'Direct Pi conversation leaf navigation is unavailable');
    }
    const previous = await readOperation(operationId);
    if (previous.state !== 'complete'
      || previous.conversationState !== 'navigated'
      || previous.workspaceState !== 'restored') {
      throw new RecoveryPrimitiveError('invalid-request', 'Only a completed combined recovery can be undone');
    }
    const navigation = await sessionNavigation.prepareLeaf({
      sessionId: previous.plan.sessionId,
      targetLeafId: previous.plan.expectedLeafId,
      workspaceId: previous.plan.workspaceId,
    });
    const restorePlan = await restore.prepare({
      targetSnapshotId: previous.plan.restore.safetySnapshotId,
      workspaceId: previous.plan.workspaceId,
    });
    let confirmed;
    try {
      confirmed = await sessionNavigation.prepareLeaf({
        sessionId: previous.plan.sessionId,
        targetLeafId: previous.plan.expectedLeafId,
        workspaceId: previous.plan.workspaceId,
      });
      if (!sameLeaf(confirmed.expectedLeafId, navigation.expectedLeafId)
        || !sameLeaf(confirmed.targetLeafId, navigation.targetLeafId)) {
        throw new RecoveryPrimitiveError('stale-plan', 'Conversation changed while combined recovery undo was prepared', {
          retryable: true,
        });
      }
    } catch (error) {
      await restore.cancel(restorePlan.id).catch(() => undefined);
      throw error;
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const draft = {
      allowedModes: restorePlan.allowedModes,
      createdAt,
      entryId: previous.plan.entryId,
      expectedLeafId: confirmed.expectedLeafId ?? null,
      id,
      navigationKind: 'leaf',
      restore: restorePlan,
      sessionId: previous.plan.sessionId,
      targetLeafId: confirmed.targetLeafId ?? null,
      targetSnapshotId: previous.plan.restore.safetySnapshotId,
      undoOf: operationId,
      workspaceId: previous.plan.workspaceId,
    };
    const plan = { ...draft, revision: revisionOf(draft) };
    const record = {
      conversationState: 'unchanged',
      createdAt,
      failure: null,
      id,
      kind: 'combined-recovery',
      navigationMarkerId: null,
      plan,
      schemaVersion: SCHEMA_VERSION,
      state: 'planned',
      updatedAt: createdAt,
      workspaceState: 'unchanged',
    };
    try {
      await writeOperation(record);
    } catch (error) {
      await restore.cancel(restorePlan.id).catch(() => undefined);
      throw error;
    }
    return plan;
  };

  const compensateForLeafConflict = async (record, error) => {
    record.failure = recoveryFailure(new RecoveryPrimitiveError(
      'navigation-conflict',
      error instanceof Error ? error.message : 'Conversation leaf changed before combined recovery navigation',
      { cause: error, details: { operationId: record.id } },
    ));
    record.state = 'compensating-workspace';
    await writeOperation(record);
    try {
      const compensated = await restore.compensate(record.plan.restore.id);
      record.workspaceState = compensated.state === 'compensated' ? 'compensated' : 'needs-attention';
      record.state = compensated.state === 'compensated' ? 'compensated' : 'needs-attention';
      await writeOperation(record);
      return publicOperation(record);
    } catch (compensationError) {
      if (compensationError?.simulatedCrash === true) throw compensationError;
      record.failure = recoveryFailure(compensationError, 'needs-attention');
      record.workspaceState = 'needs-attention';
      record.state = 'needs-attention';
      await writeOperation(record);
      throw compensationError;
    }
  };

  const applyInternal = async (record, input) => {
    if (record.plan.revision !== input.expectedRevision) {
      throw new RecoveryPrimitiveError('stale-plan', 'Combined recovery plan revision is stale');
    }
    if (TERMINAL_STATES.has(record.state)) return publicOperation(record);
    if (record.state === 'compensating-workspace') {
      const compensated = await restore.compensate(record.plan.restore.id);
      record.workspaceState = compensated.state === 'compensated' ? 'compensated' : 'needs-attention';
      record.state = compensated.state === 'compensated' ? 'compensated' : 'needs-attention';
      await writeOperation(record);
      return publicOperation(record);
    }
    const mode = input.mode ?? record.mode ?? 'in-place';
    if (!record.plan.allowedModes.includes(mode)) {
      throw new RecoveryPrimitiveError(
        'navigation-conflict',
        `Combined recovery mode is unavailable: ${mode}`,
        { details: { restoreOperationId: record.plan.restore.id } },
      );
    }
    if (record.mode && record.mode !== mode) {
      throw new RecoveryPrimitiveError('stale-plan', 'Combined recovery mode changed after application started');
    }
    record.mode = mode;
    if (mode === 'new-workspace') {
      record.state = 'applying-workspace';
      await writeOperation(record);
      const workspace = await restore.apply({
        expectedRevision: record.plan.restore.revision,
        mode: 'new-workspace',
        newWorkspacePath: input.newWorkspacePath ?? record.plan.restore.newWorkspacePath,
        operationId: record.plan.restore.id,
      });
      if (workspace.state !== 'complete') {
        throw new RecoveryPrimitiveError('needs-attention', 'New-workspace recovery did not complete', {
          operationId: record.id,
        });
      }
      record.destinationPath = workspace.destinationPath;
      record.state = 'alternate-ready';
      record.workspaceState = 'materialized-new';
      await writeOperation(record);
      return publicOperation(record);
    }
    if (record.state === 'planned' || record.state === 'applying-workspace') {
      record.state = 'applying-workspace';
      await writeOperation(record);
      const workspace = await restore.apply({
        expectedRevision: record.plan.restore.revision,
        holdForConversation: true,
        mode: 'in-place',
        operationId: record.plan.restore.id,
      });
      if (workspace.state !== 'workspace-verified') {
        throw new RecoveryPrimitiveError('needs-attention', 'Workspace restore did not reach its committed checkpoint', {
          operationId: record.id,
        });
      }
      record.workspaceState = 'restored';
      record.state = 'workspace-verified';
      await writeOperation(record);
    }
    if (record.state === 'workspace-verified') {
      record.state = 'navigating-conversation';
      await writeOperation(record);
    }
    if (record.state === 'navigating-conversation' && record.conversationState !== 'navigated') {
      let navigation;
      try {
        // Conversation navigation is a retryable saga step after the filesystem
        // transaction has released maintenance. Revalidate its content witness
        // on every attempt so reopening a session cannot silently navigate after
        // intervening workspace edits.
        await restore.verifyPending(record.plan.restore.id);
        const navigationInput = {
          expectedLeafId: record.plan.expectedLeafId,
          operationId: record.id,
          preparedTargetLeafId: record.plan.targetLeafId,
          sessionId: record.plan.sessionId,
          workspaceId: record.plan.workspaceId,
        };
        navigation = record.plan.navigationKind === 'leaf'
          ? await sessionNavigation.commitLeaf(navigationInput)
          : await sessionNavigation.commit({ ...navigationInput, targetId: record.plan.entryId });
      } catch (error) {
        if (isLeafConflict(error)) return compensateForLeafConflict(record, error);
        const diverged = isDivergedNavigation(error) || isWorkspaceDivergence(error);
        record.failure = recoveryFailure(new RecoveryPrimitiveError(
          diverged ? 'navigation-conflict' : 'recovery-in-progress',
          error instanceof Error ? error.message : 'Conversation navigation did not complete',
          {
            cause: error,
            details: { operationId: record.id },
            operationId: record.id,
            retryable: !diverged,
          },
        ));
        if (diverged) record.state = 'needs-attention';
        await writeOperation(record);
        throw new RecoveryPrimitiveError(record.failure.code, record.failure.message, {
          details: record.failure.details,
          operationId: record.id,
          retryable: record.failure.retryable,
        });
      }
      record.conversationState = 'navigated';
      record.editorImages = navigation.editorImages;
      record.editorText = navigation.editorText;
      record.navigationMarkerId = navigation.markerId ?? navigation.navigationMarkerId;
      record.failure = null;
      await writeOperation(record);
    }
    if (record.conversationState === 'navigated') {
      try {
        await restore.finalize(record.plan.restore.id);
        record.state = 'complete';
        record.workspaceState = 'restored';
        await writeOperation(record);
      } catch (error) {
        record.failure = recoveryFailure(error, 'needs-attention');
        record.state = 'needs-attention';
        record.workspaceState = 'needs-attention';
        await writeOperation(record);
        throw new RecoveryPrimitiveError('needs-attention', 'Combined recovery requires attention after conversation navigation', {
          cause: error,
          details: { operationId: record.id, restoreOperationId: record.plan.restore.id },
          operationId: record.id,
        });
      }
    }
    return publicOperation(record);
  };

  return {
    apply: (input) => runOperation(input.operationId, async () => {
      const record = await readOperation(input.operationId);
      return runWorkspace(record.plan.workspaceId, () => applyInternal(record, input));
    }),
    cancel: (operationId) => runOperation(operationId, async () => {
      const record = await readOperation(operationId);
      if (record.state === 'aborted') return publicOperation(record);
      if (record.state !== 'planned') {
        throw new RecoveryPrimitiveError('recovery-in-progress', 'Combined recovery cannot be cancelled after workspace application starts');
      }
      await restore.cancel(record.plan.restore.id);
      record.state = 'aborted';
      await writeOperation(record);
      return publicOperation(record);
    }),
    async deleteWorkspaceOperations(workspaceId) {
      let entries;
      try {
        entries = await fsPromises.readdir(locations.operationsRoot);
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      for (const name of entries) {
        if (!name.startsWith('combined-') || !name.endsWith('.json')) continue;
        const filePath = pathModule.join(locations.operationsRoot, name);
        try {
          const record = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
          if (record?.kind === 'combined-recovery' && record.plan?.workspaceId === workspaceId) {
            await fsPromises.rm(filePath, { force: true });
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    },
    async get(operationId) {
      const record = await readOperation(operationId);
      return publicOperation(record, await restore.get(record.plan.restore.id));
    },
    async list(workspaceId) {
      const records = (await listOperationRecords())
        .filter((record) => record.plan.workspaceId === workspaceId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return Promise.all(records.map(async (record) => (
        publicOperation(record, await restore.get(record.plan.restore.id))
      )));
    },
    prepare,
    prepareUndo: (operationId) => runOperation(operationId, async () => {
      const record = await readOperation(operationId);
      return runWorkspace(record.plan.workspaceId, () => prepareUndo(operationId));
    }),
    async resumeUnfinished() {
      const records = await listOperationRecords();
      const results = [];
      for (const record of records) {
        if (![
          'applying-workspace',
          'workspace-verified',
          'navigating-conversation',
          'compensating-workspace',
        ].includes(record.state)) continue;
        try {
          results.push(await runOperation(record.id, () => (
            runWorkspace(record.plan.workspaceId, () => applyInternal(record, {
              expectedRevision: record.plan.revision,
              operationId: record.id,
            }))
          )));
        } catch (error) {
          results.push({ error, operationId: record.id });
        }
      }
      return results;
    },
  };
};
