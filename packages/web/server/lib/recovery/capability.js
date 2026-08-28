import {
  parseRecoveryStorageCleanupInput,
  parseSetRecoveryStorageLocationInput,
  parseWorkspaceCombinedRecoveryApplyInput,
  parseWorkspaceCombinedRecoveryPrepareInput,
  parseWorkspaceRecoveryCaptureInput,
  parseWorkspaceRecoveryCheckpointInput,
  parseWorkspaceRecoveryEntryTarget,
  parseWorkspaceRecoverySnapshotDiffInput,
  parseWorkspaceRecoverySnapshotQuery,
  parseWorkspaceRecoverySnapshotReadInput,
  parseWorkspaceRecoveryTurnSettledInput,
  parseWorkspaceRecoveryTurnStartInput,
  parseWorkspaceRestoreApplyInput,
  parseWorkspaceRestorePrepareInput,
} from '@piarium/extension-contract';

const asRecord = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} expects an object`);
  return value;
};

const requiredText = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
};

export const createWorkspaceRecoveryCapabilityHandler = (engineOrResolver) => async (method, params, context) => {
  const engine = typeof engineOrResolver === 'function'
    ? await engineOrResolver(context)
    : engineOrResolver;
  if (method === 'status') {
    const input = asRecord(params, 'workspace.recovery-primitives.status');
    return engine.status(requiredText(input.workspaceId, 'workspaceId'));
  }
  if (method === 'captureSnapshot') return engine.captureSnapshot(parseWorkspaceRecoveryCaptureInput(params));
  if (method === 'createCheckpoint') return engine.createCheckpoint(parseWorkspaceRecoveryCheckpointInput(params));
  if (method === 'recordTurnStart') return engine.recordTurnStart(parseWorkspaceRecoveryTurnStartInput(params));
  if (method === 'recordTurnSettled') return engine.recordTurnSettled(parseWorkspaceRecoveryTurnSettledInput(params));
  if (method === 'resolveEntry') return engine.resolveEntry(parseWorkspaceRecoveryEntryTarget(params));
  if (method === 'prepareRestore') return engine.prepareRestore(parseWorkspaceRestorePrepareInput(params));
  if (method === 'applyRestore') return engine.applyRestore(parseWorkspaceRestoreApplyInput(params));
  if (method === 'prepareCombinedRecovery') {
    return engine.prepareCombinedRecovery(parseWorkspaceCombinedRecoveryPrepareInput(params));
  }
  if (method === 'prepareCombinedUndo') {
    const input = asRecord(params, 'workspace.recovery-primitives.prepareCombinedUndo');
    return engine.prepareCombinedUndo(requiredText(input.operationId, 'operationId'));
  }
  if (method === 'applyCombinedRecovery') {
    return engine.applyCombinedRecovery(parseWorkspaceCombinedRecoveryApplyInput(params));
  }
  if (method === 'getCombinedOperation') {
    const input = asRecord(params, 'workspace.recovery-primitives.getCombinedOperation');
    return engine.getCombinedOperation(requiredText(input.operationId, 'operationId'));
  }
  if (method === 'cancelCombinedOperation') {
    const input = asRecord(params, 'workspace.recovery-primitives.cancelCombinedOperation');
    return engine.cancelCombinedOperation(requiredText(input.operationId, 'operationId'));
  }
  if (method === 'getOperation') {
    const input = asRecord(params, 'workspace.recovery-primitives.getOperation');
    return engine.getOperation(requiredText(input.operationId, 'operationId'));
  }
  if (method === 'cancelOperation') {
    const input = asRecord(params, 'workspace.recovery-primitives.cancelOperation');
    return engine.cancelOperation(requiredText(input.operationId, 'operationId'));
  }
  if (method === 'listSnapshots') return engine.listSnapshots(parseWorkspaceRecoverySnapshotQuery(params));
  if (method === 'listCombinedOperations') {
    const input = asRecord(params, 'workspace.recovery-primitives.listCombinedOperations');
    return engine.listCombinedOperations(requiredText(input.workspaceId, 'workspaceId'));
  }
  if (method === 'readSnapshot') return engine.readSnapshot(parseWorkspaceRecoverySnapshotReadInput(params));
  if (method === 'diffSnapshots') return engine.diffSnapshots(parseWorkspaceRecoverySnapshotDiffInput(params));
  if (method === 'storageStatus') {
    const input = asRecord(params, 'workspace.recovery-primitives.storageStatus');
    return engine.storageStatus(input.workspaceId === undefined
      ? undefined
      : requiredText(input.workspaceId, 'workspaceId'));
  }
  if (method === 'setStorageLocation') {
    return engine.setStorageLocation(parseSetRecoveryStorageLocationInput(params));
  }
  if (method === 'getStorageMove') {
    const input = asRecord(params, 'workspace.recovery-primitives.getStorageMove');
    return engine.getStorageMove(requiredText(input.operationId, 'operationId'));
  }
  if (method === 'cleanupStorage') {
    return engine.cleanupStorage(parseRecoveryStorageCleanupInput(params));
  }
  if (method === 'deleteWorkspaceHistory') {
    const input = asRecord(params, 'workspace.recovery-primitives.deleteWorkspaceHistory');
    return engine.deleteWorkspaceHistory(requiredText(input.workspaceId, 'workspaceId'));
  }
  throw new Error(`workspace.recovery-primitives does not implement ${method}`);
};
