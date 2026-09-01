import {
  parseRecoveryStorageLocation,
  parseRecoveryStorageCleanupInput,
  parseRecoveryRetentionPolicyInput,
  parseSetRecoveryStorageLocationInput,
  parseWorkspaceCombinedRecoveryApplyInput,
  parseWorkspaceCombinedRecoveryPrepareInput,
  parseWorkspaceRecoveryCheckpointInput,
  parseWorkspaceRecoveryCheckpointQuery,
  parseWorkspaceRecoveryEntryTarget,
  parseWorkspaceRecoveryMutationAfterInput,
  parseWorkspaceRecoveryMutationBeforeInput,
  parseWorkspaceRecoveryTurnSettledInput,
  parseWorkspaceRecoveryTurnStartInput,
} from '@piarium/extension-contract';

interface RecoveryEngine {
  status(workspaceId: string): Promise<unknown>;
  createCheckpoint(input: unknown): Promise<unknown>;
  recordMutationBefore(input: unknown): Promise<unknown>;
  recordMutationAfter(input: unknown): Promise<unknown>;
  recordTurnStart(input: unknown): Promise<unknown>;
  recordTurnSettled(input: unknown): Promise<unknown>;
  resolveEntry(input: unknown): Promise<unknown>;
  prepareCombinedRecovery(input: unknown): Promise<unknown>;
  prepareCombinedUndo(operationId: string): Promise<unknown>;
  applyCombinedRecovery(input: unknown): Promise<unknown>;
  getCombinedOperation(operationId: string): Promise<unknown>;
  cancelCombinedOperation(operationId: string): Promise<unknown>;
  listCheckpoints(query: unknown): Promise<unknown>;
  listCombinedOperations(workspaceId: string): Promise<unknown>;
  listStorageWorkspaces(): Promise<unknown>;
  storageStatus(workspaceId: string | undefined): Promise<unknown>;
  setStorageLocation(input: unknown): Promise<unknown>;
  setDefaultStorageLocation(input: unknown): Promise<unknown>;
  clearStorageLocationOverride(workspaceId: string): Promise<unknown>;
  getStorageMove(operationId: string): Promise<unknown>;
  cleanupStorage(input: unknown): Promise<unknown>;
  retentionStatus(workspaceId: string): Promise<unknown>;
  setRetentionPolicy(input: unknown): Promise<unknown>;
  deleteWorkspaceHistory(workspaceId: string): Promise<unknown>;
}

interface CapabilityContext {
  [key: string]: unknown;
}

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} expects an object`);
  return value as Record<string, unknown>;
};

const requiredText = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
};

export const createWorkspaceRecoveryCapabilityHandler =
  (engineOrResolver: RecoveryEngine | ((context: CapabilityContext) => Promise<RecoveryEngine>)) =>
  async (method: string, params: unknown, context: CapabilityContext): Promise<unknown> => {
    const engine = typeof engineOrResolver === 'function'
      ? await (engineOrResolver as (context: CapabilityContext) => Promise<RecoveryEngine>)(context)
      : engineOrResolver;
    if (method === 'status') {
      const input = asRecord(params, 'workspace.recovery-primitives.status');
      return engine.status(requiredText(input.workspaceId, 'workspaceId'));
    }
    if (method === 'createCheckpoint') return engine.createCheckpoint(parseWorkspaceRecoveryCheckpointInput(params));
    if (method === 'recordMutationBefore') {
      return engine.recordMutationBefore(parseWorkspaceRecoveryMutationBeforeInput(params));
    }
    if (method === 'recordMutationAfter') {
      return engine.recordMutationAfter(parseWorkspaceRecoveryMutationAfterInput(params));
    }
    if (method === 'recordTurnStart') return engine.recordTurnStart(parseWorkspaceRecoveryTurnStartInput(params));
    if (method === 'recordTurnSettled') return engine.recordTurnSettled(parseWorkspaceRecoveryTurnSettledInput(params));
    if (method === 'resolveEntry') return engine.resolveEntry(parseWorkspaceRecoveryEntryTarget(params));
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
    if (method === 'listCheckpoints') return engine.listCheckpoints(parseWorkspaceRecoveryCheckpointQuery(params));
    if (method === 'listCombinedOperations') {
      const input = asRecord(params, 'workspace.recovery-primitives.listCombinedOperations');
      return engine.listCombinedOperations(requiredText(input.workspaceId, 'workspaceId'));
    }
    if (method === 'listStorageWorkspaces') return engine.listStorageWorkspaces();
    if (method === 'storageStatus') {
      const input = asRecord(params, 'workspace.recovery-primitives.storageStatus');
      return engine.storageStatus(input.workspaceId === undefined
        ? undefined
        : requiredText(input.workspaceId, 'workspaceId'));
    }
    if (method === 'setStorageLocation') {
      return engine.setStorageLocation(parseSetRecoveryStorageLocationInput(params));
    }
    if (method === 'setDefaultStorageLocation') {
      return engine.setDefaultStorageLocation(parseRecoveryStorageLocation(params));
    }
    if (method === 'clearStorageLocationOverride') {
      const input = asRecord(params, 'workspace.recovery-primitives.clearStorageLocationOverride');
      return engine.clearStorageLocationOverride(requiredText(input.workspaceId, 'workspaceId'));
    }
    if (method === 'getStorageMove') {
      const input = asRecord(params, 'workspace.recovery-primitives.getStorageMove');
      return engine.getStorageMove(requiredText(input.operationId, 'operationId'));
    }
    if (method === 'cleanupStorage') {
      return engine.cleanupStorage(parseRecoveryStorageCleanupInput(params));
    }
    if (method === 'retentionStatus') {
      const input = asRecord(params, 'workspace.recovery-primitives.retentionStatus');
      return engine.retentionStatus(requiredText(input.workspaceId, 'workspaceId'));
    }
    if (method === 'setRetentionPolicy') {
      return engine.setRetentionPolicy(parseRecoveryRetentionPolicyInput(params));
    }
    if (method === 'deleteWorkspaceHistory') {
      const input = asRecord(params, 'workspace.recovery-primitives.deleteWorkspaceHistory');
      return engine.deleteWorkspaceHistory(requiredText(input.workspaceId, 'workspaceId'));
    }
    throw new Error(`workspace.recovery-primitives does not implement ${method}`);
  };
