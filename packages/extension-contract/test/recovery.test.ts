import assert from "node:assert/strict";
import test from "node:test";
import {
  PIARIUM_WORKSPACE_RECOVERY_SERVICE_ID,
  PIARIUM_WORKSPACE_RECOVERY_SERVICE_VERSION,
  WorkspaceRecoveryContractError,
  createWorkspaceRecoveryAPI,
  parseRecoveryStorageLocation,
  parseWorkspaceRecoveryCaptureResult,
  parseWorkspaceRecoveryEntryBindingResult,
  parseWorkspaceRecoveryManifestEntry,
  parseWorkspaceRecoveryReadResult,
  parseWorkspaceRecoverySnapshotSummary,
} from "../src/index.js";

const summary = (availability = "ready") => ({
  availability,
  byteLength: 5,
  consistency: availability === "incomplete" ? "incomplete" : "validated",
  coverage: { excludedUnknown: 1, issues: [], knownAbsent: 0, present: 2, unstable: 0 },
  createdAt: "2026-08-28T00:00:00.000Z",
  entryCount: 3,
  id: "snapshot-1",
  manifestHash: `sha256-${"a".repeat(64)}`,
  parentSnapshotId: null,
  policyRevision: "phase1-default-v1",
  sequence: 1,
  source: "manual",
  workspaceId: "workspace-1",
});

test("rejects unsafe manifest paths and unauthenticated content identifiers", () => {
  assert.throws(
    () => parseWorkspaceRecoveryManifestEntry({
      comparisonKey: "../escape",
      coverage: "present",
      kind: "regular-file",
      objectHash: `sha256-${"b".repeat(64)}`,
      path: "../escape",
    }),
    WorkspaceRecoveryContractError,
  );
  assert.throws(
    () => parseWorkspaceRecoverySnapshotSummary({ ...summary(), manifestHash: "not-a-content-hash" }),
    WorkspaceRecoveryContractError,
  );
});

test("owns the versioned workspace recovery service identity", () => {
  assert.equal(PIARIUM_WORKSPACE_RECOVERY_SERVICE_ID, "piarium.workspace-recovery");
  assert.equal(PIARIUM_WORKSPACE_RECOVERY_SERVICE_VERSION, 1);
  assert.equal(parseWorkspaceRecoverySnapshotSummary(summary()).availability, "ready");
});

test("parses every storage mode without accepting custom roots on another mode", () => {
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
});

test("keeps missing, malformed, incomplete, and corrupt snapshot results distinct", () => {
  assert.equal(parseWorkspaceRecoveryReadResult({
    status: "incomplete",
    manifest: { entries: [], manifestHash: summary("incomplete").manifestHash, nextCursor: null, snapshot: summary("incomplete") },
  }).status, "incomplete");
  for (const status of ["missing", "malformed", "corrupt"] as const) {
    assert.equal(parseWorkspaceRecoveryReadResult({
      failure: {
        code: status === "missing" ? "snapshot-missing" : `snapshot-${status}`,
        message: status,
        retryable: false,
      },
      snapshotId: "snapshot-1",
      status,
    }).status, status);
  }
});

test("keeps capture witnesses and entry bindings explicit", () => {
  const captured = parseWorkspaceRecoveryCaptureResult({
    reused: false,
    snapshot: summary(),
    status: "captured",
    witness: { epoch: 1, mutationRevision: 2, writerRevision: 3 },
  });
  assert.deepEqual(captured, {
    reused: false,
    snapshot: summary(),
    status: "captured",
    witness: { epoch: 1, mutationRevision: 2, writerRevision: 3 },
  });
  assert.deepEqual(parseWorkspaceRecoveryEntryBindingResult({
    reason: "entry-unbound",
    status: "unbound",
  }), {
    reason: "entry-unbound",
    status: "unbound",
  });
});

test("browser-safe API uses the generic extension service invocation contract", async () => {
  const requests: unknown[] = [];
  const api = createWorkspaceRecoveryAPI(async (request) => {
    requests.push(request);
    return {
      page: { nextCursor: null, snapshots: [summary()] },
      status: "ready",
    };
  });
  const result = await api.listSnapshots({ workspaceId: "workspace-1" });
  assert.equal(result.status, "ready");
  assert.deepEqual(requests, [{
    args: [{ workspaceId: "workspace-1" }],
    method: "listSnapshots",
    serviceId: "piarium.workspace-recovery",
    version: 1,
  }]);
});
