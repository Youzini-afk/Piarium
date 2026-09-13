import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { ThreadExecutionViewRegistry } from "../harness/working-state/execution-view.js";
import { createWorkingBranchLookups } from "../harness/working-state/working-branch-lookups.js";
import { createWorkingBranchWriteServices } from "../harness/working-state/working-branch-writes.js";
import { VirtualWriteGate } from "../harness/working-state/virtual-write-gate.js";
import { IntegrationCoordinator } from "../harness/working-state/integration-coordinator.js";
import { createWorkspaceRecoveryEngine, type CreateWorkspaceRecoveryEngineOptions } from "../recovery/journal-engine.js";
import { createKernelClient } from "./kernel-client.js";
import { createKernelWorkspaceWorkingStateAccess, KernelStorageAdapter, KernelWorkingStateRootStore } from "./storage-adapter.js";
import { KernelRecoveryContentStore, KernelRecoveryStore, createKernelRecoveryDirectFacade } from "./kernel-recovery-store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../../../../..");
const kernelPath = path.join(repositoryRoot, "kernel", "target", "release", process.platform === "win32" ? "piarium-kernel.exe" : "piarium-kernel");
const hasReleaseKernel = await fs.stat(kernelPath).then(() => true).catch(() => false);
const buildVersion = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8")).version as string;

it.skipIf(!hasReleaseKernel)("release kernel owns working-state roots, pinned reads, scoped lists, virtual writes, and base reverts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-working-state-"));
  const workspace = path.join(root, "workspace");
  const storageRoot = path.join(root, "storage");
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "mode.txt"), "base body\n");
  await fs.writeFile(path.join(workspace, "src", "nested.ts"), "nested base\n");
  const workspaceId = "workspace-working-state";
  const branchId = "branch-working-state";
  const sessionId = "session-working-state";
  const client = createKernelClient({
    hostId: "working-state-test-host",
    storageRoot,
    buildVersion,
    kernelPath,
    allowCargoDevRunner: false,
  });
  const resolvedActorHints: Array<{ sessionId?: string; threadId?: string; runId?: string }> = [];
  const adapter = new KernelStorageAdapter({
    client,
    hostId: "working-state-test-host",
    storageRoot,
    resolveWorkspaceRoot: async () => workspace,
    resolveActor: async (_workspace, _purpose, hint) => {
      resolvedActorHints.push({
        ...(hint?.sessionId ? { sessionId: hint.sessionId } : {}),
        ...(hint?.threadId ? { threadId: hint.threadId } : {}),
        ...(hint?.runId ? { runId: hint.runId } : {}),
      });
      if (hint?.capabilities?.includes("storage.maintenance")) return hint;
      assert.equal(hint?.sessionId, sessionId);
      assert.equal(hint?.threadId, "working-state");
      assert.equal(hint?.runId, "run-working-state");
      return {
        ...hint,
        authorityInstanceId: "working-state-authority",
        workerId: "working-state-worker",
        workerGeneration: 4,
        owningWorkspace: workspaceId,
        executionWorkspace: workspaceId,
        pathScopes: [""],
      };
    },
  });
  adapter.bindFileStore(new KernelRecoveryContentStore(adapter, path.join(root, "recovery-cache")));
  try {
    await client.start();
    const access = createKernelWorkspaceWorkingStateAccess(adapter);
    let baseMode: number | undefined;
    await access.withStore(workspaceId, "test-create", async (store) => {
      const base = await store.captureDirectory(workspace);
      baseMode = base["mode.txt"]?.kind === "regular-file" ? base["mode.txt"].mode : undefined;
      await store.createBranch(workspaceId, branchId, base, "disk-base");
    });

    const maintenance = await adapter.context(workspaceId, "test-drop-branch-metadata", {
      owningWorkspace: workspaceId,
      executionWorkspace: workspaceId,
      pathScopes: [""],
      capabilities: ["storage.maintenance"],
    });
    await maintenance.records.release("test-drop-branch-metadata", `working-branch:${branchId}`);
    await access.withStore(workspaceId, "test-repair-branch-metadata", async (store) => {
      const base = await store.captureDirectory(workspace);
      const repaired = await store.createBranch(workspaceId, branchId, base, "disk-base", ["draft-only.ts"], ["src"]);
      assert.equal(repaired.baseRef, "disk-base");
      assert.deepEqual(repaired.draftBasePaths, ["draft-only.ts"]);
      assert.deepEqual(repaired.captureScopes, ["src"]);
      await assert.rejects(
        store.createBranch(workspaceId, branchId, base, "other-base", ["draft-only.ts"], ["src"]),
        /different metadata/i,
      );
    });

    const views = new ThreadExecutionViewRegistry();
    views.bind({
      sessionId,
      workspaceId,
      threadId: "working-state",
      runId: "run-working-state",
      branchId,
      revision: 0,
      writeRevision: 0,
      mode: "virtual",
      draftBasePaths: [],
    });
    const lookups = createWorkingBranchLookups({ views, workingStates: access });
    const writes = createWorkingBranchWriteServices({ views, workingStates: access, writeGate: new VirtualWriteGate() });

    await fs.writeFile(path.join(workspace, "mode.txt"), "parent drift\n");
    const fixed = await lookups.readSource(sessionId, "mode.txt");
    assert.equal(fixed?.status, "working-branch");
    assert.equal(fixed && fixed.status === "working-branch" && fixed.base64
      ? Buffer.from(fixed.base64, "base64").toString("utf8")
      : null, "base body\n");

    const rewritten = await writes.branchWrite(sessionId, [{ resourceId: "mode.txt", action: "write", content: "pinned body\n" }]);
    assert.equal(rewritten.status, "committed");
    const nested = await writes.branchWrite(sessionId, [{ resourceId: "new/deep/file.ts", action: "write", content: "new branch file\n" }]);
    assert.equal(nested.status, "committed");
    const stale = await writes.branchWrite(sessionId, [{ resourceId: "stale.ts", action: "write", content: "stale\n" }], 0);
    assert.equal(stale.status, "conflict");
    const blocked = await writes.branchWrite(sessionId, [{ resourceId: "mode.txt/child.ts", action: "write", content: "blocked\n" }]);
    assert.equal(blocked.status, "rejected");

    await access.withBranchStore(workspaceId, "test-invariants", async (store) => {
      const mode = await store.readPath(branchId, "mode.txt");
      assert.equal(mode?.state.kind, "regular-file");
      if (mode?.state.kind === "regular-file") assert.equal(mode.state.mode, baseMode);
      assert.equal((await store.readPath(branchId, "new"))?.state.kind, "directory");
    }, "shared");

    const pinnedRoot = await access.withBranchStore(workspaceId, "test-pin-root", (store) => store.getBranchRoot(branchId), "shared");
    assert.ok(pinnedRoot);
    const controller = new AbortController();
    const pinned = await lookups.pinQuery(sessionId, { roots: [""], signal: controller.signal, deadlineAt: Date.now() + 10_000 });
    assert.ok(pinned);
    assert.equal(pinned.root, pinnedRoot.root);
    assert.equal(pinned.writeRevision, 2);
    assert.equal(pinned.files.find((file) => file.path === "mode.txt")?.text, "pinned body\n");
    const scoped = await lookups.pinQuery(sessionId, { roots: ["src"], deadlineAt: Date.now() + 10_000 });
    assert.deepEqual(scoped?.files.map((file) => file.path), ["src/nested.ts"]);
    await scoped?.release();

    const later = await writes.branchWrite(sessionId, [{ resourceId: "mode.txt", action: "write", content: "later body\n" }]);
    assert.equal(later.status, "committed");
    const pinnedRead = await pinned.readFile("mode.txt");
    assert.equal(pinnedRead.status, "ready");
    if (pinnedRead.status === "ready") assert.equal(pinnedRead.content, "pinned body\n");
    controller.abort();
    await pinned.release();
    const verification = await adapter.context(workspaceId, "test-pin-release", {
      owningWorkspace: workspaceId,
      executionWorkspace: workspaceId,
      sessionId,
      threadId: "working-state",
      runId: "run-working-state",
      pathScopes: [""],
    });
    await assert.rejects(verification.client.readPin({ pinId: pinned.pinId }), /pin not found/i);
    await assert.rejects(
      verification.resourceOperationGate.run([], async () => "unexpected"),
      /operation gate is not bound/i,
    );

    const published = await access.withStore(workspaceId, "test-publish", (store) => store.publishHeadResult(branchId));
    assert.equal(published.root?.startsWith("sha256-"), true);

    await fs.writeFile(path.join(workspace, "mode.txt"), "base body\n");
    const reverted = await access.withStore(workspaceId, "test-revert", (store) => store.publishDirectoryResult(branchId, workspace));
    assert.deepEqual(reverted.changedPaths, []);
    await access.withBranchStore(workspaceId, "test-reverted-root", async (store) => {
      const branch = await store.getBranchRoot(branchId);
      assert.ok(branch);
      const currentTree = await store.listPaths(branchId, [""]);
      const baseTree = await store.listPaths(branchId, [""], { revision: 0 });
      assert.deepEqual(currentTree?.entries.map(({ path, state }) => ({ path, state })), baseTree?.entries.map(({ path, state }) => ({ path, state })));
      assert.equal(branch.root, branch.baseRoot);
      assert.equal(reverted.root, branch.root);
      assert.equal((await store.readPath(branchId, "mode.txt"))?.origin, "base");
      assert.equal((await store.readPath(branchId, "new/deep/file.ts"))?.state.kind, "missing");
    }, "shared");
    await access.withStore(workspaceId, "test-reverted-projection", (store) => {
      assert.deepEqual(store.getBranch(branchId)?.deltas, {});
    }, "shared");
    assert.ok(resolvedActorHints.some((hint) => hint.sessionId === sessionId && hint.threadId === "working-state" && hint.runId === "run-working-state"));
  } finally {
    await adapter.dispose().catch(() => undefined);
    await client.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.skipIf(!hasReleaseKernel)("composes the kernel branch authority with the durable integration journal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-integration-"));
  const workspace = path.join(root, "workspace");
  const storageRoot = path.join(root, "storage");
  const dataDir = path.join(root, "data");
  const workspaceId = "kernel-integration-workspace";
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "base.txt"), "base\n");
  const documents: CreateWorkspaceRecoveryEngineOptions["documents"] = {
    inspectWorkspace: async () => ({ root: workspace, workspaceId }),
    listWorkspaceRegistrations: async () => [{ canonicalPath: workspace, workspaceId }],
    beginDirtyStateBarrier: async () => ({ release: async () => undefined, settle: async () => undefined }),
    inspectDirtyBuffers: async () => [],
    runResourceOperation: async (_workspace, _resources, operation) => operation(),
  };
  const baseEngine = createWorkspaceRecoveryEngine({
    authorityId: "kernel-integration-test",
    dataDir,
    documents,
    sessionNavigation: {
      prepare: async () => ({ expectedLeafId: null, targetLeafId: null }),
      prepareLeaf: async () => ({ expectedLeafId: null, targetLeafId: null }),
      commit: async () => ({}),
      commitLeaf: async () => ({}),
    },
  });
  const client = createKernelClient({
    hostId: "kernel-integration-test-host",
    storageRoot,
    buildVersion,
    kernelPath,
    allowCargoDevRunner: false,
  });
  const adapter = new KernelStorageAdapter({
    client,
    hostId: "kernel-integration-test-host",
    storageRoot,
    resolveWorkspaceRoot: async () => workspace,
  });
  const content = new KernelRecoveryContentStore(adapter, path.join(root, "recovery-cache"));
  adapter.bindFileStore(content);
  const kernelRecoveryStore = new KernelRecoveryStore(adapter, content);
  const engine = createKernelRecoveryDirectFacade(baseEngine, kernelRecoveryStore);
  try {
    await client.start();
    const access = createKernelWorkspaceWorkingStateAccess(adapter, engine, kernelRecoveryStore);
    const result = await access.withStore(workspaceId, "integration-setup", async (store) => {
      const base = await store.captureDirectory(workspace);
      await store.createBranch(workspaceId, "parent-branch", base, "base");
      await store.createBranch(workspaceId, "child-branch", base, "parent-branch@0");
      const object = await store.putObject(Buffer.from("child\n"));
      const written = await store.commitVirtualWrites("child-branch", 0, {
        "child.txt": { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength },
      });
      assert.equal(written.status, "committed");
      return store.publishHeadResult("child-branch");
    });
    const merged = await new IntegrationCoordinator({ workingStates: access }).mergeResult({
      workspaceId,
      threadId: "child-thread",
      branchId: "child-branch",
      resultRevision: result.resultRevision,
      parentAuthority: { kind: "branch", branchId: "parent-branch" },
    });
    assert.equal(merged.status, "applied");
    await access.withStore(workspaceId, "integration-assert", async (store, context) => {
      assert.equal(await context.resourceOperationGate.run([], async () => "documents-gate"), "documents-gate");
      const durable = await kernelRecoveryStore.getOperation(workspaceId, merged.operationId);
      assert.equal(durable?.state, "complete");
      const state = store.effectiveState("parent-branch")?.["child.txt"];
      assert.equal(state?.kind, "regular-file");
      if (state?.kind === "regular-file") assert.equal((await store.getObject(state.objectHash))?.toString("utf8"), "child\n");
    }, "shared");
  } finally {
    await adapter.dispose().catch(() => undefined);
    await client.close().catch(() => undefined);
    await engine.dispose().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.skipIf(!hasReleaseKernel)("uses Rust operation phases for dirty surface integration and undo", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-surface-integration-"));
  const workspace = path.join(root, "workspace");
  const storageRoot = path.join(root, "storage");
  const dataDir = path.join(root, "data");
  const workspaceId = "kernel-surface-workspace";
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "a.txt"), "base\n");
  const documents: CreateWorkspaceRecoveryEngineOptions["documents"] = {
    inspectWorkspace: async () => ({ root: workspace, workspaceId }),
    listWorkspaceRegistrations: async () => [{ canonicalPath: workspace, workspaceId }],
    beginDirtyStateBarrier: async () => ({ release: async () => undefined, settle: async () => undefined }),
    inspectDirtyBuffers: async () => [],
    runResourceOperation: async (_workspace, _resources, operation) => operation(),
  };
  const baseEngine = createWorkspaceRecoveryEngine({
    authorityId: "kernel-surface-test",
    dataDir,
    documents,
    sessionNavigation: { prepare: async () => ({ expectedLeafId: null, targetLeafId: null }), prepareLeaf: async () => ({ expectedLeafId: null, targetLeafId: null }), commit: async () => ({}), commitLeaf: async () => ({}) },
  });
  const client = createKernelClient({ hostId: "kernel-surface-host", storageRoot, buildVersion, kernelPath, allowCargoDevRunner: false });
  const adapter = new KernelStorageAdapter({ client, hostId: "kernel-surface-host", storageRoot, resolveWorkspaceRoot: async () => workspace });
  const content = new KernelRecoveryContentStore(adapter, path.join(root, "recovery-cache"));
  adapter.bindFileStore(content);
  const kernelRecoveryStore = new KernelRecoveryStore(adapter, content);
  const engine = createKernelRecoveryDirectFacade(baseEngine, kernelRecoveryStore);
  const surfaceHash = (value: string) => `sha256-${createHash("sha256").update(value, "utf8").digest("hex")}`;
  try {
    await client.start();
    const access = createKernelWorkspaceWorkingStateAccess(adapter, engine, kernelRecoveryStore);
    const result = await access.withStore(workspaceId, "surface-setup", async (store) => {
      const base = await store.captureDirectory(workspace);
      await store.createBranch(workspaceId, "surface-parent", base, "base");
      await store.createBranch(workspaceId, "surface-child", base, "surface-parent@0");
      const object = await store.putObject(Buffer.from("child\n"));
      const baseMode = base["a.txt"]?.kind === "regular-file" ? base["a.txt"].mode : undefined;
      await store.commitVirtualWrites("surface-child", 0, { "a.txt": { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength, ...(baseMode === undefined ? {} : { mode: baseMode }) } });
      return store.publishHeadResult("surface-child");
    });
    const baseHash = surfaceHash("base\n");
    const childHash = surfaceHash("child\n");
    const requestSurfaceOperation = async (request: { action: string; targets: Array<{ resource: { resourceId: string }; documentInstanceId: string; beforeLocalEditRevision?: number; localEditRevision?: number; beforeHash?: string; bufferHash?: string; afterLocalEditRevision?: number; afterHash?: string }> }) => {
      return request.targets.map((target) => {
        const revision = target.beforeLocalEditRevision ?? target.localEditRevision ?? 1;
        const hash = target.beforeHash ?? target.bufferHash ?? baseHash;
        if (request.action === "capture") return { resource: target.resource, status: "captured" as const, content: "base\n", documentInstanceId: target.documentInstanceId, beforeLocalEditRevision: revision, beforeHash: hash };
        if (request.action === "undo") return { resource: target.resource, status: "undone" as const, documentInstanceId: target.documentInstanceId, afterLocalEditRevision: revision, afterHash: baseHash };
        return { resource: target.resource, status: "applied" as const, documentInstanceId: target.documentInstanceId, beforeLocalEditRevision: revision, beforeHash: hash, afterLocalEditRevision: revision + 1, afterHash: childHash };
      });
    };
    const publication = { ownerId: "surface-owner", generation: 1, registrationId: "surface-registration", resources: [{ baseRevision: null, localEditRevision: 1, resource: { resourceId: "a.txt" }, documentInstanceId: "surface-document", bufferHash: baseHash, encoding: "utf-8", bom: false, lineEnding: "lf" as const }] };
    const coordinator = new IntegrationCoordinator({ workingStates: access, inspectDirtyBuffers: async () => [publication], requestSurfaceOperation: requestSurfaceOperation as never });
    const merged = await coordinator.mergeResult({ workspaceId, threadId: "surface-thread", branchId: "surface-child", resultRevision: result.resultRevision, sourceOwner: { ownerId: "surface-owner", generation: 1 } });
    assert.equal(merged.status, "applied");
    const operation = await kernelRecoveryStore.getOperation(workspaceId, merged.operationId);
    assert.equal(operation?.state, "complete");
    const undone = await coordinator.undoIntegration({ workspaceId, threadId: "surface-thread", operationId: merged.operationId, sourceOwner: { ownerId: "surface-owner", generation: 1 } });
    assert.equal(undone.status, "compensated");
    const afterUndo = await kernelRecoveryStore.getOperation(workspaceId, merged.operationId);
    assert.equal(afterUndo?.state, "undone");
  } finally {
    await adapter.dispose().catch(() => undefined);
    await client.close().catch(() => undefined);
    await engine.dispose().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.skipIf(!hasReleaseKernel)("publishes a pinned virtual root without mixing a concurrent write", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-kernel-publish-race-"));
  const workspace = path.join(root, "workspace");
  const storageRoot = path.join(root, "storage");
  const workspaceId = "kernel-publish-race-workspace";
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "a.txt"), "base\n");
  const client = createKernelClient({ hostId: "kernel-publish-race-host", storageRoot, buildVersion, kernelPath, allowCargoDevRunner: false });
  const adapter = new KernelStorageAdapter({ client, hostId: "kernel-publish-race-host", storageRoot, resolveWorkspaceRoot: async () => workspace });
  adapter.bindFileStore(new KernelRecoveryContentStore(adapter, path.join(root, "recovery-cache")));
  try {
    await client.start();
    const access = createKernelWorkspaceWorkingStateAccess(adapter);
    await access.withStore(workspaceId, "publish-race-setup", async (store) => {
      const base = await store.captureDirectory(workspace);
      await store.createBranch(workspaceId, "publish-race", base, "base");
      const object = await store.putObject(Buffer.from("one\n"));
      const baseMode = base["a.txt"]?.kind === "regular-file" ? base["a.txt"].mode : undefined;
      const committed = await store.commitVirtualWrites("publish-race", 0, { "a.txt": { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength, ...(baseMode === undefined ? {} : { mode: baseMode }) } });
      assert.equal(committed.status, "committed");
    });
    const context = await adapter.context(workspaceId, "publish-race-context");
    const store = new KernelWorkingStateRootStore(context);
    const writer = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const object = await store.putObject(Buffer.from("two\n"));
      const result = await store.commitVirtualWrites("publish-race", 1, { "a.txt": { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength } });
      return result;
    })();
    const published = await store.publishHeadResult("publish-race").catch((error: unknown) => error);
    const write = await writer;
    assert.equal(write.status, "committed");
    if (published instanceof Error) {
      assert.match(published.message, /changed|conflict|publishing/i);
      return;
    }
    const result = published as { root: string; changedPaths: string[]; pathStates: Record<string, { kind: string; objectHash?: string }> };
    assert.equal(result.changedPaths.includes("a.txt"), true);
    const state = result.pathStates["a.txt"];
    assert.equal(state?.kind, "regular-file");
    const body = state?.objectHash ? await store.getObject(state.objectHash) : null;
    assert.ok(body);
    assert.equal(body?.toString("utf8"), "one\n");
    const current = await store.getBranchRoot("publish-race");
    assert.ok(current);
    assert.notEqual(current?.root, result.root);
  } finally {
    await adapter.dispose().catch(() => undefined);
    await client.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});
