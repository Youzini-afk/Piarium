import type { JsonValue } from "@piarium/extension-contract";
import {
  PIARIUM_WORKSPACE_RECOVERY_SERVICE_ID,
  PIARIUM_WORKSPACE_RECOVERY_SERVICE_VERSION,
} from "@piarium/extension-contract";
import {
  callWorkspaceRecoveryPrimitives,
  defineHostExtension,
} from "@piarium/extension-sdk";

export default defineHostExtension({
  activate(context) {
    const call = (method: string, params: JsonValue): Promise<JsonValue> => (
      callWorkspaceRecoveryPrimitives(context.capabilities, method, params)
    );
    context.services.provide({
      id: PIARIUM_WORKSPACE_RECOVERY_SERVICE_ID,
      multiple: true,
      version: PIARIUM_WORKSPACE_RECOVERY_SERVICE_VERSION,
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
      resolveEntry: (input) => call("resolveEntry", input),
      setDefaultStorageLocation: (location) => call("setDefaultStorageLocation", location),
      setStorageLocation: (input) => call("setStorageLocation", input),
      status: (workspaceId) => call("status", { workspaceId }),
      storageStatus: (workspaceId) => call("storageStatus", workspaceId === null ? {} : { workspaceId }),
    });
  },
  migrate: ({ data }) => data,
});
