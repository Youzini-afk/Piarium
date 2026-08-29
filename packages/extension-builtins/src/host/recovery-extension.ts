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
      applyRestore: (input) => call("applyRestore", input),
      cancelCombinedOperation: (operationId) => call("cancelCombinedOperation", { operationId }),
      cancelOperation: (operationId) => call("cancelOperation", { operationId }),
      clearStorageLocationOverride: (workspaceId) => call("clearStorageLocationOverride", { workspaceId }),
      captureSnapshot: (input) => call("captureSnapshot", input),
      cleanupStorage: (input) => call("cleanupStorage", input),
      createCheckpoint: (input) => call("createCheckpoint", input),
      deleteWorkspaceHistory: (workspaceId) => call("deleteWorkspaceHistory", { workspaceId }),
      diffSnapshots: (input) => call("diffSnapshots", input),
      getCombinedOperation: (operationId) => call("getCombinedOperation", { operationId }),
      getStorageMove: (operationId) => call("getStorageMove", { operationId }),
      getOperation: (operationId) => call("getOperation", { operationId }),
      listSnapshots: (input) => call("listSnapshots", input),
      listCombinedOperations: (workspaceId) => call("listCombinedOperations", { workspaceId }),
      listStorageWorkspaces: () => call("listStorageWorkspaces", {}),
      readSnapshot: (input) => call("readSnapshot", input),
      prepareCombinedRecovery: (input) => call("prepareCombinedRecovery", input),
      prepareCombinedUndo: (operationId) => call("prepareCombinedUndo", { operationId }),
      prepareRestore: (input) => call("prepareRestore", input),
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
