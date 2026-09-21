import type { JsonValue } from "@varin/extension-contract";
import {
  VARIN_WORKSPACE_RECOVERY_SERVICE_ID,
  VARIN_WORKSPACE_RECOVERY_SERVICE_VERSION,
} from "@varin/extension-contract";
import {
  callWorkspaceRecoveryPrimitives,
  defineHostExtension,
} from "@varin/extension-sdk";

export default defineHostExtension({
  activate(context) {
    const call = (method: string, params: JsonValue): Promise<JsonValue> => (
      callWorkspaceRecoveryPrimitives(context.capabilities, method, params)
    );
    context.services.provide({
      id: VARIN_WORKSPACE_RECOVERY_SERVICE_ID,
      multiple: true,
      version: VARIN_WORKSPACE_RECOVERY_SERVICE_VERSION,
    }, {
      applyCombinedRecovery: (input) => call("applyCombinedRecovery", input),
      cancelCombinedOperation: (operationId) => call("cancelCombinedOperation", { operationId }),
      clearStorageLocationOverride: (workspaceId) => call("clearStorageLocationOverride", { workspaceId }),
      cleanupStorage: (input) => call("cleanupStorage", input),
      createCheckpoint: (input) => call("createCheckpoint", input),
      deleteWorkspaceHistory: (workspaceId) => call("deleteWorkspaceHistory", { workspaceId }),
      getCombinedOperation: (operationId) => call("getCombinedOperation", { operationId }),
      getStorageMove: (operationId) => call("getStorageMove", { operationId }),
      listCheckpoints: (input) => call("listCheckpoints", input),
      listCombinedOperations: (workspaceId) => call("listCombinedOperations", { workspaceId }),
      listStorageWorkspaces: () => call("listStorageWorkspaces", {}),
      prepareCombinedRecovery: (input) => call("prepareCombinedRecovery", input),
      prepareCombinedUndo: (operationId) => call("prepareCombinedUndo", { operationId }),
      recordMutationAfter: (input) => call("recordMutationAfter", input),
      recordMutationBefore: (input) => call("recordMutationBefore", input),
      recordTurnSettled: (input) => call("recordTurnSettled", input),
      recordTurnStart: (input) => call("recordTurnStart", input),
      retentionStatus: (workspaceId) => call("retentionStatus", { workspaceId }),
      resolveEntry: (input) => call("resolveEntry", input),
      setDefaultStorageLocation: (location) => call("setDefaultStorageLocation", location),
      setRetentionPolicy: (input) => call("setRetentionPolicy", input),
      setStorageLocation: (input) => call("setStorageLocation", input),
      status: (workspaceId) => call("status", { workspaceId }),
      storageStatus: (workspaceId) => call("storageStatus", workspaceId === null ? {} : { workspaceId }),
    });
  },
  migrate: ({ data }) => data,
});
