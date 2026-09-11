import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { createWorkspaceRecoveryEngine, type CreateWorkspaceRecoveryEngineOptions } from "../recovery/journal-engine.js";
import { createRecoveryFileStore } from "../recovery/journal-files.js";
import { createThreadRegistry, type CreateThreadInput } from "./thread-registry.js";
import { createThreadRuntime } from "./thread-runtime.js";
import { IntegrationCoordinator } from "./working-state/integration-coordinator.js";
import type { RecoveryState } from "./working-state/types.js";
import { createWorkspaceWorkingStateAccess } from "./working-state/working-state-store.js";

const PARENT = { kind: "session" as const, id: "root-session" };
const roots: string[] = [];

const regularFile = (object: { hash: string; byteLength: number }, mode?: number): RecoveryState => ({
  kind: "regular-file",
  objectHash: object.hash,
  byteLength: object.byteLength,
  ...(mode === undefined ? {} : { mode }),
});

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

describe("nested thread production chain", () => {
  it("fixes a grandchild from the parent branch view and merges back without copying the grandchild transcript", async () => {
    const root = await fs.promises.mkdtemp(join(os.tmpdir(), "piarium-nested-threads-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const dataDir = join(root, "data");
    await fs.promises.mkdir(workspace, { recursive: true });
    await fs.promises.writeFile(join(workspace, "kept.txt"), "root-at-dispatch\n");
    const documents: CreateWorkspaceRecoveryEngineOptions["documents"] = {
      inspectWorkspace: async () => ({ root: workspace, workspaceId: "ws" }),
      listWorkspaceRegistrations: async () => [{ canonicalPath: workspace, workspaceId: "ws" }],
      beginDirtyStateBarrier: async () => ({ release: async () => undefined, settle: async () => undefined }),
      inspectDirtyBuffers: async () => [],
      runResourceOperation: vi.fn(async (_workspaceId, _resources, operation) => operation()),
    };
    const engine = createWorkspaceRecoveryEngine({
      authorityId: "test",
      dataDir,
      documents,
      fileStore: createRecoveryFileStore(),
      sessionNavigation: {
        prepare: async () => ({ expectedLeafId: null, targetLeafId: null }),
        prepareLeaf: async () => ({ expectedLeafId: null, targetLeafId: null }),
        commit: async () => ({}),
        commitLeaf: async () => ({}),
      },
    });
    const workingStates = createWorkspaceWorkingStateAccess(engine);
    const registry = createThreadRegistry({ dataDir: join(root, "threads"), hostId: "host-1" });
    const runtime = createThreadRuntime({
      registry,
      workingStates,
      resolveWorkspaceRoot: async () => workspace,
      resolveRuntimeWorkspaceId: async () => "ws",
      sessions: {
        create: async () => { throw new Error("session create is not used"); },
        open: async () => { throw new Error("session open is not used"); },
        prompt: async () => undefined,
        send: async () => undefined,
        abort: async () => undefined,
        close: async () => undefined,
        snapshot: async () => { throw new Error("unused"); },
        summary: async () => { throw new Error("unused"); },
        stats: async () => { throw new Error("unused"); },
        entries: async (sessionId) => ({ sessionId, scope: "branch", leafId: null, entries: [] }),
      },
      worktrees: {
        prepare: async (input) => {
          const path = join(root, `scratch-${input.threadId}`);
          await fs.promises.mkdir(path, { recursive: true });
          return {
            cwd: path,
            worktree: { path, base: "zero-commit", viewMode: "virtual", materialized: false },
          };
        },
        snapshot: async (worktree) => worktree,
        inspect: async () => ({ patch: "", untracked: [], changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
        merge: async () => ({ merged: 0, conflicts: [], conflictState: "none", changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
      },
    });
    const coordinator = new IntegrationCoordinator({ workingStates });
    const input = (overrides: Partial<CreateThreadInput> = {}): CreateThreadInput => ({
      workspaceId: "ws",
      parent: PARENT,
      brief: "parent",
      role: "hard-implement",
      kind: "implementation",
      createdBy: "agent",
      concurrency: 4,
      autoRun: true,
      worktree: "isolated",
      tools: ["read", "write", "dispatch"],
      permissions: {},
      ...overrides,
    });
    try {
      const parent = await registry.createThread(input());
      await runtime.prepareIsolatedBranch({
        workspaceId: "ws",
        parent: PARENT,
        threadId: parent.id,
      });
      await workingStates.withStore("ws", "parent-write", async (store) => {
        const branch = store.getBranch(`thread-${parent.id}`)!;
        const current = store.effectiveState(`thread-${parent.id}`)!["kept.txt"];
        const object = await store.putObject(Buffer.from("parent-before-child\n"));
        await store.commitVirtualWrites(`thread-${parent.id}`, branch.writeRevision ?? 0, {
          "kept.txt": regularFile(object, current?.kind === "regular-file" ? current.mode : undefined),
        });
      });
      const child = await registry.createThread(input({
        parent: { kind: "thread", id: parent.id },
        brief: "grandchild",
        role: "check",
      }));
      await runtime.prepareIsolatedBranch({
        workspaceId: "ws",
        parent: { kind: "thread", id: parent.id },
        threadId: child.id,
      });
      await workingStates.withStore("ws", "parent-drift-after-nested-dispatch", async (store) => {
        const branch = store.getBranch(`thread-${parent.id}`)!;
        const current = store.effectiveState(`thread-${parent.id}`)!["kept.txt"];
        const object = await store.putObject(Buffer.from("parent-after-child-dispatch\n"));
        await store.commitVirtualWrites(`thread-${parent.id}`, branch.writeRevision ?? 0, {
          "kept.txt": regularFile(object, current?.kind === "regular-file" ? current.mode : undefined),
        });
        const childView = store.effectiveState(`thread-${child.id}`)!;
        const kept = childView["kept.txt"];
        if (kept?.kind !== "regular-file") throw new Error("expected nested baseline file");
        expect(await store.getObject(kept.objectHash)).toEqual(Buffer.from("parent-before-child\n"));
        expect(store.getBranch(`thread-${child.id}`)?.baseRef).toMatch(new RegExp(`^thread-${parent.id}@`));
      });
      const childResult = await workingStates.withStore("ws", "child-result", async (store) => {
        const branch = store.getBranch(`thread-${child.id}`)!;
        const object = await store.putObject(Buffer.from("grandchild-edit\n"));
        await store.commitVirtualWrites(`thread-${child.id}`, branch.writeRevision ?? 0, {
          "child.txt": regularFile(object),
        });
        return store.publishHeadResult(`thread-${child.id}`);
      });
      await coordinator.mergeResult({
        workspaceId: "ws",
        threadId: child.id,
        branchId: `thread-${child.id}`,
        resultRevision: childResult.resultRevision,
        parentAuthority: { kind: "branch", branchId: `thread-${parent.id}` },
      });
      expect(await fs.promises.readFile(join(workspace, "kept.txt"), "utf8")).toBe("root-at-dispatch\n");
      expect(await fs.promises.stat(join(workspace, "child.txt")).then(() => true, () => false)).toBe(false);
      const parentResult = await workingStates.withStore("ws", "parent-after-nested-merge", async (store) => {
        const live = store.effectiveState(`thread-${parent.id}`)!;
        const childFile = live["child.txt"];
        if (childFile?.kind !== "regular-file") throw new Error("expected grandchild file on parent branch");
        expect(await store.getObject(childFile.objectHash)).toEqual(Buffer.from("grandchild-edit\n"));
        const kept = live["kept.txt"];
        if (kept?.kind !== "regular-file") throw new Error("expected parent file");
        expect(await store.getObject(kept.objectHash)).toEqual(Buffer.from("parent-after-child-dispatch\n"));
        return store.publishHeadResult(`thread-${parent.id}`);
      });
      const parentMerge = await coordinator.mergeResult({
        workspaceId: "ws",
        threadId: parent.id,
        branchId: `thread-${parent.id}`,
        resultRevision: parentResult.resultRevision,
      });
      expect(parentMerge).toMatchObject({ status: "applied" });
      expect(parentMerge.appliedPaths).toEqual(expect.arrayContaining(["kept.txt", "child.txt"]));
      expect(await fs.promises.readFile(join(workspace, "kept.txt"), "utf8")).toBe("parent-after-child-dispatch\n");
      expect(await fs.promises.readFile(join(workspace, "child.txt"), "utf8")).toBe("grandchild-edit\n");
      expect(childResult.changedPaths).not.toContain("transcript");
    } finally {
      await runtime.dispose();
      await registry.dispose();
      await engine.dispose();
    }
  });

  it("inherits the parent branch captureScopes and ignores later live copyIgnored settings", async () => {
    const root = await fs.promises.mkdtemp(join(os.tmpdir(), "piarium-nested-scopes-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const dataDir = join(root, "data");
    await fs.promises.mkdir(workspace, { recursive: true });
    await fs.promises.writeFile(join(workspace, "kept.txt"), "root\n");
    await fs.promises.writeFile(join(workspace, "secret.env"), "parent-secret\n");
    const engine = createWorkspaceRecoveryEngine({
      authorityId: "test",
      dataDir,
      documents: {
        inspectWorkspace: async () => ({ root: workspace, workspaceId: "ws" }),
        listWorkspaceRegistrations: async () => [{ canonicalPath: workspace, workspaceId: "ws" }],
        beginDirtyStateBarrier: async () => ({ release: async () => undefined, settle: async () => undefined }),
        inspectDirtyBuffers: async () => [],
        runResourceOperation: vi.fn(async (_workspaceId, _resources, operation) => operation()),
      },
      fileStore: createRecoveryFileStore(),
      sessionNavigation: {
        prepare: async () => ({ expectedLeafId: null, targetLeafId: null }),
        prepareLeaf: async () => ({ expectedLeafId: null, targetLeafId: null }),
        commit: async () => ({}),
        commitLeaf: async () => ({}),
      },
    });
    const workingStates = createWorkspaceWorkingStateAccess(engine);
    const registry = createThreadRegistry({ dataDir: join(root, "threads"), hostId: "host-1" });
    let copyIgnored = ["secret.env"];
    const runtime = createThreadRuntime({
      registry,
      workingStates,
      resolveWorkspaceRoot: async () => workspace,
      resolveRuntimeWorkspaceId: async () => "ws",
      resolveWorktreeSettings: async () => ({ copyIgnored }),
      sessions: {
        create: async () => { throw new Error("session create is not used"); },
        open: async () => { throw new Error("session open is not used"); },
        prompt: async () => undefined,
        send: async () => undefined,
        abort: async () => undefined,
        close: async () => undefined,
        snapshot: async () => { throw new Error("unused"); },
        summary: async () => { throw new Error("unused"); },
        stats: async () => { throw new Error("unused"); },
        entries: async (sessionId) => ({ sessionId, scope: "branch", leafId: null, entries: [] }),
      },
      worktrees: {
        prepare: async (input) => {
          const path = join(root, `scratch-${input.threadId}`);
          await fs.promises.mkdir(path, { recursive: true });
          return {
            cwd: path,
            worktree: { path, base: "zero-commit", viewMode: "virtual", materialized: false },
          };
        },
        snapshot: async (worktree) => worktree,
        inspect: async () => ({ patch: "", untracked: [], changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
        merge: async () => ({ merged: 0, conflicts: [], conflictState: "none", changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
      },
    });
    try {
      const parent = await registry.createThread({
        workspaceId: "ws",
        parent: PARENT,
        brief: "parent",
        role: "hard-implement",
        kind: "implementation",
        createdBy: "agent",
        concurrency: 4,
        autoRun: true,
        worktree: "isolated",
        tools: ["dispatch"],
        permissions: {},
      });
      await runtime.prepareIsolatedBranch({ workspaceId: "ws", parent: PARENT, threadId: parent.id });
      copyIgnored = ["later.env"];
      const child = await registry.createThread({
        workspaceId: "ws",
        parent: { kind: "thread", id: parent.id },
        brief: "child",
        role: "check",
        kind: "implementation",
        createdBy: "agent",
        concurrency: 4,
        autoRun: true,
        worktree: "isolated",
        tools: ["read"],
        permissions: {},
      });
      await runtime.prepareIsolatedBranch({
        workspaceId: "ws",
        parent: { kind: "thread", id: parent.id },
        threadId: child.id,
      });
      await workingStates.withStore("ws", "assert-inherited-scopes", async (store) => {
        expect(store.getBranch(`thread-${parent.id}`)?.captureScopes).toEqual(["secret.env"]);
        expect(store.getBranch(`thread-${child.id}`)?.captureScopes).toEqual(["secret.env"]);
      }, "shared");
    } finally {
      await runtime.dispose();
      await registry.dispose();
      await engine.dispose();
    }
  });
});
