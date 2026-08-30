import assert from "node:assert/strict";
import test from "node:test";
import {
  PIARIUM_WORKSPACE_RECOVERY_SERVICE_ID,
  PIARIUM_WORKSPACE_RECOVERY_SERVICE_VERSION,
  WorkspaceRecoveryContractError,
  createWorkspaceRecoveryAPI,
  parseRecoveryStorageLocation,
  parseRecoveryStorageStatus,
  parseRecoveryStorageWorkspaceSummary,
  parseWorkspaceCombinedRecoveryPlan,
  parseWorkspaceRecoveryCheckpointSummary,
  parseWorkspaceRecoveryEntryBindingResult,
  parseWorkspaceRecoveryMutationAfterInput,
  parseWorkspaceRecoveryTurnBinding,
} from "../src/index.js";

const checkpoint = () => ({
  byteLength: 5,
  changedPathCount: 1,
  createdAt: "2026-08-30T00:00:00.000Z",
  entryId: "user-1",
  executionId: "execution-1",
  id: "checkpoint-1",
  sequence: 1,
  sessionId: "session-1",
  source: "turn",
  state: "ready",
  workspaceId: "workspace-1",
});

test("owns the affected-file journal service version", () => {
  assert.equal(PIARIUM_WORKSPACE_RECOVERY_SERVICE_ID, "piarium.workspace-recovery");
  assert.equal(PIARIUM_WORKSPACE_RECOVERY_SERVICE_VERSION, 3);
  assert.equal(parseWorkspaceRecoveryCheckpointSummary(checkpoint()).changedPathCount, 1);
});

test("parses every storage mode and journal-oriented storage counts", () => {
  assert.deepEqual(parseRecoveryStorageLocation({ mode: "application-data" }), { mode: "application-data" });
  assert.deepEqual(parseRecoveryStorageLocation({ mode: "workspace-local" }), { mode: "workspace-local" });
  assert.deepEqual(parseRecoveryStorageLocation({ mode: "workspace-adjacent" }), { mode: "workspace-adjacent" });
  assert.deepEqual(parseRecoveryStorageLocation({ mode: "custom", customRoot: "/recovery" }), {
    customRoot: "/recovery",
    mode: "custom",
  });
  assert.throws(
    () => parseRecoveryStorageLocation({ mode: "application-data", customRoot: "/escape" }),
    WorkspaceRecoveryContractError,
  );
  assert.equal(parseRecoveryStorageStatus({
    authorityId: "authority-1",
    byteLength: 0,
    checkpointCount: 0,
    encryption: { available: false, enabled: false },
    location: { mode: "workspace-local" },
    locationSource: "global",
    objectCount: 0,
    readyCheckpointCount: 0,
    registryRevision: 1,
    state: "missing",
  }).checkpointCount, 0);
  assert.equal(parseRecoveryStorageWorkspaceSummary({
    byteLength: 0,
    canonicalRoot: "/workspace",
    checkpointCount: 0,
    lastActivityAt: null,
    location: { mode: "application-data" },
    locationSource: "workspace",
    migrationRequired: false,
    objectCount: 0,
    state: "missing",
    storageAvailable: true,
    workspaceAvailable: true,
    workspaceId: "workspace-1",
  }).workspaceAvailable, true);
});

test("keeps mutation boundaries, turn binding coverage, and entry binding explicit", () => {
  assert.equal(parseWorkspaceRecoveryMutationAfterInput({
    executionId: "execution-1",
    mutationId: "mutation-1",
    path: "/workspace/note.txt",
    succeeded: true,
    toolCallId: "tool-1",
    toolName: "write",
    workspaceId: "workspace-1",
  }).succeeded, true);
  assert.throws(() => parseWorkspaceRecoveryMutationAfterInput({
    executionId: "execution-1",
    mutationId: "mutation-1",
    path: "/workspace/note.txt",
    toolCallId: "tool-1",
    toolName: "write",
    workspaceId: "workspace-1",
  }), WorkspaceRecoveryContractError);

  const binding = parseWorkspaceRecoveryTurnBinding({
    activeWriterScopes: [],
    checkpointId: "checkpoint-1",
    executionId: "execution-1",
    provenance: "caused-by",
    runtimeGeneration: 1,
    runtimeKey: "worker-1@1",
    sessionId: "session-1",
    startedAt: "2026-08-30T00:00:00.000Z",
    status: "ready",
    unrecordedResourceIds: [],
    userEntryId: "user-1",
    workerId: "worker-1",
    workspaceId: "workspace-1",
  });
  assert.equal(binding.checkpointId, "checkpoint-1");
  assert.deepEqual(parseWorkspaceRecoveryEntryBindingResult({
    reason: "checkpoint-incomplete",
    status: "incomplete",
  }), {
    reason: "checkpoint-incomplete",
    status: "incomplete",
  });
});

test("plans only affected paths and keeps conflict handling explicit", () => {
  const plan = parseWorkspaceCombinedRecoveryPlan({
    affectedPaths: ["src/a.ts"],
    changedBytes: 12,
    conflicts: [{ kind: "content-changed", message: "changed", path: "src/a.ts" }],
    coverage: "ready",
    createdAt: "2026-08-30T00:00:00.000Z",
    entryId: "user-1",
    expectedLeafId: "leaf-2",
    id: "operation-1",
    removedEntryIds: ["user-1", "assistant-1"],
    revision: `sha256-${"a".repeat(64)}`,
    sessionId: "session-1",
    targetLeafId: "leaf-1",
    workspaceId: "workspace-1",
  });
  assert.deepEqual(plan.affectedPaths, ["src/a.ts"]);
  assert.equal(plan.conflicts[0]?.kind, "content-changed");
});

test("browser-safe API invokes only the v3 checkpoint method", async () => {
  const requests: unknown[] = [];
  const api = createWorkspaceRecoveryAPI(async (request) => {
    requests.push(request);
    return { page: { checkpoints: [checkpoint()], nextCursor: null }, status: "ready" };
  });
  const result = await api.listCheckpoints({ workspaceId: "workspace-1" });
  assert.equal(result.status, "ready");
  assert.deepEqual(requests, [{
    args: [{ workspaceId: "workspace-1" }],
    method: "listCheckpoints",
    serviceId: "piarium.workspace-recovery",
    version: 3,
  }]);
});
