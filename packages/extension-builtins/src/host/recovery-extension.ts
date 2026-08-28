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
      applyRestore: (input) => call("applyRestore", input),
      cancelOperation: (operationId) => call("cancelOperation", { operationId }),
      captureSnapshot: (input) => call("captureSnapshot", input),
      cleanupStorage: (input) => call("cleanupStorage", input),
      createCheckpoint: (input) => call("createCheckpoint", input),
      deleteWorkspaceHistory: (workspaceId) => call("deleteWorkspaceHistory", { workspaceId }),
      diffSnapshots: (input) => call("diffSnapshots", input),
      getStorageMove: (operationId) => call("getStorageMove", { operationId }),
      getOperation: (operationId) => call("getOperation", { operationId }),
      listSnapshots: (input) => call("listSnapshots", input),
      readSnapshot: (input) => call("readSnapshot", input),
      prepareRestore: (input) => call("prepareRestore", input),
      recordTurnSettled: (input) => call("recordTurnSettled", input),
      recordTurnStart: (input) => call("recordTurnStart", input),
      resolveEntry: (input) => call("resolveEntry", input),
      setStorageLocation: (input) => call("setStorageLocation", input),
      status: (workspaceId) => call("status", { workspaceId }),
      storageStatus: (workspaceId) => call("storageStatus", workspaceId === null ? {} : { workspaceId }),
    });
  },
  migrate: ({ data }) => data,
});
