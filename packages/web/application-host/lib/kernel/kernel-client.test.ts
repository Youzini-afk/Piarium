import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createKernelClient, KernelClient } from "./kernel-client.js";
import type { KernelGrantHandle } from "./kernel-client.js";
import { KernelStorageAdapter } from "./storage-adapter.js";
import { KernelRecoveryCatalogBackend, KernelRecoveryContentStore } from "./kernel-recovery-catalog.js";
import { createWorkspaceRecoveryEngine } from "../recovery/journal-engine.js";

const extension = process.platform === "win32" ? ".exe" : "";
const kernelPath = path.resolve(process.cwd(), "kernel", "target", "release", `piarium-kernel${extension}`);
const buildVersion = JSON.parse(await fs.readFile(path.resolve(process.cwd(), "package.json"), "utf8")).version as string;
const clients: KernelClient[] = [];
const roots: string[] = [];

const issueActor = async (client: KernelClient, grantId: string, workspaceId: string | null, pathScopes: string[] = [""]): Promise<KernelGrantHandle> => client.issueGrant({
  grantId,
  hostGeneration: client.handshake?.hostGeneration,
  sessionId: null,
  threadId: null,
  runId: null,
  owningWorkspace: workspaceId,
  executionWorkspace: workspaceId,
  storageIdentity: client.handshake?.storageRoot,
  capabilities: ["storage.read", "storage.write", "recovery", "storage.gc"],
  pathScopes,
});

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
  const host = createKernelClient({
    hostId: "kernel-test-host",
    storageRoot: root,
    buildVersion,
    kernelPath,
    allowCargoDevRunner: false,
  });
  clients.push(host);
  const handshake = await host.start();
  const client = host.scoped(await issueActor(host, "kernel-test-actor", "workspace-test"));
  assert.equal(handshake.protocolVersion, 1);
  const first = await client.putBlob(Buffer.from("one\n"), "op-blob-one");
  const large = await client.putBlob(Buffer.alloc(200_000, 7), "op-blob-large");
  assert.equal(large.byteLength, 200_000);
  assert.equal((await client.releaseBlob(large.ownerId)).released, true);
  const created = await client.createBranch({
    operationId: "op-create",
    branchId: "branch-test",
    workspaceId: "workspace-test",
    entries: [{ path: "src/file.txt", state: { kind: "regular-file", byteLength: first.byteLength, objectHash: first.hash, mode: 0o644 }, ownerId: first.ownerId }],
  });
  const forked = await client.createBranch({
    operationId: "op-fork",
    branchId: "branch-fork",
    workspaceId: "workspace-test",
    entries: [],
    baseRef: String(created.root),
  });
  assert.equal(forked.root, created.root);
  const initial = await client.readBranch({ branchId: "branch-test", includeEntries: true });
  assert.equal(initial.entries.length, 1);
  assert.equal(initial.entries[0]?.path, "src/file.txt");
  const normalized = await client.readBranch({ branchId: "branch-test", paths: ["src\\file.txt"] });
  assert.equal(normalized.entries[0]?.path, "src/file.txt");
  assert.equal((await client.health({ deep: false })).integrity, "ok");
  await assert.rejects(
    client.createBranch({ operationId: "op-create", branchId: "operation-reuse", workspaceId: "workspace-test", entries: [] }),
    /operationId.*reused|different parameters/i,
  );
  await assert.rejects(client.createBranch({ operationId: "op-create-different", branchId: "branch-test", workspaceId: "workspace-test", entries: [] }), /creation parameters/i);
  assert.equal((await client.health({ deep: true })).integrity, "ok");
  await assert.rejects(
    client.createBranch({
      operationId: "op-invalid-state",
      branchId: "invalid-state",
      workspaceId: "workspace-test",
      entries: [{ path: "a", state: { kind: "regular-file", byteLength: first.byteLength, objectHash: first.hash } } as never],
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
  const treeBlob = await client.putBlob(Buffer.from("tree\n"), "op-tree-blob");
  await client.createBranch({
    operationId: "op-tree-invariant",
    branchId: "tree-invariant",
    workspaceId: "workspace-test",
    entries: [
      { path: "a", state: { kind: "directory", mode: 0o755 } },
      { path: "a/b", state: { kind: "regular-file", byteLength: treeBlob.byteLength, objectHash: treeBlob.hash, mode: 0o644 }, ownerId: treeBlob.ownerId },
    ],
  });
  await client.writeBranch({
    operationId: "op-tree-replace",
    branchId: "tree-invariant",
    expectedWriteRevision: 0,
    changes: [{ path: "a", state: { kind: "regular-file", byteLength: treeBlob.byteLength, objectHash: treeBlob.hash, mode: 0o755 }, sourcePath: "a/b" }],
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
    changes: [{ path: "src/file.txt", state: { kind: "regular-file", byteLength: second.byteLength, objectHash: second.hash, mode: 0o755 }, ownerId: second.ownerId }],
  });
  assert.equal(committed.status, "committed");
  await assert.rejects(
    client.writeBranch({
      operationId: "op-write",
      branchId: "branch-test",
      expectedWriteRevision: 1,
      changes: [{ path: "src/reused.txt", state: { kind: "directory" } }],
    }),
    /operationId.*reused|different parameters/i,
  );
  const conflict = await client.writeBranch({
    operationId: "op-write-stale",
    branchId: "branch-test",
    expectedWriteRevision: 0,
    changes: [{ path: "src/other.txt", state: { kind: "directory" } }],
  });
  assert.equal(conflict.status, "conflict");
  const stalePublish = await client.publishBranch({
    operationId: "op-publish-stale",
    branchId: "branch-test",
    expectedWriteRevision: 0,
    expectedRoot: String(created.root),
  });
  assert.equal(stalePublish.status, "conflict");
  const published = await client.publishBranch({ operationId: "op-publish", branchId: "branch-test", expectedWriteRevision: committed.writeRevision, expectedRoot: committed.root });
  const pin = await client.pinBranch({ operationId: "op-pin", branchId: "branch-test", revision: Number(published.revision) });
  assert.equal(pin.pinned, true);
  const operation = await client.getOperation("op-publish");
  assert.equal(operation?.state, "committed");
  const snapshot = await client.snapshot("workspace-test");
  assert.equal((snapshot.branches as unknown[]).length, 2);
  const third = await client.putBlob(Buffer.from("three\n"), "op-blob-three");
  const afterPublishWrite = await client.writeBranch({
    operationId: "op-write-after-publish",
    branchId: "branch-test",
    expectedWriteRevision: 1,
    changes: [{ path: "src/file.txt", state: { kind: "regular-file", byteLength: third.byteLength, objectHash: third.hash, mode: 0o644 }, ownerId: third.ownerId }],
  });
  assert.equal(afterPublishWrite.status, "committed");
  const fixed = await client.readBranch({ branchId: "branch-test", revision: Number(published.revision), includeEntries: true });
  const changed = await client.readBranch({ branchId: "branch-test", includeEntries: true });
  assert.equal((fixed.entries[0]?.state as { objectHash?: string }).objectHash, second.hash);
  assert.equal((changed.entries[0]?.state as { objectHash?: string }).objectHash, third.hash);
  assert.equal((changed.entries[0]?.state as { mode?: number }).mode, 0o644);
  assert.equal((await client.health({ deep: true })).integrity, "ok");
  const diff = await client.diffRoots({ leftRoot: String(created.root), rightRoot: changed.root });
  assert.deepEqual(diff.changed, ["src/file.txt"]);
  assert.equal((await client.health()).integrity, "ok");
  await client.close();
  const reopenedHost = createKernelClient({ hostId: "kernel-test-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(reopenedHost);
  await reopenedHost.start();
  const reopened = reopenedHost.scoped(await issueActor(reopenedHost, "kernel-test-actor", "workspace-test"));
  const maintenance = reopenedHost.scoped(await issueActor(reopenedHost, "kernel-test-maintenance", null));
  const afterRestart = await reopened.readBranch({ branchId: "branch-test", includeEntries: true });
  const fixedAfterRestart = await reopened.readBranch({ branchId: "branch-test", revision: Number(published.revision), includeEntries: true });
  assert.equal((afterRestart.entries[0]?.state as { objectHash?: string }).objectHash, third.hash);
  assert.equal((fixedAfterRestart.entries[0]?.state as { objectHash?: string }).objectHash, second.hash);
  const deleted = await reopened.deleteBranch({ operationId: "op-delete", branchId: "branch-test" });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.retainedPins, 1);
  await reopened.deleteBranch({ operationId: "op-fork-delete", branchId: "branch-fork" });
  const retained = await reopened.readPin({ pinId: String(pin.pinId), includeEntries: true });
  assert.equal((retained.entries as unknown[]).length, 1);
  assert.equal(((await reopened.snapshot("workspace-test")).branches as unknown[]).length, 0);
  await maintenance.gc("op-gc-with-pin");
  assert.equal((await reopened.readPin({ pinId: String(pin.pinId), includeEntries: true })).entries instanceof Array, true);
  const released = await reopened.unpinBranch({ operationId: "op-unpin-after-delete", branchId: "branch-test", pinId: String(pin.pinId) });
  assert.equal(released.released, true);
  await maintenance.gc("op-gc-after-unpin");
  await assert.rejects(reopened.readPin({ pinId: String(pin.pinId) }), /pin not found/i);
});

test("operation finish failure rolls back the durable mutation and permits retry", async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-operation-"));
  roots.push(root);
  const faultedHost = createKernelClient({
    hostId: "operation-fault-host",
    storageRoot: root,
    buildVersion,
    kernelPath,
    allowCargoDevRunner: false,
    env: { PIARIUM_KERNEL_FAIL_OPERATION_FINISH: "1" },
  });
  clients.push(faultedHost);
  await faultedHost.start();
  const faulted = faultedHost.scoped(await issueActor(faultedHost, "operation-fault-actor", "recovery-workspace"));
  await assert.rejects(faulted.putBlob(Buffer.from("retry-me"), "retry-operation"), /injected operation finish failure|storage error/i);
  await faulted.close();
  const retriedHost = createKernelClient({ hostId: "operation-fault-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(retriedHost);
  await retriedHost.start();
  const retried = retriedHost.scoped(await issueActor(retriedHost, "operation-fault-actor", "recovery-workspace"));
  const result = await retried.putBlob(Buffer.from("retry-me"), "retry-operation");
  assert.equal(result.byteLength, 8);
  assert.equal((await retried.getOperation("retry-operation"))?.state, "committed");
  const recoveryBegin = await retried.beginRecovery({
    operationId: "recovery-multi-stage",
    recordId: "recovery-record",
    workspaceId: "recovery-workspace",
    state: "started",
    data: JSON.stringify({ before: "before-state" }),
  });
  assert.equal(recoveryBegin.state, "started");
  const recoveryUpdate = await retried.updateRecovery({
    operationId: "recovery-multi-stage",
    recordId: "recovery-record",
    workspaceId: "recovery-workspace",
    state: "complete",
    data: JSON.stringify({ target: "after-state" }),
  });
  assert.equal(recoveryUpdate.state, "complete");
  const recovery = await retried.getRecovery({ recordId: "recovery-record" });
  assert.deepEqual(recovery?.initialData, { before: "before-state" });
});

test("GC distinguishes durable release from physical cleanup failure and retries after restart", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-gc-"));
  roots.push(root);
  const faultedHost = createKernelClient({
    hostId: "gc-fault-host",
    storageRoot: root,
    buildVersion,
    kernelPath,
    allowCargoDevRunner: false,
    env: { PIARIUM_KERNEL_FAIL_GC_DELETE: "1" },
  });
  clients.push(faultedHost);
  await faultedHost.start();
  const faulted = faultedHost.scoped(await issueActor(faultedHost, "gc-fault-actor", "gc-workspace"));
  const faultedMaintenance = faultedHost.scoped(await issueActor(faultedHost, "gc-fault-maintenance", null));
  const blob = await faulted.putBlob(Buffer.from("gc-body"), "gc-blob");
  await faulted.createBranch({
    operationId: "gc-create",
    branchId: "gc-branch",
    workspaceId: "gc-workspace",
    entries: [{ path: "file", state: { kind: "regular-file", byteLength: blob.byteLength, objectHash: blob.hash, mode: 0o644 }, ownerId: blob.ownerId }],
  });
  await faulted.deleteBranch({ operationId: "gc-delete", branchId: "gc-branch" });
  const failed = await faultedMaintenance.gc("gc-run");
  assert.equal(failed.releasedBlobs, 1);
  assert.equal(failed.deletedBlobs, 0);
  assert.equal((failed.cleanupFailures as string[]).length, 1);
  assert.equal((await faulted.health({ deep: true })).integrity, "degraded");
  await faulted.close();

  const recoveredHost = createKernelClient({ hostId: "gc-fault-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(recoveredHost);
  await recoveredHost.start();
  const recovered = recoveredHost.scoped(await issueActor(recoveredHost, "gc-fault-actor", "gc-workspace"));
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
  const host = createKernelClient({ hostId: "grant-host", hostGeneration: "grant-generation", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  const ownerGrant = await host.issueGrant({
    grantId: "workspace-a-owner",
    hostGeneration: "grant-generation",
    sessionId: null,
    threadId: null,
    runId: null,
    owningWorkspace: "workspace-a",
    executionWorkspace: "workspace-a",
    storageIdentity: host.handshake?.storageRoot,
    capabilities: ["storage.read", "storage.write"],
    pathScopes: [""],
  });
  const owner = host.scoped(ownerGrant);
  const publicBlob = await owner.putBlob(Buffer.from("PUBLIC"), "grant-public-blob");
  const privateBlob = await owner.putBlob(Buffer.from("SECRET"), "grant-private-blob");
  await owner.createBranch({
    operationId: "grant-branch-ok",
    branchId: "grant-branch",
    workspaceId: "workspace-a",
    entries: [
      { path: "src/public/a.txt", state: { kind: "regular-file", byteLength: publicBlob.byteLength, objectHash: publicBlob.hash, mode: 0o644 }, ownerId: publicBlob.ownerId },
      { path: "src/private/secret.txt", state: { kind: "regular-file", byteLength: privateBlob.byteLength, objectHash: privateBlob.hash, mode: 0o644 }, ownerId: privateBlob.ownerId },
    ],
  });
  const client = host.scoped(await host.issueGrant({
    grantId: "scoped-grant",
    hostGeneration: "grant-generation",
    sessionId: null,
    threadId: null,
    runId: null,
    owningWorkspace: "workspace-a",
    executionWorkspace: "workspace-a",
    storageIdentity: host.handshake?.storageRoot,
    capabilities: ["storage.read", "storage.write"],
    pathScopes: ["src/public"],
  }));
  await assert.rejects(client.createBranch({ operationId: "grant-branch-other", branchId: "grant-other", workspaceId: "workspace-b", entries: [] }), /workspace|grant/i);
  const scopedRead = await client.readBranch({ branchId: "grant-branch", includeEntries: true });
  assert.deepEqual(scopedRead.entries.map((entry) => entry.path), ["src/public/a.txt"]);
  const publicSlice = await client.getBlob(publicBlob.hash, { branchId: "grant-branch", path: "src/public/a.txt" });
  assert.equal(Buffer.from(publicSlice.bytesBase64, "base64").toString("utf8"), "PUBLIC");
  await assert.rejects(
    client.getBlob(privateBlob.hash, { branchId: "grant-branch", path: "src/private/secret.txt" }),
    /scope|path|grant/i,
  );
  await assert.rejects(
    client.getBlob(privateBlob.hash, { branchId: "grant-branch", path: "src/public/a.txt" }),
    /bound|source|path/i,
  );
  await assert.rejects(
    client.writeBranch({
      operationId: "grant-copy-private-by-hash",
      branchId: "grant-branch",
      expectedWriteRevision: 0,
      changes: [{ path: "src/public/leak.txt", state: { kind: "regular-file", objectHash: privateBlob.hash, byteLength: privateBlob.byteLength, mode: 0o644 } }],
    }),
    /source path|bound|scope|grant/i,
  );
  await assert.rejects(
    client.writeBranch({
      operationId: "grant-copy-private-by-source",
      branchId: "grant-branch",
      expectedWriteRevision: 0,
      changes: [{ path: "src/public/leak.txt", sourcePath: "src/private/secret.txt", state: { kind: "regular-file", objectHash: privateBlob.hash, byteLength: privateBlob.byteLength, mode: 0o644 } }],
    }),
    /source path|scope|grant/i,
  );
  await assert.rejects(client.readBranch({ branchId: "grant-branch", paths: ["src/private/secret.txt"] }), /scope|path|grant/i);
  const ownerWrite = await owner.writeBranch({
    operationId: "grant-private-write",
    branchId: "grant-branch",
    expectedWriteRevision: 0,
    changes: [{ path: "src/private/secret.txt", state: { kind: "missing" } }],
  });
  const scopedDiff = await client.diffRoots({ leftRoot: String(scopedRead.root), rightRoot: String(ownerWrite.root) });
  assert.deepEqual(scopedDiff.changed, []);
  assert.deepEqual(scopedDiff.removed, []);
  const published = await owner.publishBranch({ operationId: "grant-publish", branchId: "grant-branch", expectedWriteRevision: ownerWrite.writeRevision, expectedRoot: ownerWrite.root });
  const pin = await owner.pinBranch({ operationId: "grant-pin", branchId: "grant-branch", revision: Number(published.revision), pinId: "grant-pin" });
  const scopedPin = await client.readPin({ pinId: String(pin.pinId), includeEntries: true });
  assert.deepEqual((scopedPin.entries as Array<{ path: string }>).map((entry) => entry.path), ["src/public/a.txt"]);
  const other = host.scoped(await issueActor(host, "workspace-b-actor", "workspace-b"));
  await assert.rejects(
    other.getBlob(publicBlob.hash, { branchId: "grant-branch", path: "src/public/a.txt" }),
    /owned|grant|workspace/i,
  );
  await host.revokeGrant("scoped-grant");
  await assert.rejects(client.readBranch({ branchId: "grant-branch", includeEntries: true }), /revoked|grant/i);
});

test("queued long branch build observes cancellation and leaves the kernel usable", async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-cancel-"));
  roots.push(root);
  const host = createKernelClient({ hostId: "cancel-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  const client = host.scoped(await issueActor(host, "cancel-actor", "cancel-workspace"));
  const blob = await client.putBlob(Buffer.from("cancel"), "cancel-blob");
  const entries = Array.from({ length: 8_000 }, (_, index) => ({
    path: `wide/${String(index).padStart(6, "0")}.txt`,
    state: { kind: "regular-file" as const, byteLength: blob.byteLength, objectHash: blob.hash, mode: 0o644 },
  }));
  const controller = new AbortController();
  const request = client.createBranch({ operationId: "cancel-build", branchId: "cancel-branch", workspaceId: "cancel-workspace", entries }, controller.signal);
  void request.catch(() => undefined);
  const pending = request.then(
    () => assert.fail("cancelled branch build unexpectedly committed"),
    (error: unknown) => assert.match(String(error), /cancelled/i),
  );
  setTimeout(() => controller.abort(), 0);
  await pending;
  assert.equal((await client.health()).integrity, "ok");
  assert.equal((await client.releaseBlob(blob.ownerId)).released, true);
});

test("grant revoke cancels queued side effects before admission", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-revoke-"));
  roots.push(root);
  const host = createKernelClient({ hostId: "revoke-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  const actor = host.scoped(await issueActor(host, "revoke-actor", "revoke-workspace"));
  const blob = await actor.putBlob(Buffer.from("revoke"), "revoke-blob");
  await actor.createBranch({ operationId: "revoke-base", branchId: "revoke-base", workspaceId: "revoke-workspace", entries: [] });
  const entries = Array.from({ length: 20_000 }, (_, index) => ({
    path: `wide/${String(index).padStart(6, "0")}.txt`,
    state: { kind: "regular-file" as const, byteLength: blob.byteLength, objectHash: blob.hash, mode: 0o644 },
  }));
  const long = actor.createBranch({ operationId: "revoke-long", branchId: "revoke-long", workspaceId: "revoke-workspace", entries });
  const queued = actor.writeBranch({ operationId: "revoke-queued", branchId: "revoke-base", expectedWriteRevision: 0, changes: [{ path: "queued.txt", state: { kind: "missing" } }] });
  const revoke = host.revokeGrant("revoke-actor");
  const [longResult, queuedResult, revokeResult] = await Promise.allSettled([long, queued, revoke]);
  assert.equal(revokeResult.status, "fulfilled");
  assert.equal(longResult.status, "rejected");
  assert.equal(queuedResult.status, "rejected");
  const verifier = host.scoped(await issueActor(host, "revoke-verifier", "revoke-workspace"));
  const base = await verifier.readBranch({ branchId: "revoke-base", includeEntries: true });
  assert.equal(base.writeRevision, 0);
  assert.deepEqual(base.entries, []);
});

test("temporary blob owners are independent and have explicit release", async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-owner-"));
  roots.push(root);
  const host = createKernelClient({ hostId: "owner-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  const client = host.scoped(await issueActor(host, "owner-actor", "owner-workspace"));
  const first = await client.putBlob(Buffer.from("same-content"), "owner-put-first");
  const second = await client.putBlob(Buffer.from("same-content"), "owner-put-second");
  assert.notEqual(first.ownerId, second.ownerId);
  const beforeAttach = await client.getBlob(second.hash, { ownerId: second.ownerId });
  assert.equal(Buffer.from(beforeAttach.bytesBase64, "base64").toString("utf8"), "same-content");
  await client.createBranch({
    operationId: "owner-create",
    branchId: "owner-branch",
    workspaceId: "owner-workspace",
    entries: [{
      path: "file.txt",
      state: { kind: "regular-file", objectHash: first.hash, byteLength: first.byteLength, mode: 0o644 },
      ownerId: first.ownerId,
    }],
  });
  assert.equal((await client.releaseBlob(first.ownerId)).released, false);
  assert.equal((await client.health()).temporaryObjectOwners, 1);
  await client.deleteBranch({ operationId: "owner-delete", branchId: "owner-branch" });
  await client.gc("owner-gc-retained");
  assert.equal(Buffer.from((await client.getBlob(second.hash, { ownerId: second.ownerId })).bytesBase64, "base64").toString("utf8"), "same-content");
  assert.equal((await client.releaseBlob(second.ownerId)).released, true);
  assert.equal((await client.releaseOperation("owner-put-second")).released, true);
  await client.gc("owner-gc-released");
  await assert.rejects(client.getBlob(second.hash, { ownerId: second.ownerId }), /owner|owned|grant/i);
});

test("typed durable records own references and page fixed roots", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-records-"));
  roots.push(root);
  const host = createKernelClient({ hostId: "record-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  const client = host.scoped(await issueActor(host, "record-actor", "record-workspace"));
  const body = await client.putBlob(Buffer.from("record-body"), "record-body-op");
  const record = await client.putRecord({
    operationId: "record-put-op",
    recordId: "record-1",
    workspaceId: "record-workspace",
    recordType: "retrieval.artifact",
    state: "temporary",
    threadId: "thread-1",
    runId: "run-1",
    payloadJson: JSON.stringify({ receipt: "record-1" }),
    ownerIds: [body.ownerId],
    references: [{ slot: "body", objectHash: body.hash }],
  });
  assert.equal(record.recordId, "record-1");
  const read = await client.getBlob(body.hash, { recordId: "record-1", slot: "body" });
  assert.equal(Buffer.from(read.bytesBase64, "base64").toString("utf8"), "record-body");
  assert.equal((await client.listRecords({ workspaceId: "record-workspace", recordType: "retrieval.artifact", pageSize: 1 })).records.length, 1);
  await client.releaseRecord("record-release-op", "record-workspace", "record-1");
  await assert.rejects(client.getBlob(body.hash, { recordId: "record-1", slot: "body" }), /content|record|reference|owner/i);
});

test("branch creation streams a normal input larger than one control frame", { timeout: 60_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-large-branch-"));
  roots.push(root);
  const host = createKernelClient({ hostId: "large-branch-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  const client = host.scoped(await issueActor(host, "large-branch-actor", "large-branch-workspace"));
  const target = "x".repeat(1_024);
  const entries = Array.from({ length: 17_000 }, (_, index) => ({
    path: `wide/${String(index).padStart(6, "0")}`,
    state: { kind: "symlink" as const, symlinkTarget: target },
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(entries), "utf8") > 16 * 1024 * 1024);
  const created = await client.createBranch({ operationId: "large-branch-create", branchId: "large-branch", workspaceId: "large-branch-workspace", entries });
  assert.equal(created.created, true);
  assert.equal((await client.readBranch({ branchId: "large-branch" })).writeRevision, 0);
  const added = await client.writeBranch({
    operationId: "large-branch-add",
    branchId: "large-branch",
    expectedWriteRevision: 0,
    changes: [{ path: "wide/999999", state: { kind: "directory" } }],
  });
  const diff = await client.diffRoots({ leftRoot: String(created.root), rightRoot: added.root });
  assert.deepEqual(diff.added, ["wide/999999"]);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.removed, []);
});

test("kernel rejects an Application Host build identity mismatch", async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-build-id-"));
  roots.push(root);
  const host = createKernelClient({ hostId: "mismatch-host", storageRoot: root, buildVersion: `${buildVersion}-other`, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await assert.rejects(host.start(), /build identity|does not match kernel/i);
});

test("a current-format catalog with missing authority tables is rejected without repair", async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-schema-"));
  roots.push(root);
  const host = createKernelClient({ hostId: "schema-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  await host.close();
  const { default: Database } = await import("better-sqlite3");
  const catalog = new Database(path.join(root, "catalog.sqlite"));
  catalog.exec("DROP TABLE object_owners");
  catalog.close();
  const broken = createKernelClient({ hostId: "schema-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(broken);
  await assert.rejects(broken.start(), /catalog table set is corrupt|schema fingerprint/i);
  const verify = new Database(path.join(root, "catalog.sqlite"), { readonly: true });
  const exists = verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'object_owners'").get();
  verify.close();
  assert.equal(exists, undefined);
});

test("the source package finds its kernel independently of process cwd", async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-cwd-root-"));
  const unrelated = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-cwd-"));
  roots.push(root, unrelated);
  const previous = process.cwd();
  process.chdir(unrelated);
  try {
    const host = createKernelClient({
      hostId: "cwd-host",
      storageRoot: root,
      buildVersion,
      allowCargoDevRunner: false,
      requireKernelManifest: false,
      cwd: unrelated,
    });
    clients.push(host);
    assert.equal((await host.start()).kernelBuildIdentity, buildVersion);
  } finally {
    process.chdir(previous);
  }
});

test("real kernel recovery catalog persists checkpoints, operation files, and objects across restart", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-recovery-test-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-recovery-workspace-"));
  roots.push(root, workspace);
  await fs.writeFile(path.join(workspace, "a.txt"), "before");
  const makeEngine = async () => {
    const client = createKernelClient({ hostId: "kernel-recovery-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
    clients.push(client);
    await client.start();
    const adapter = new KernelStorageAdapter({ hostId: "kernel-recovery-host", storageRoot: root, client, resolveWorkspaceRoot: async () => workspace });
    const content = new KernelRecoveryContentStore(adapter, path.join(root, "recovery-cache"));
    const catalog = new KernelRecoveryCatalogBackend(adapter, content);
    const documents = {
      inspectWorkspace: async () => ({ workspaceId: "workspace-test", root: workspace }),
      listWorkspaceRegistrations: async () => [{ workspaceId: "workspace-test", canonicalPath: workspace }],
      inspectDirtyBuffers: async () => [],
      beginDirtyStateBarrier: async () => ({ release: async () => undefined, settle: async () => undefined }),
      runResourceOperation: async (_workspaceId: string, _resources: readonly unknown[], operation: () => Promise<unknown>) => operation(),
    };
    const navigation = {
      prepare: async () => ({ expectedLeafId: null, targetLeafId: null, removedEntryIds: [] }),
      prepareLeaf: async () => ({ expectedLeafId: null, targetLeafId: null }),
      commit: async () => ({}),
      commitLeaf: async () => ({}),
    };
    const engine = createWorkspaceRecoveryEngine({
      authorityId: "kernel-recovery-host",
      dataDir: path.join(root, "host-data"),
      documents: documents as never,
      sessionNavigation: navigation as never,
      fileStore: content,
      catalogBackend: catalog,
    });
    return { adapter, client, engine };
  };

  const first = await makeEngine();
  await first.engine.recordTurnStart({ executionId: "execution-1", workspaceId: "workspace-test", sessionId: "session-1", userEntryId: "user-1", workerId: "worker-1", runtimeGeneration: 1, activeWriterScopes: [], provenance: "caused-by" });
  await first.engine.recordMutationBefore({ executionId: "execution-1", workspaceId: "workspace-test", path: "a.txt", toolName: "edit", mutationId: "mutation-1", toolCallId: "tool-call-1" });
  await fs.writeFile(path.join(workspace, "a.txt"), "after");
  await first.engine.recordMutationAfter({ executionId: "execution-1", workspaceId: "workspace-test", path: "a.txt", toolName: "edit", mutationId: "mutation-1", toolCallId: "tool-call-1", succeeded: true });
  await first.engine.recordTurnSettled({ executionId: "execution-1", workspaceId: "workspace-test", activeWriterScopes: [], provenance: "caused-by", observedResourceIds: ["a.txt"], observationComplete: true, mutationObserved: true, assistantEntryId: "assistant-1" });
  await first.engine.dispose();
  await first.adapter.dispose();
  await first.client.close();

  const second = await makeEngine();
  const checkpoints = await second.engine.listCheckpoints({ workspaceId: "workspace-test" });
  assert.equal(checkpoints.status, "ready");
  assert.equal(checkpoints.page.checkpoints.length, 1);
  const resolved = await second.engine.resolveEntry({ workspaceId: "workspace-test", sessionId: "session-1", entryId: "user-1" });
  assert.equal(resolved.status, "ready");
  assert.equal(resolved.binding?.checkpointId, checkpoints.page.checkpoints[0]?.id);
  await second.engine.dispose();
  await second.adapter.dispose();
  await second.client.close();
});
