import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createWorkspaceRecoveryEngine, type CreateWorkspaceRecoveryEngineOptions } from "../../recovery/journal-engine.js";
import { createRecoveryFileStore } from "../../recovery/journal-files.js";
import { initOperationFiles, openRecoveryJournalCatalog, updateOperationFilePhase, writeOperationRow } from "../../recovery/journal-catalog.js";
import { createWorkspaceWorkingStateAccess, type WorkspaceWorkingStateAccess } from "./working-state-store.js";
import { IntegrationCoordinator } from "./integration-coordinator.js";
import type { RecoveryState } from "./types.js";
import { createThreadWorktreeRuntime } from "../thread-worktree.js";
import { applyDurableFileOperation } from "../../recovery/durable-file-operation.js";
import { createDocumentAuthority } from "../../documents/authority.js";

const roots: string[] = [];

const createHarness = async (fileStore = createRecoveryFileStore()) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "piarium-integration-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await fs.promises.mkdir(workspace, { recursive: true });
  const documents: CreateWorkspaceRecoveryEngineOptions["documents"] = {
    inspectWorkspace: async () => ({ root: workspace, workspaceId: "ws" }),
    listWorkspaceRegistrations: async () => [{ canonicalPath: workspace, workspaceId: "ws" }],
    beginDirtyStateBarrier: async () => ({ release: async () => undefined, settle: async () => undefined }),
    inspectDirtyBuffers: async () => [],
    runResourceOperation: vi.fn(async (_workspaceId, _resources, operation) => operation()),
  };
  const navigation: CreateWorkspaceRecoveryEngineOptions["sessionNavigation"] = {
    prepare: async () => ({ expectedLeafId: null, targetLeafId: null }),
    prepareLeaf: async () => ({ expectedLeafId: null, targetLeafId: null }),
    commit: async () => ({}),
    commitLeaf: async () => ({}),
  };
  const engine = createWorkspaceRecoveryEngine({ authorityId: "test", dataDir, documents, fileStore, sessionNavigation: navigation });
  const workingStates = createWorkspaceWorkingStateAccess(engine);
  return { coordinator: new IntegrationCoordinator({ workingStates }), dataDir, documents, engine, navigation, root, workingStates, workspace };
};

const prepareResult = async (h: Awaited<ReturnType<typeof createHarness>>, child: string, branchId = "thread-1") => {
  return h.workingStates.withStore("ws", "test-publish", async (store) => {
    await store.createBranch("ws", branchId, await store.captureDirectory(h.workspace), "base");
    return store.publishDirectoryResult(branchId, child);
  });
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

describe("IntegrationCoordinator", () => {
  it("runs a non-Git prepare, publish, merge, reclaim, and reopen file chain", async () => {
    const h = await createHarness();
    const runtime = createThreadWorktreeRuntime({
      createWorktree: async (_source, input) => {
        const target = path.join(h.root, "worktrees", String(input.worktreeName));
        await fs.promises.mkdir(target, { recursive: true });
        return { path: target };
      },
      getWorktreeBootstrapStatus: async () => ({ status: "ready", phase: "setup-ready", error: null, updatedAt: Date.now() }),
    });
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base");
      const prepared = await runtime.prepare({ mode: "isolated", sourceRoot: h.workspace, threadId: "thread-chain" });
      await h.workingStates.withStore("ws", "chain-baseline", async (store) => {
        await store.createBranch("ws", "thread-thread-chain", await store.captureDirectory(prepared.cwd), "zero-commit");
      });
      await fs.promises.writeFile(path.join(prepared.cwd, "a.txt"), "child result");
      const result = await h.workingStates.withStore("ws", "chain-publish", (store) => (
        store.publishDirectoryResult("thread-thread-chain", prepared.cwd)
      ));
      const snapshotted = await runtime.snapshot(prepared.worktree!);
      expect((await runtime.reclaim(snapshotted)).reclaimed).toBe(true);
      await h.coordinator.mergeResult({ workspaceId: "ws", threadId: "thread-chain", branchId: "thread-thread-chain", resultRevision: result.resultRevision });
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("child result");
      await h.workingStates.withStore("ws", "chain-reopen", (store) => (
        store.materializeResult("thread-thread-chain", result.resultRevision, prepared.cwd)
      ));
      expect(await fs.promises.readFile(path.join(prepared.cwd, "a.txt"), "utf8")).toBe("child result");
    } finally {
      await h.engine.dispose();
    }
  });

  it("integrates only base-to-selected-result changes and preserves unrelated parent files", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base\n");
      await fs.promises.writeFile(path.join(h.workspace, "delete.txt"), "remove\n");
      await fs.promises.writeFile(path.join(h.workspace, "binary.bin"), Buffer.from([0, 1, 2]));
      await fs.promises.writeFile(path.join(h.workspace, "script.sh"), "echo base\n", { mode: 0o644 });
      const child = path.join(h.root, "child");
      await fs.promises.cp(h.workspace, child, { recursive: true });
      await fs.promises.writeFile(path.join(child, "a.txt"), "result one\n");
      await fs.promises.rm(path.join(child, "delete.txt"));
      await fs.promises.writeFile(path.join(child, "binary.bin"), Buffer.from([0, 9, 2]));
      await fs.promises.chmod(path.join(child, "script.sh"), 0o755);
      const childMode = (await fs.promises.stat(path.join(child, "script.sh"))).mode & 0o777;
      let symlinkSupported = true;
      try {
        await fs.promises.symlink("a.txt", path.join(child, "link.txt"));
      } catch {
        symlinkSupported = false;
      }
      const first = await prepareResult(h, child);
      await fs.promises.writeFile(path.join(child, "a.txt"), "result two\n");
      const second = await h.workingStates.withStore("ws", "test-publish", (store) => store.publishDirectoryResult("thread-1", child));
      await fs.promises.writeFile(path.join(h.workspace, "parent-only.txt"), "keep me\n");

      const merged = await h.coordinator.mergeResult({ workspaceId: "ws", threadId: "thread-1", branchId: "thread-1", resultRevision: first.resultRevision });
      expect(merged.status).toBe("applied");
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("result one\n");
      expect(await fs.promises.stat(path.join(h.workspace, "delete.txt")).then(() => true, () => false)).toBe(false);
      expect(await fs.promises.readFile(path.join(h.workspace, "binary.bin"))).toEqual(Buffer.from([0, 9, 2]));
      expect((await fs.promises.stat(path.join(h.workspace, "script.sh"))).mode & 0o777).toBe(childMode);
      if (symlinkSupported) expect(await fs.promises.readlink(path.join(h.workspace, "link.txt"))).toBe("a.txt");
      expect(await fs.promises.readFile(path.join(h.workspace, "parent-only.txt"), "utf8")).toBe("keep me\n");
      expect(second.resultRevision).toBe(2);
      await h.workingStates.withStore("ws", "inspect-integration-journal", async (store, { database }) => {
        const row = database.prepare(`
          SELECT f.target_json AS target, f.safety_json AS safety
          FROM operation_files f JOIN operations o ON o.id = f.operation_id
          WHERE o.kind = 'integration' AND f.path = 'a.txt'
          ORDER BY o.created_at DESC LIMIT 1
        `).get() as { target: string; safety: string };
        const target = JSON.parse(row.target) as RecoveryState;
        const safety = JSON.parse(row.safety) as RecoveryState;
        expect(target.kind).toBe("regular-file");
        expect(safety.kind).toBe("regular-file");
        if (target.kind === "regular-file") expect(await store.getObject(target.objectHash)).not.toBeNull();
        if (safety.kind === "regular-file") expect(await store.getObject(safety.objectHash)).not.toBeNull();
      }, "shared");
    } finally {
      await h.engine.dispose();
    }
  });

  it("three-way merges parent edits and reports structural conflicts without overwriting them", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "text.txt"), "one\ntwo\nthree\n");
      await fs.promises.writeFile(path.join(h.workspace, "binary.bin"), Buffer.from([0, 1, 2]));
      const child = path.join(h.root, "child");
      await fs.promises.cp(h.workspace, child, { recursive: true });
      await fs.promises.writeFile(path.join(child, "text.txt"), "one\ntwo\nchild\n");
      await fs.promises.writeFile(path.join(child, "binary.bin"), Buffer.from([0, 9, 2]));
      const result = await prepareResult(h, child);
      await fs.promises.writeFile(path.join(h.workspace, "text.txt"), "parent\ntwo\nthree\n");
      await fs.promises.chmod(path.join(h.workspace, "text.txt"), 0o444);
      const parentMode = (await fs.promises.stat(path.join(h.workspace, "text.txt"))).mode & 0o777;
      await fs.promises.writeFile(path.join(h.workspace, "binary.bin"), Buffer.from([0, 8, 2]));

      const merged = await h.coordinator.mergeResult({ workspaceId: "ws", threadId: "thread-1", branchId: "thread-1", resultRevision: result.resultRevision });
      expect(merged.status).toBe("conflict");
      expect(merged.conflictPaths).toContain("binary.bin");
      expect(await fs.promises.readFile(path.join(h.workspace, "binary.bin"))).toEqual(Buffer.from([0, 8, 2]));
      expect(await fs.promises.readFile(path.join(h.workspace, "text.txt"), "utf8")).toContain("child");
      expect((await fs.promises.stat(path.join(h.workspace, "text.txt"))).mode & 0o777).toBe(parentMode);
    } finally {
      await h.engine.dispose();
    }
  });

  it("reuses a completed conflict operation when the same result and resulting parent state are retried", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "conflict.txt"), "base\n");
      const child = path.join(h.root, "child-conflict-retry");
      await fs.promises.cp(h.workspace, child, { recursive: true });
      await fs.promises.writeFile(path.join(child, "conflict.txt"), "child\n");
      const result = await prepareResult(h, child);
      await fs.promises.writeFile(path.join(h.workspace, "conflict.txt"), "parent\n");

      const first = await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-1",
        branchId: "thread-1",
        resultRevision: result.resultRevision,
      });
      const firstContent = await fs.promises.readFile(path.join(h.workspace, "conflict.txt"), "utf8");
      expect(first.status).toBe("conflict");
      expect(firstContent.match(/<<<<<<< parent/gu)).toHaveLength(1);

      const retried = await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-1",
        branchId: "thread-1",
        resultRevision: result.resultRevision,
      });
      expect(retried.status).toBe("conflict");
      expect(retried.operationId).toBe(first.operationId);
      expect(retried.appliedPaths).toEqual([]);
      expect(await fs.promises.readFile(path.join(h.workspace, "conflict.txt"), "utf8")).toBe(firstContent);

      await fs.promises.writeFile(path.join(h.workspace, "conflict.txt"), "parent changed after conflict\n");
      const replanned = await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-1",
        branchId: "thread-1",
        resultRevision: result.resultRevision,
      });
      expect(replanned.operationId).not.toBe(first.operationId);
    } finally {
      await h.engine.dispose();
    }
  });

  it("does not modify the user's Git index", async () => {
    const h = await createHarness();
    const git = (args: string[]) => execFileSync("git", args, { cwd: h.workspace, encoding: "utf8" });
    try {
      git(["init"]);
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "Test"]);
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base\n");
      await fs.promises.writeFile(path.join(h.workspace, "staged.txt"), "committed\n");
      git(["add", "-A"]);
      git(["commit", "-m", "base"]);
      const child = path.join(h.root, "child-index");
      await fs.promises.mkdir(child);
      await fs.promises.writeFile(path.join(child, "a.txt"), "child\n");
      await fs.promises.writeFile(path.join(child, "staged.txt"), "committed\n");
      const result = await prepareResult(h, child);
      await fs.promises.writeFile(path.join(h.workspace, "staged.txt"), "user staged\n");
      git(["add", "staged.txt"]);
      const before = git(["diff", "--cached", "--binary"]);

      await h.coordinator.mergeResult({ workspaceId: "ws", threadId: "thread-1", branchId: "thread-1", resultRevision: result.resultRevision });
      expect(git(["diff", "--cached", "--binary"])).toBe(before);
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("child\n");
    } finally {
      await h.engine.dispose();
    }
  });

  it("binds a completed integration into the active parent turn checkpoint", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base");
      const started = await h.engine.recordTurnStart({
        activeWriterScopes: [],
        executionId: "parent-execution",
        provenance: "caused-by",
        runtimeGeneration: 1,
        sessionId: "parent-session",
        userEntryId: "parent-user-entry",
        workerId: "parent-worker",
        workspaceId: "ws",
      });
      expect(started.status).toBe("ready");
      const child = path.join(h.root, "child-turn-binding");
      await fs.promises.mkdir(child);
      await fs.promises.writeFile(path.join(child, "a.txt"), "merged");
      const result = await prepareResult(h, child);
      await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-1",
        branchId: "thread-1",
        resultRevision: result.resultRevision,
        executionId: "parent-execution",
        requireTurnBinding: true,
      });
      const settled = await h.engine.recordTurnSettled({
        executionId: "parent-execution",
        workspaceId: "ws",
        activeWriterScopes: [],
        assistantEntryId: "parent-assistant-entry",
        mutationObserved: true,
        observationComplete: true,
        observedResourceIds: ["a.txt"],
        provenance: "caused-by",
      });
      expect(settled.status).toBe("ready");
      if (settled.status !== "ready") throw new Error("turn settlement failed");
      expect(settled.binding).toMatchObject({ status: "ready" });
      await h.engine.withWorkspaceStorage("ws", { mode: "shared", purpose: "inspect", create: false }, ({ database }) => {
        const row = database.prepare(`
          SELECT cc.tool_name, cc.before_json, cc.after_json
          FROM checkpoint_changes cc JOIN turn_bindings b ON b.checkpoint_id = cc.checkpoint_id
          WHERE b.execution_id = 'parent-execution' AND cc.path = 'a.txt'
        `).get() as { tool_name: string; before_json: string; after_json: string };
        expect(row.tool_name).toBe("thread.merge");
        expect(JSON.parse(row.before_json)).not.toEqual(JSON.parse(row.after_json));
      });
    } finally {
      await h.engine.dispose();
    }
  });

  it("validates the parent turn binding before reconciling an interrupted integration", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "integration-target");
      await h.workingStates.withStore("ws", "seed-bound-recovery", async (store, context) => {
        const target = (await context.fileStore.captureState(context.identity, context.root, "a.txt", { store: true })).state;
        const beforeObject = await store.putObject(Buffer.from("before"));
        const safety: RecoveryState = {
          kind: "regular-file",
          objectHash: beforeObject.hash,
          byteLength: beforeObject.byteLength,
          ...(target.kind === "regular-file" && target.mode !== undefined ? { mode: target.mode } : {}),
        };
        const targets = { "a.txt": { expected: safety, target } };
        const data = {
          operationId: "interrupted-before-binding-check",
          threadId: "thread-1",
          resultRevision: 1,
          targets,
          safety: { "a.txt": safety },
          conflictPaths: [],
          appliedPaths: ["a.txt"],
          compensatedPaths: [],
          needsAttentionPaths: [],
          diffStats: { files: 1, insertions: 1, deletions: 0 },
        };
        context.database.transaction(() => {
          writeOperationRow(context.database, {
            id: data.operationId,
            workspaceId: "ws",
            kind: "integration",
            state: "applying",
            data,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
          initOperationFiles(context.database, data.operationId, targets);
          updateOperationFilePhase(context.database, data.operationId, "a.txt", "target-observed", {
            safetyJson: JSON.stringify(safety),
          });
        }).immediate();
      });

      await expect(h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-1",
        branchId: "thread-1",
        resultRevision: 1,
        executionId: "missing-parent-execution",
        requireTurnBinding: true,
      })).rejects.toThrow("Parent turn recovery binding is unavailable");
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("integration-target");
      await h.engine.withWorkspaceStorage("ws", { mode: "shared", purpose: "inspect", create: false }, ({ database }) => {
        expect(database.prepare("SELECT state FROM operations WHERE id = ?").get("interrupted-before-binding-check"))
          .toEqual({ state: "applying" });
      });
    } finally {
      await h.engine.dispose();
    }
  });

  it("keeps working-state objects when recovery history is deleted", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base");
      const child = path.join(h.root, "child-retention");
      await fs.promises.mkdir(child);
      await fs.promises.writeFile(path.join(child, "a.txt"), "retained result");
      const result = await prepareResult(h, child);
      const merged = await h.coordinator.mergeResult({ workspaceId: "ws", threadId: "thread-1", branchId: "thread-1", resultRevision: result.resultRevision });
      const deleted = await h.engine.deleteWorkspaceHistory("ws");
      expect(deleted.status).toBe("ready");
      await h.workingStates.withStore("ws", "read-retained-result", async (store, { database }) => {
        const retained = store.getResult("thread-1", result.resultRevision);
        expect(retained).not.toBeNull();
        const state = retained!.pathStates["a.txt"]!;
        expect(state.kind).toBe("regular-file");
        if (state.kind === "regular-file") expect((await store.getObject(state.objectHash))?.toString()).toBe("retained result");
        expect(database.prepare("SELECT id FROM operations WHERE id = ?").get(merged.operationId)).toBeUndefined();
      }, "shared");
    } finally {
      await h.engine.dispose();
    }
  });

  it("refuses explicit history deletion while an integration still needs recovery", async () => {
    const h = await createHarness();
    try {
      await h.workingStates.withStore("ws", "seed-unfinished", (_store, { database }) => {
        writeOperationRow(database, { id: "unfinished-integration", workspaceId: "ws", kind: "integration", state: "applying", data: { operationId: "unfinished-integration" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      });
      const deleted = await h.engine.deleteWorkspaceHistory("ws");
      expect(deleted.status).toBe("failed");
      await h.engine.withWorkspaceStorage("ws", { mode: "shared", purpose: "inspect", create: false }, ({ database }) => {
        expect(database.prepare("SELECT state FROM operations WHERE id = ?").get("unfinished-integration")).toEqual({ state: "applying" });
      });
    } finally {
      await h.engine.dispose();
    }
  });

  it("conditionally compensates earlier paths when a later write fails", async () => {
    const native = createRecoveryFileStore();
    let applies = 0;
    const fileStore = { ...native, applyState: vi.fn(async (...args: Parameters<typeof native.applyState>) => {
      applies += 1;
      if (applies === 1) {
        const database = await openRecoveryJournalCatalog(args[1], { create: false });
        const rows = database?.prepare("SELECT phase, safety_json FROM operation_files ORDER BY ordinal").all() as Array<{ phase: string; safety_json: string | null }>;
        expect(rows.length).toBe(2);
        expect(rows.every((row) => row.phase === "apply-intent" && row.safety_json)).toBe(true);
        database?.close();
      }
      if (applies === 2) throw new Error("injected second-path failure");
      await native.applyState(...args);
    }) };
    const h = await createHarness(fileStore);
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "a-base");
      await fs.promises.writeFile(path.join(h.workspace, "b.txt"), "b-base");
      const child = path.join(h.root, "child");
      await fs.promises.cp(h.workspace, child, { recursive: true });
      await fs.promises.writeFile(path.join(child, "a.txt"), "a-child");
      await fs.promises.writeFile(path.join(child, "b.txt"), "b-child");
      const result = await prepareResult(h, child);
      const merged = await h.coordinator.mergeResult({ workspaceId: "ws", threadId: "thread-1", branchId: "thread-1", resultRevision: result.resultRevision });
      expect(merged.status).toBe("compensated");
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("a-base");
      expect(await fs.promises.readFile(path.join(h.workspace, "b.txt"), "utf8")).toBe("b-base");
      expect(h.documents.runResourceOperation).toHaveBeenCalledWith(
        "ws",
        [expect.objectContaining({ scope: "subtree" })],
        expect.any(Function),
      );
    } finally {
      await h.engine.dispose();
    }
  });

  it("preserves a later user edit when compensation no longer matches the integration target", async () => {
    const native = createRecoveryFileStore();
    let applies = 0;
    let workspace = "";
    const fileStore = { ...native, applyState: vi.fn(async (...args: Parameters<typeof native.applyState>) => {
      applies += 1;
      if (applies === 2) {
        await fs.promises.writeFile(path.join(workspace, "a.txt"), "user after integration");
        throw new Error("injected second-path failure");
      }
      await native.applyState(...args);
    }) };
    const h = await createHarness(fileStore);
    workspace = h.workspace;
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "a-base");
      await fs.promises.writeFile(path.join(h.workspace, "b.txt"), "b-base");
      const child = path.join(h.root, "child-user-edit");
      await fs.promises.cp(h.workspace, child, { recursive: true });
      await fs.promises.writeFile(path.join(child, "a.txt"), "a-child");
      await fs.promises.writeFile(path.join(child, "b.txt"), "b-child");
      const result = await prepareResult(h, child);
      const merged = await h.coordinator.mergeResult({ workspaceId: "ws", threadId: "thread-1", branchId: "thread-1", resultRevision: result.resultRevision });
      expect(merged.status).toBe("needs-attention");
      expect(merged.needsAttentionPaths).toContain("a.txt");
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("user after integration");
    } finally {
      await h.engine.dispose();
    }
  });

  it("queues a Documents save behind the final integration check and returns its original-revision conflict", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "piarium-integration-documents-gate-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    await fs.promises.mkdir(workspace, { recursive: true });
    const documents = createDocumentAuthority({
      hostId: "test",
      dataDir,
      isAllowedRoot: async () => true,
      isTrusted: async () => true,
    });
    const identity = await documents.resolveWorkspace({ path: workspace });
    const native = createRecoveryFileStore();
    let announceApply: (() => void) | undefined;
    let continueApply: (() => void) | undefined;
    const applyStarted = new Promise<void>((resolve) => { announceApply = resolve; });
    const applyRelease = new Promise<void>((resolve) => { continueApply = resolve; });
    const fileStore = {
      ...native,
      applyState: vi.fn(async (...args: Parameters<typeof native.applyState>) => {
        announceApply?.();
        await applyRelease;
        await native.applyState(...args);
      }),
    };
    const navigation: CreateWorkspaceRecoveryEngineOptions["sessionNavigation"] = {
      prepare: async () => ({ expectedLeafId: null, targetLeafId: null }),
      prepareLeaf: async () => ({ expectedLeafId: null, targetLeafId: null }),
      commit: async () => ({}),
      commitLeaf: async () => ({}),
    };
    const engine = createWorkspaceRecoveryEngine({
      authorityId: "test",
      dataDir,
      documents,
      fileStore,
      sessionNavigation: navigation,
    });
    try {
      await fs.promises.writeFile(path.join(workspace, "a.txt"), "base");
      const original = await documents.read({ workspaceId: identity.workspaceId, resourceId: "a.txt" });
      if (original.status !== "ready") throw new Error("Expected original document revision");
      const child = path.join(root, "child-documents-gate");
      await fs.promises.mkdir(child);
      await fs.promises.writeFile(path.join(child, "a.txt"), "child");
      const workingStates = createWorkspaceWorkingStateAccess(engine);
      const result = await workingStates.withStore(identity.workspaceId, "test-publish", async (store) => {
        await store.createBranch(identity.workspaceId, "thread-gated", await store.captureDirectory(workspace), "base");
        return store.publishDirectoryResult("thread-gated", child);
      });
      const coordinator = new IntegrationCoordinator({ workingStates });
      const merging = coordinator.mergeResult({
        workspaceId: identity.workspaceId,
        threadId: "thread-gated",
        branchId: "thread-gated",
        resultRevision: result.resultRevision,
      });
      await applyStarted;

      let saveSettled = false;
      const saving = documents.write({
        resource: { workspaceId: identity.workspaceId, resourceId: "a.txt" },
        token: { workspaceId: identity.workspaceId, epoch: identity.epoch, owner: { kind: "test", id: "user-save" } },
        content: "user content started after final check",
        encoding: "utf-8",
        bom: false,
        expectedRevision: original.revision,
      }).finally(() => { saveSettled = true; });
      await new Promise((resolve) => setImmediate(resolve));
      expect(saveSettled).toBe(false);

      continueApply?.();
      expect((await merging).status).toBe("applied");
      const save = await saving;
      expect(save.status).toBe("conflict");
      if (save.status === "conflict") {
        expect(save.current).toMatchObject({ status: "ready" });
        if (save.current.status === "ready") expect(save.current.revision).not.toBe(original.revision);
      }
      expect(await fs.promises.readFile(path.join(workspace, "a.txt"), "utf8")).toBe("child");
    } finally {
      continueApply?.();
      await Promise.allSettled([engine.dispose(), documents.dispose()]);
    }
  });

  it("compensates instead of reporting success when the final operation commit fails", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "before");
      const applied = await h.workingStates.withStore("ws", "final-commit-failure", async (store, context) => {
        const before = (await context.fileStore.captureState(context.identity, context.root, "a.txt", { store: true })).state;
        const object = await store.putObject(Buffer.from("target"));
        const target: RecoveryState = { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength, ...(before.kind === "regular-file" && before.mode !== undefined ? { mode: before.mode } : {}) };
        let operationWrites = 0;
        const database = new Proxy(context.database, {
          get(db, property) {
            if (property === "prepare") return (sql: string) => {
              const statement = db.prepare(sql);
              if (!sql.includes("INSERT INTO operations")) return statement;
              return new Proxy(statement, {
                get(targetStatement, statementProperty) {
                  if (statementProperty === "run") return (...args: unknown[]) => {
                    operationWrites += 1;
                    if (operationWrites === 2) throw new Error("injected final commit failure");
                    return targetStatement.run(...args);
                  };
                  const value = Reflect.get(targetStatement, statementProperty);
                  return typeof value === "function" ? value.bind(targetStatement) : value;
                },
              });
            };
            const value = Reflect.get(db, property);
            return typeof value === "function" ? value.bind(db) : value;
          },
        });
        return applyDurableFileOperation({ ...context, database }, {
          id: "final-commit-failure",
          workspaceId: "ws",
          threadId: "thread-1",
          resultRevision: 1,
          targets: { "a.txt": { expected: before, target } },
          conflictPaths: [],
          diffStats: { files: 1, insertions: 1, deletions: 0 },
        });
      });
      expect(applied.status).toBe("compensated");
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("before");
    } finally {
      await h.engine.dispose();
    }
  });

  it("recovers a failed final commit before replanning a retry that would otherwise look like a no-op", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base");
      const child = path.join(h.root, "child-final-retry");
      await fs.promises.mkdir(child);
      await fs.promises.writeFile(path.join(child, "a.txt"), "child");
      const result = await prepareResult(h, child);
      let operationWrites = 0;
      const flakyStates: WorkspaceWorkingStateAccess = {
        withStore: (workspaceId, purpose, operation, mode) => (
          h.workingStates.withStore(workspaceId, purpose, (store, context) => {
            const database = new Proxy(context.database, {
              get(db, property) {
                if (property === "prepare") return (sql: string) => {
                  const statement = db.prepare(sql);
                  if (!sql.includes("INSERT INTO operations")) return statement;
                  return new Proxy(statement, {
                    get(targetStatement, statementProperty) {
                      if (statementProperty === "run") return (...args: unknown[]) => {
                        operationWrites += 1;
                        if (operationWrites >= 2) throw new Error("persistent final commit failure");
                        return targetStatement.run(...args);
                      };
                      const value = Reflect.get(targetStatement, statementProperty);
                      return typeof value === "function" ? value.bind(targetStatement) : value;
                    },
                  });
                };
                const value = Reflect.get(db, property);
                return typeof value === "function" ? value.bind(db) : value;
              },
            });
            return operation(store, { ...context, database });
          }, mode)
        ),
      };
      const flakyCoordinator = new IntegrationCoordinator({ workingStates: flakyStates });
      await expect(flakyCoordinator.mergeResult({ workspaceId: "ws", threadId: "thread-1", branchId: "thread-1", resultRevision: result.resultRevision })).rejects.toThrow("compensation status could not be persisted");
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("base");

      const retry = await h.coordinator.mergeResult({ workspaceId: "ws", threadId: "thread-1", branchId: "thread-1", resultRevision: result.resultRevision });
      expect(retry.status).toBe("applied");
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("child");
    } finally {
      await h.engine.dispose();
    }
  });

  it("startup recovery uses the selected SQLite storage and restores exact regular/link/delete states", async () => {
    const h = await createHarness();
    let symlinkSupported = true;
    try {
      await fs.promises.writeFile(path.join(h.workspace, "regular.txt"), "before");
      await fs.promises.writeFile(path.join(h.workspace, "deleted.txt"), "restore me");
      try {
        await fs.promises.symlink("old-target", path.join(h.workspace, "link.txt"));
      } catch {
        symlinkSupported = false;
      }
      await h.workingStates.withStore("ws", "seed-crash", async (store, context) => {
        const regularBefore = (await context.fileStore.captureState(context.identity, context.root, "regular.txt", { store: true })).state;
        const deletedBefore = (await context.fileStore.captureState(context.identity, context.root, "deleted.txt", { store: true })).state;
        const regularObject = await store.putObject(Buffer.from("after"));
        const targets: Record<string, { expected: RecoveryState; target: RecoveryState }> = {
          "regular.txt": { expected: regularBefore, target: { kind: "regular-file", objectHash: regularObject.hash, byteLength: regularObject.byteLength, mode: regularBefore.kind === "regular-file" ? regularBefore.mode : undefined } },
          "deleted.txt": { expected: deletedBefore, target: { kind: "missing" } },
        };
        if (symlinkSupported) {
          const linkBefore = (await context.fileStore.captureState(context.identity, context.root, "link.txt", { store: true })).state;
          targets["link.txt"] = { expected: linkBefore, target: { kind: "symlink", symlinkTarget: "new-target" } };
        }
        const data = { operationId: "crashed-integration", threadId: "thread-1", resultRevision: 1, targets, safety: Object.fromEntries(Object.entries(targets).map(([file, states]) => [file, states.expected])), conflictPaths: [], appliedPaths: [], compensatedPaths: [], needsAttentionPaths: [], diffStats: { files: Object.keys(targets).length, insertions: 0, deletions: 0 } };
        context.database.transaction(() => {
          writeOperationRow(context.database, { id: "crashed-integration", workspaceId: "ws", kind: "integration", state: "applying", data, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
          initOperationFiles(context.database, "crashed-integration", targets);
          for (const [file, states] of Object.entries(targets)) updateOperationFilePhase(context.database, "crashed-integration", file, "apply-intent", { safetyJson: JSON.stringify(states.expected) });
        }).immediate();
        for (const [file, states] of Object.entries(targets)) await context.fileStore.applyState(context.identity, context.root, file, states.target);
      });
      await h.engine.dispose();

      const restarted = createWorkspaceRecoveryEngine({ authorityId: "test", dataDir: h.dataDir, documents: h.documents, sessionNavigation: h.navigation });
      await restarted.fenceUnfinishedOperations();
      expect(await fs.promises.readFile(path.join(h.workspace, "regular.txt"), "utf8")).toBe("before");
      expect(await fs.promises.readFile(path.join(h.workspace, "deleted.txt"), "utf8")).toBe("restore me");
      if (symlinkSupported) expect(await fs.promises.readlink(path.join(h.workspace, "link.txt"))).toBe("old-target");
      expect(h.documents.runResourceOperation).toHaveBeenCalledWith(
        "ws",
        [expect.objectContaining({ scope: "subtree" })],
        expect.any(Function),
      );
      await restarted.withWorkspaceStorage("ws", { mode: "shared", purpose: "inspect", create: false }, ({ database }) => {
        expect(database.prepare("SELECT state FROM operations WHERE id = ?").get("crashed-integration")).toEqual({ state: "compensated" });
      });
      await restarted.dispose();
    } finally {
      await h.engine.dispose();
    }
  });

  it("startup recovery leaves unexpected content untouched and marks needs-attention", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "before");
      await h.workingStates.withStore("ws", "seed-drift-crash", async (store, context) => {
        const before = (await context.fileStore.captureState(context.identity, context.root, "a.txt", { store: true })).state;
        const object = await store.putObject(Buffer.from("target"));
        const target: RecoveryState = { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength, ...(before.kind === "regular-file" && before.mode !== undefined ? { mode: before.mode } : {}) };
        const targets = { "a.txt": { expected: before, target } };
        const data = { operationId: "crashed-drift", threadId: "thread-1", resultRevision: 1, targets, safety: { "a.txt": before }, conflictPaths: [], appliedPaths: [], compensatedPaths: [], needsAttentionPaths: [], diffStats: { files: 1, insertions: 0, deletions: 0 } };
        context.database.transaction(() => {
          writeOperationRow(context.database, { id: "crashed-drift", workspaceId: "ws", kind: "integration", state: "applying", data, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
          initOperationFiles(context.database, "crashed-drift", targets);
          updateOperationFilePhase(context.database, "crashed-drift", "a.txt", "apply-intent", { safetyJson: JSON.stringify(before) });
        }).immediate();
        await context.fileStore.applyState(context.identity, context.root, "a.txt", target);
      });
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "external edit");
      await h.engine.dispose();
      const restarted = createWorkspaceRecoveryEngine({ authorityId: "test", dataDir: h.dataDir, documents: h.documents, sessionNavigation: h.navigation });
      await restarted.fenceUnfinishedOperations();
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("external edit");
      await restarted.withWorkspaceStorage("ws", { mode: "shared", purpose: "inspect", create: false }, ({ database }) => {
        expect(database.prepare("SELECT state FROM operations WHERE id = ?").get("crashed-drift")).toEqual({ state: "needs-attention" });
      });
      await restarted.dispose();
    } finally {
      await h.engine.dispose();
    }
  });

  it("startup recovery never reconciles another workspace's row in a shared catalog", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "workspace-one");
      await h.workingStates.withStore("ws", "seed-other-workspace", async (store, context) => {
        const current = (await context.fileStore.captureState(context.identity, context.root, "a.txt", { store: true })).state;
        const object = await store.putObject(Buffer.from("other-target"));
        const target: RecoveryState = { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength, ...(current.kind === "regular-file" && current.mode !== undefined ? { mode: current.mode } : {}) };
        const targets = { "a.txt": { expected: current, target } };
        const data = { operationId: "other-workspace-operation", threadId: "other-thread", resultRevision: 1, targets, safety: { "a.txt": current }, conflictPaths: [], appliedPaths: [], compensatedPaths: [], needsAttentionPaths: [], diffStats: { files: 1, insertions: 0, deletions: 0 } };
        writeOperationRow(context.database, { id: "other-workspace-operation", workspaceId: "other-workspace", kind: "integration", state: "applying", data, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        writeOperationRow(context.database, { id: "other-workspace-combined", workspaceId: "other-workspace", kind: "combined", state: "applying-files", data: { malformedForeignRecord: true }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        initOperationFiles(context.database, "other-workspace-operation", targets);
        updateOperationFilePhase(context.database, "other-workspace-operation", "a.txt", "apply-intent", { safetyJson: JSON.stringify(current) });
      });
      await h.engine.fenceUnfinishedOperations();
      await h.engine.withWorkspaceStorage("ws", { mode: "shared", purpose: "inspect", create: false }, ({ database }) => {
        expect(database.prepare("SELECT state FROM operations WHERE id = ?").get("other-workspace-operation")).toEqual({ state: "applying" });
        expect(database.prepare("SELECT state FROM operations WHERE id = ?").get("other-workspace-combined")).toEqual({ state: "applying-files" });
      });
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("workspace-one");
    } finally {
      await h.engine.dispose();
    }
  });
});
