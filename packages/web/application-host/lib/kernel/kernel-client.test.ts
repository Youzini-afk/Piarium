import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createKernelClient, KernelClient } from "./kernel-client.js";

const extension = process.platform === "win32" ? ".exe" : "";
const kernelPath = path.resolve(process.cwd(), "kernel", "target", "release", `piarium-kernel${extension}`);
const clients: KernelClient[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

test("real Rust kernel persists roots, CAS revisions, pins, and objects", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-test-"));
  roots.push(root);
  const client = createKernelClient({
    hostId: "kernel-test-host",
    storageRoot: root,
    buildVersion: "test",
    kernelPath,
    allowCargoDevRunner: false,
  });
  clients.push(client);
  const handshake = await client.start();
  assert.equal(handshake.protocolVersion, 1);
  const first = await client.putBlob(Buffer.from("one\n"), "op-blob-one");
  const large = await client.putBlob(Buffer.alloc(200_000, 7), "op-blob-large");
  assert.equal(large.byteLength, 200_000);
  const created = await client.createBranch({
    operationId: "op-create",
    branchId: "branch-test",
    workspaceId: "workspace-test",
    entries: [{ path: "src/file.txt", state: { kind: "regular-file", byteLength: first.byteLength, objectHash: first.hash, mode: 0o644 } }],
  });
  const initial = await client.readBranch({ branchId: "branch-test", includeEntries: true });
  assert.equal(initial.entries.length, 1);
  assert.equal(initial.entries[0]?.path, "src/file.txt");
  const normalized = await client.readBranch({ branchId: "branch-test", paths: ["src\\file.txt"] });
  assert.equal(normalized.entries[0]?.path, "src/file.txt");
  await assert.rejects(client.request("storage.health", { deep: false, unexpected: true }), /unknown.*field/i);
  await assert.rejects(client.createBranch({ operationId: "op-create-different", branchId: "branch-test", workspaceId: "workspace-test", entries: [] }), /creation parameters/i);
  assert.equal((await client.health({ deep: true })).integrity, "ok");
  await assert.rejects(
    client.createBranch({
      operationId: "op-invalid-state",
      branchId: "invalid-state",
      workspaceId: "workspace-test",
      entries: [{ path: "a", state: { kind: "regular-file", byteLength: first.byteLength, objectHash: first.hash } }],
    }),
    /invalid path state|mode/i,
  );
  await assert.rejects(
    client.createBranch({
      operationId: "op-invalid-tree",
      branchId: "invalid-tree",
      workspaceId: "workspace-test",
      entries: [
        { path: "a", state: { kind: "regular-file", byteLength: first.byteLength, objectHash: first.hash, mode: 0o644 } },
        { path: "a/b", state: { kind: "directory", mode: 0o755 } },
      ],
    }),
    /non-directory|descendant/i,
  );
  await client.createBranch({
    operationId: "op-tree-invariant",
    branchId: "tree-invariant",
    workspaceId: "workspace-test",
    entries: [
      { path: "a", state: { kind: "directory", mode: 0o755 } },
      { path: "a/b", state: { kind: "regular-file", byteLength: first.byteLength, objectHash: first.hash, mode: 0o644 } },
    ],
  });
  await client.writeBranch({
    operationId: "op-tree-replace",
    branchId: "tree-invariant",
    expectedWriteRevision: 0,
    changes: [{ path: "a", state: { kind: "regular-file", byteLength: first.byteLength, objectHash: first.hash, mode: 0o755 } }],
  });
  const replaced = await client.readBranch({ branchId: "tree-invariant", includeEntries: true });
  assert.deepEqual(replaced.entries.map((entry) => entry.path), ["a"]);
  await assert.rejects(
    client.writeBranch({
      operationId: "op-tree-invalid-descendant",
      branchId: "tree-invariant",
      expectedWriteRevision: 1,
      changes: [{ path: "a/b", state: { kind: "missing" } }],
    }),
    /non-directory|descendant/i,
  );
  await client.deleteBranch({ operationId: "op-tree-delete", branchId: "tree-invariant" });
  const second = await client.putBlob(Buffer.from("two\n"), "op-blob-two");
  const committed = await client.writeBranch({
    operationId: "op-write",
    branchId: "branch-test",
    expectedWriteRevision: 0,
    changes: [{ path: "src/file.txt", state: { kind: "regular-file", byteLength: second.byteLength, objectHash: second.hash, mode: 0o755 } }],
  });
  assert.equal(committed.status, "committed");
  const conflict = await client.writeBranch({
    operationId: "op-write-stale",
    branchId: "branch-test",
    expectedWriteRevision: 0,
    changes: [{ path: "src/other.txt", state: { kind: "directory" } }],
  });
  assert.equal(conflict.status, "conflict");
  const published = await client.publishBranch({ operationId: "op-publish", branchId: "branch-test" });
  const pin = await client.pinBranch({ operationId: "op-pin", branchId: "branch-test", revision: Number(published.revision) });
  assert.equal(pin.pinned, true);
  const operation = await client.getOperation("op-publish");
  assert.equal(operation?.state, "committed");
  const snapshot = await client.snapshot("workspace-test");
  assert.equal((snapshot.branches as unknown[]).length, 1);
  const third = await client.putBlob(Buffer.from("three\n"), "op-blob-three");
  const afterPublishWrite = await client.writeBranch({
    operationId: "op-write-after-publish",
    branchId: "branch-test",
    expectedWriteRevision: 1,
    changes: [{ path: "src/file.txt", state: { kind: "regular-file", byteLength: third.byteLength, objectHash: third.hash, mode: 0o644 } }],
  });
  assert.equal(afterPublishWrite.status, "committed");
  const fixed = await client.readBranch({ branchId: "branch-test", revision: Number(published.revision), includeEntries: true });
  const changed = await client.readBranch({ branchId: "branch-test", includeEntries: true });
  assert.equal(fixed.entries[0]?.state.objectHash, second.hash);
  assert.equal(changed.entries[0]?.state.objectHash, third.hash);
  assert.equal(changed.entries[0]?.state.mode, 0o644);
  const diff = await client.diffRoots({ leftRoot: String(created.root), rightRoot: changed.root });
  assert.deepEqual(diff.changed, ["src/file.txt"]);
  assert.equal((await client.health()).integrity, "ok");
  await client.close();
  const reopened = createKernelClient({ hostId: "kernel-test-host", storageRoot: root, buildVersion: "test", kernelPath, allowCargoDevRunner: false });
  clients.push(reopened);
  await reopened.start();
  const afterRestart = await reopened.readBranch({ branchId: "branch-test", includeEntries: true });
  const fixedAfterRestart = await reopened.readBranch({ branchId: "branch-test", revision: Number(published.revision), includeEntries: true });
  assert.equal(afterRestart.entries[0]?.state.objectHash, third.hash);
  assert.equal(fixedAfterRestart.entries[0]?.state.objectHash, second.hash);
  const deleted = await reopened.deleteBranch({ operationId: "op-delete", branchId: "branch-test" });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.retainedPins, 1);
  const retained = await reopened.readPin({ pinId: String(pin.pinId), includeEntries: true });
  assert.equal((retained.entries as unknown[]).length, 1);
  assert.equal(((await reopened.snapshot("workspace-test")).branches as unknown[]).length, 0);
  await reopened.gc("op-gc-with-pin");
  assert.equal((await reopened.readPin({ pinId: String(pin.pinId), includeEntries: true })).entries instanceof Array, true);
  const released = await reopened.unpinBranch({ operationId: "op-unpin-after-delete", branchId: "branch-test", pinId: String(pin.pinId) });
  assert.equal(released.released, true);
  await reopened.gc("op-gc-after-unpin");
  await assert.rejects(reopened.readPin({ pinId: String(pin.pinId) }), /pin not found/i);
});

test("operation finish failure rolls back the durable mutation and permits retry", async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-operation-"));
  roots.push(root);
  const faulted = createKernelClient({
    hostId: "operation-fault-host",
    storageRoot: root,
    buildVersion: "test",
    kernelPath,
    allowCargoDevRunner: false,
    env: { PIARIUM_KERNEL_FAIL_OPERATION_FINISH: "1" },
  });
  clients.push(faulted);
  await faulted.start();
  await assert.rejects(faulted.putBlob(Buffer.from("retry-me"), "retry-operation"), /injected operation finish failure|storage error/i);
  await faulted.close();
  const retried = createKernelClient({ hostId: "operation-fault-host", storageRoot: root, buildVersion: "test", kernelPath, allowCargoDevRunner: false });
  clients.push(retried);
  await retried.start();
  const result = await retried.putBlob(Buffer.from("retry-me"), "retry-operation");
  assert.equal(result.byteLength, 8);
  assert.equal((await retried.getOperation("retry-operation"))?.state, "committed");
  const recoveryBegin = await retried.request<Record<string, unknown>>("recovery.operation.begin", {
    operationId: "recovery-multi-stage",
    recordId: "recovery-record",
    workspaceId: "recovery-workspace",
    state: "started",
    data: { before: "before-state" },
  });
  assert.equal(recoveryBegin.state, "started");
  const recoveryUpdate = await retried.request<Record<string, unknown>>("recovery.operation.update", {
    operationId: "recovery-multi-stage",
    recordId: "recovery-record",
    workspaceId: "recovery-workspace",
    state: "complete",
    data: { target: "after-state" },
  });
  assert.equal(recoveryUpdate.state, "complete");
  const recovery = await retried.request<Record<string, unknown>>("recovery.operation.get", { recordId: "recovery-record" });
  assert.deepEqual(recovery?.initialData, { before: "before-state" });
});

test("GC distinguishes durable release from physical cleanup failure and retries after restart", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-gc-"));
  roots.push(root);
  const faulted = createKernelClient({
    hostId: "gc-fault-host",
    storageRoot: root,
    buildVersion: "test",
    kernelPath,
    allowCargoDevRunner: false,
    env: { PIARIUM_KERNEL_FAIL_GC_DELETE: "1" },
  });
  clients.push(faulted);
  await faulted.start();
  const blob = await faulted.putBlob(Buffer.from("gc-body"), "gc-blob");
  await faulted.createBranch({
    operationId: "gc-create",
    branchId: "gc-branch",
    workspaceId: "gc-workspace",
    entries: [{ path: "file", state: { kind: "regular-file", byteLength: blob.byteLength, objectHash: blob.hash, mode: 0o644 } }],
  });
  await faulted.deleteBranch({ operationId: "gc-delete", branchId: "gc-branch" });
  const failed = await faulted.gc("gc-run");
  assert.equal(failed.releasedBlobs, 1);
  assert.equal(failed.deletedBlobs, 0);
  assert.equal((failed.cleanupFailures as string[]).length, 1);
  assert.equal((await faulted.health({ deep: true })).integrity, "degraded");
  await faulted.close();

  const recovered = createKernelClient({ hostId: "gc-fault-host", storageRoot: root, buildVersion: "test", kernelPath, allowCargoDevRunner: false });
  clients.push(recovered);
  await recovered.start();
  const health = await recovered.health({ deep: true });
  assert.equal(health.integrity, "ok");
  assert.equal(health.pendingCleanup, 0);
});

test("grant workspace/path scope and revocation are enforced by Rust", async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-grant-"));
  roots.push(root);
  const client = createKernelClient({ hostId: "grant-host", hostGeneration: "grant-generation", storageRoot: root, buildVersion: "test", kernelPath, allowCargoDevRunner: false });
  clients.push(client);
  await client.start();
  const blob = await client.putBlob(Buffer.from("grant"), "grant-blob");
  await client.issueGrant({
    grantId: "scoped-grant",
    hostGeneration: "grant-generation",
    sessionId: null,
    threadId: null,
    runId: null,
    owningWorkspace: "workspace-a",
    executionWorkspace: "workspace-a",
    storageIdentity: client.handshake?.storageRoot,
    capabilities: ["storage.read", "storage.write"],
    pathScopes: ["src"],
  });
  await client.createBranch({
    operationId: "grant-branch-ok",
    branchId: "grant-branch",
    workspaceId: "workspace-a",
    entries: [{ path: "src/file.txt", state: { kind: "regular-file", byteLength: blob.byteLength, objectHash: blob.hash, mode: 0o644 } }],
  });
  await assert.rejects(client.createBranch({ operationId: "grant-branch-other", branchId: "grant-other", workspaceId: "workspace-b", entries: [] }), /workspace|grant/i);
  await assert.rejects(client.writeBranch({ operationId: "grant-path-other", branchId: "grant-branch", expectedWriteRevision: 0, changes: [{ path: "private.txt", state: { kind: "missing" } }] }), /scope|path|grant/i);
  await client.revokeGrant("scoped-grant");
  await assert.rejects(client.health(), /revoked|grant/i);
});

test("queued long branch build observes cancellation and leaves the kernel usable", async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-cancel-"));
  roots.push(root);
  const client = createKernelClient({ hostId: "cancel-host", storageRoot: root, buildVersion: "test", kernelPath, allowCargoDevRunner: false });
  clients.push(client);
  await client.start();
  const blob = await client.putBlob(Buffer.from("cancel"), "cancel-blob");
  const entries = Array.from({ length: 8_000 }, (_, index) => ({
    path: `wide/${String(index).padStart(6, "0")}.txt`,
    state: { kind: "regular-file", byteLength: blob.byteLength, objectHash: blob.hash, mode: 0o644 },
  }));
  const controller = new AbortController();
  const pending = client.createBranch({ operationId: "cancel-build", branchId: "cancel-branch", workspaceId: "cancel-workspace", entries }, controller.signal);
  setTimeout(() => controller.abort(), 0);
  await pending.then(() => assert.fail("cancelled branch build unexpectedly committed"), (error: unknown) => assert.match(String(error), /cancelled/i));
  assert.equal((await client.health()).integrity, "ok");
});
