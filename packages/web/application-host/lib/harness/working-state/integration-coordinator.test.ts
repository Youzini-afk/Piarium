import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWorkspaceRecoveryEngine, type CreateWorkspaceRecoveryEngineOptions } from "../../recovery/journal-engine.js";
import { createRecoveryFileStore } from "../../recovery/journal-files.js";
import { initOperationFiles, openRecoveryJournalCatalog, updateOperationFilePhase, writeOperationRow } from "../../recovery/journal-catalog.js";
import { createWorkspaceWorkingStateAccess, type WorkspaceWorkingStateAccess } from "./working-state-store.js";
import { IntegrationCoordinator } from "./integration-coordinator.js";
import type { RecoveryState } from "./types.js";
import { createThreadWorktreeRuntime } from "../thread-worktree.js";
import { applyDurableFileOperation, markDurableExternalDispatched } from "../../recovery/durable-file-operation.js";
import { createDocumentAuthority } from "../../documents/authority.js";

const roots: string[] = [];
const textHash = (text: string) => `sha256-${createHash("sha256").update(text).digest("hex")}`;
const dirtyPublication = (resourceId: string, content: string, localEditRevision = 1) => ({
  ownerId: "editor-a",
  generation: 1,
  registrationId: "registration-a",
  resources: [{
    resource: { resourceId },
    localEditRevision,
    baseRevision: "base",
    documentInstanceId: `document-${resourceId}`,
    bufferHash: textHash(content),
    encoding: "utf-8",
    bom: false,
    lineEnding: "lf" as const,
  }],
});

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
  it("does not apply a manual conflict resolution against a parent newer than the reviewed revision", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base\n");
      const child = path.join(h.root, "reviewed-child");
      await fs.promises.cp(h.workspace, child, { recursive: true });
      await fs.promises.writeFile(path.join(child, "a.txt"), "child\n");
      const result = await prepareResult(h, child);
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "parent at review\n");
      const input = { workspaceId: "ws", threadId: "thread-1", branchId: "thread-1", resultRevision: result.resultRevision };
      const preview = await h.coordinator.previewResult(input);
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "new user edit\n");
      await h.coordinator.mergeResult({
        ...input,
        expectedBindingFingerprint: preview.bindingFingerprint,
        resolutions: [{ path: "a.txt", choice: "text", text: "reviewed resolution\n", expectedParentRevision: preview.binding["a.txt"]!.revision }],
      }).catch(() => undefined);
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("new user edit\n");
    } finally {
      await h.engine.dispose();
    }
  });

  it("keeps a surface-only integration unfinished until the buffer application is confirmed", async () => {
    const h = await createHarness();
    let releaseApply: (() => void) | undefined;
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base\n");
      const child = path.join(h.root, "surface-child");
      await fs.promises.cp(h.workspace, child, { recursive: true });
      await fs.promises.writeFile(path.join(child, "a.txt"), "child\n");
      const result = await prepareResult(h, child);
      const applyGate = new Promise<void>((resolve) => { releaseApply = resolve; });
      let signalApplyStarted!: () => void;
      const applyStarted = new Promise<void>((resolve) => { signalApplyStarted = resolve; });
      const coordinator = new IntegrationCoordinator({
        workingStates: h.workingStates,
        inspectDirtyBuffers: async () => [dirtyPublication("a.txt", "base\n")],
        requestSurfaceOperation: async (request) => {
          if (request.action === "capture") return [{
            resource: { workspaceId: "ws", resourceId: "a.txt" }, status: "captured",
            documentInstanceId: "document-a.txt", beforeLocalEditRevision: 1,
            beforeHash: textHash("base\n"), content: "base\n",
          }];
          signalApplyStarted();
          await applyGate;
          return [{
            resource: { workspaceId: "ws", resourceId: "a.txt" }, status: "applied",
            documentInstanceId: "document-a.txt", beforeLocalEditRevision: 1,
            beforeHash: textHash("base\n"), afterLocalEditRevision: 2, afterHash: textHash("child\n"),
          }];
        },
      });
      const pending = coordinator.mergeResult({
        workspaceId: "ws", threadId: "thread-1", branchId: "thread-1", resultRevision: result.resultRevision,
      });
      let settled = false;
      void pending.finally(() => { settled = true; });
      await applyStarted;
      expect(settled).toBe(false);
      const catalogFiles = (await fs.promises.readdir(h.dataDir, { recursive: true }))
        .map(String)
        .filter((file) => file.replace(/\\/gu, "/").endsWith("/catalog.sqlite"));
      expect(catalogFiles).toHaveLength(1);
      const database = await openRecoveryJournalCatalog(path.dirname(path.join(h.dataDir, catalogFiles[0]!)), { create: false });
      if (!database) throw new Error("expected recovery catalog");
      expect(database.prepare("SELECT state FROM operations WHERE kind = 'integration' ORDER BY created_at DESC LIMIT 1").get())
        .toEqual({ state: "awaiting-surface" });
      database.close();
      releaseApply?.();
      const merged = await pending;
      expect(merged.status).toBe("applied");
      await h.workingStates.withStore("ws", "inspect-pending-surface", (_store, { database }) => {
        const operation = database.prepare("SELECT state FROM operations WHERE id = ?").get(merged.operationId) as { state: string };
        expect(operation.state).toBe("complete");
      });
    } finally {
      releaseApply?.();
      await h.engine.dispose();
    }
  });

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

  it("keeps an unsaved draft target off disk, then allows integration after the exact draft is saved", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "draft.txt"), "disk bytes\n");
      const child = path.join(h.root, "child-draft-target");
      await fs.promises.mkdir(child);
      await fs.promises.writeFile(path.join(child, "draft.txt"), "child bytes\n");
      const result = await h.workingStates.withStore("ws", "draft-target-result", async (store) => {
        const diskState = await store.captureDirectory(h.workspace);
        const object = await store.putObject(Buffer.from("unsaved draft\n"));
        const current = diskState["draft.txt"]!;
        const draftState: RecoveryState = {
          kind: "regular-file",
          objectHash: object.hash,
          byteLength: object.byteLength,
          ...(current.kind === "regular-file" && current.mode !== undefined ? { mode: current.mode } : {}),
        };
        await store.createBranch("ws", "thread-draft-target", { ...diskState, "draft.txt": draftState }, "base", ["draft.txt"]);
        return store.publishDirectoryResult("thread-draft-target", child);
      });
      expect(result.changedPaths).toEqual(["draft.txt"]);

      const blocked = await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-draft-target",
        branchId: "thread-draft-target",
        resultRevision: result.resultRevision,
      });
      expect(blocked).toMatchObject({
        status: "conflict",
        appliedPaths: [],
        conflictPaths: ["draft.txt"],
        surfaceTargetPaths: ["draft.txt"],
      });
      expect(await fs.promises.readFile(path.join(h.workspace, "draft.txt"), "utf8")).toBe("disk bytes\n");

      await fs.promises.writeFile(path.join(h.workspace, "draft.txt"), "unsaved draft\n");
      const saved = await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-draft-target",
        branchId: "thread-draft-target",
        resultRevision: result.resultRevision,
      });
      expect(saved).toMatchObject({ status: "applied", appliedPaths: ["draft.txt"], conflictPaths: [] });
      expect(await fs.promises.readFile(path.join(h.workspace, "draft.txt"), "utf8")).toBe("child bytes\n");

      const alreadyPresent = await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-draft-target",
        branchId: "thread-draft-target",
        resultRevision: result.resultRevision,
      });
      expect(alreadyPresent).toMatchObject({ status: "applied", appliedPaths: [], conflictPaths: [] });
      expect(alreadyPresent.surfaceTargetPaths).toBeUndefined();
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

  it("startup recovery never replays a dispatched surface target as disk and keeps the mixed operation visible", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "disk.txt"), "before");
      await h.workingStates.withStore("ws", "seed-surface-crash", async (store, context) => {
        const before = (await context.fileStore.captureState(context.identity, context.root, "disk.txt", { store: true })).state;
        const diskTargetObject = await store.putObject(Buffer.from("after"));
        const surfaceBeforeObject = await store.putObject(Buffer.from("surface before"));
        const surfaceTargetObject = await store.putObject(Buffer.from("surface after"));
        const diskTarget: RecoveryState = {
          kind: "regular-file", objectHash: diskTargetObject.hash, byteLength: diskTargetObject.byteLength,
          ...(before.kind === "regular-file" && before.mode !== undefined ? { mode: before.mode } : {}),
        };
        const surfaceBefore: RecoveryState = { kind: "regular-file", objectHash: surfaceBeforeObject.hash, byteLength: surfaceBeforeObject.byteLength };
        const surfaceTarget: RecoveryState = { kind: "regular-file", objectHash: surfaceTargetObject.hash, byteLength: surfaceTargetObject.byteLength };
        const pending = await applyDurableFileOperation(context, {
          id: "crashed-surface-integration", workspaceId: "ws", threadId: "thread-surface-crash", resultRevision: 1,
          targets: { "disk.txt": { expected: before, target: diskTarget } },
          externalTargets: { "surface.txt": { expected: surfaceBefore, target: surfaceTarget } },
          externalBindings: { "surface.txt": {
            ownerId: "surface", ownerGeneration: 1, ownerRegistrationId: "registration",
            documentInstanceId: "document", baseRevision: "base", beforeLocalEditRevision: 1,
            beforeHash: textHash("surface before"), encoding: "utf-8", bom: false, lineEnding: "lf",
          } },
          conflictPaths: [], diffStats: { files: 2, insertions: 2, deletions: 0 },
        });
        expect(pending.status).toBe("pending");
        markDurableExternalDispatched(context, pending.operationId, ["surface.txt"]);
      });
      await h.engine.dispose();
      const restarted = createWorkspaceRecoveryEngine({ authorityId: "test", dataDir: h.dataDir, documents: h.documents, sessionNavigation: h.navigation });
      await restarted.fenceUnfinishedOperations();
      expect(await fs.promises.readFile(path.join(h.workspace, "disk.txt"), "utf8")).toBe("after");
      await restarted.withWorkspaceStorage("ws", { mode: "shared", purpose: "inspect", create: false }, ({ database }) => {
        expect(database.prepare("SELECT state FROM operations WHERE id = ?").get("crashed-surface-integration"))
          .toEqual({ state: "needs-attention" });
        expect(database.prepare("SELECT phase FROM operation_files WHERE operation_id = ? AND path = ?").get("crashed-surface-integration", "surface.txt"))
          .toEqual({ phase: "needs-attention" });
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

  it("previews a clean disk result as merge-ready and invalidates after the parent changes", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base\n");
      const child = path.join(h.root, "child-preview");
      await fs.promises.mkdir(child);
      await fs.promises.writeFile(path.join(child, "a.txt"), "child\n");
      const result = await prepareResult(h, child);
      const first = await h.coordinator.previewResult({
        workspaceId: "ws",
        threadId: "thread-1",
        branchId: "thread-1",
        resultRevision: result.resultRevision,
      });
      expect(first.mergeReady).toBe(true);
      expect(first.valid).toBe(true);
      expect(first.paths[0]?.target).toBe("disk");
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "parent continued\n");
      expect(h.coordinator.invalidateWorkspace("ws", ["a.txt"])).toMatchObject([{
        threadId: "thread-1", valid: false, mergeReady: false,
      }]);
      const second = await h.coordinator.previewResult({
        workspaceId: "ws",
        threadId: "thread-1",
        branchId: "thread-1",
        resultRevision: result.resultRevision,
      });
      expect(second.bindingFingerprint).not.toBe(first.bindingFingerprint);
      expect(second.mergeReady).toBe(false);
      expect(second.conflictPaths).toContain("a.txt");
    } finally {
      await h.engine.dispose();
    }
  });

  it("applies a supplied editor buffer without writing disk and records the surface phase", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "draft.txt"), "disk bytes\n");
      const child = path.join(h.root, "child-surface");
      await fs.promises.mkdir(child);
      await fs.promises.writeFile(path.join(child, "draft.txt"), "child bytes\n");
      const result = await h.workingStates.withStore("ws", "surface-result", async (store) => {
        const diskState = await store.captureDirectory(h.workspace);
        const object = await store.putObject(Buffer.from("unsaved draft\n"));
        const current = diskState["draft.txt"]!;
        await store.createBranch("ws", "thread-surface", {
          ...diskState,
          "draft.txt": {
            kind: "regular-file",
            objectHash: object.hash,
            byteLength: object.byteLength,
            ...(current.kind === "regular-file" && current.mode !== undefined ? { mode: current.mode } : {}),
          },
        }, "base", ["draft.txt"]);
        return store.publishDirectoryResult("thread-surface", child);
      });
      const coordinator = new IntegrationCoordinator({
        workingStates: h.workingStates,
        inspectDirtyBuffers: async () => [dirtyPublication("draft.txt", "unsaved draft\n", 4)],
        requestSurfaceOperation: async (request) => {
          if (request.action === "capture") return [{
            resource: { workspaceId: "ws", resourceId: "draft.txt" }, status: "captured",
            documentInstanceId: "document-draft.txt", beforeLocalEditRevision: 4,
            beforeHash: textHash("unsaved draft\n"), content: "unsaved draft\n",
          }];
          if (request.action === "apply") return [{
            resource: { workspaceId: "ws", resourceId: "draft.txt" }, status: "applied",
            documentInstanceId: "document-draft.txt", beforeLocalEditRevision: 4,
            beforeHash: textHash("unsaved draft\n"), afterLocalEditRevision: 5,
            afterHash: textHash("child bytes\n"),
          }];
          throw new Error("unexpected undo");
        },
      });
      const merged = await coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-surface",
        branchId: "thread-surface",
        resultRevision: result.resultRevision,
      });
      expect(await fs.promises.readFile(path.join(h.workspace, "draft.txt"), "utf8")).toBe("disk bytes\n");
      expect(merged.preview?.mergeReady).toBe(true);
      await h.workingStates.withStore("ws", "inspect-surface-phase", (_store, { database }) => {
        const row = database.prepare("SELECT data_json FROM operations WHERE id = ?").get(merged.operationId) as { data_json: string };
        const data = JSON.parse(row.data_json) as { surfacePhases?: Record<string, string> };
        expect(data.surfacePhases?.["draft.txt"]).toBe("surface-applied");
      });
    } finally {
      await h.engine.dispose();
    }
  });

  it("compensates disk paths when the same operation's surface group explicitly rejects apply", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "disk.txt"), "disk base\n");
      await fs.promises.writeFile(path.join(h.workspace, "surface.txt"), "saved base\n");
      const child = path.join(h.root, "mixed-surface-child");
      await fs.promises.cp(h.workspace, child, { recursive: true });
      await fs.promises.writeFile(path.join(child, "disk.txt"), "disk child\n");
      await fs.promises.writeFile(path.join(child, "surface.txt"), "surface child\n");
      const result = await h.workingStates.withStore("ws", "mixed-surface-result", async (store) => {
        const base = await store.captureDirectory(h.workspace);
        const draft = await store.putObject(Buffer.from("surface draft\n"));
        const saved = base["surface.txt"]!;
        await store.createBranch("ws", "thread-mixed-surface", {
          ...base,
          "surface.txt": {
            kind: "regular-file", objectHash: draft.hash, byteLength: draft.byteLength,
            ...(saved.kind === "regular-file" && saved.mode !== undefined ? { mode: saved.mode } : {}),
          },
        }, "base", ["surface.txt"]);
        return store.publishDirectoryResult("thread-mixed-surface", child);
      });
      const coordinator = new IntegrationCoordinator({
        workingStates: h.workingStates,
        inspectDirtyBuffers: async () => [dirtyPublication("surface.txt", "surface draft\n", 2)],
        requestSurfaceOperation: async (request) => request.action === "capture" ? [{
          resource: { workspaceId: "ws", resourceId: "surface.txt" }, status: "captured",
          documentInstanceId: "document-surface.txt", beforeLocalEditRevision: 2,
          beforeHash: textHash("surface draft\n"), content: "surface draft\n",
        }] : [{
          resource: { workspaceId: "ws", resourceId: "surface.txt" }, status: "failed",
          documentInstanceId: "document-surface.txt", afterLocalEditRevision: 2,
          afterHash: textHash("surface draft\n"),
          message: "buffer changed before apply",
        }],
      });
      const merged = await coordinator.mergeResult({
        workspaceId: "ws", threadId: "thread-mixed-surface", branchId: "thread-mixed-surface",
        resultRevision: result.resultRevision,
      });
      expect(merged.status).toBe("compensated");
      expect(await fs.promises.readFile(path.join(h.workspace, "disk.txt"), "utf8")).toBe("disk base\n");
      expect(await fs.promises.readFile(path.join(h.workspace, "surface.txt"), "utf8")).toBe("saved base\n");
    } finally {
      await h.engine.dispose();
    }
  });

  it("undoes surface and disk targets as one conditional Integration operation", async () => {
    const h = await createHarness();
    let surfaceText = "surface draft\n";
    let surfaceRevision = 3;
    try {
      await fs.promises.writeFile(path.join(h.workspace, "disk.txt"), "disk base\n");
      await fs.promises.writeFile(path.join(h.workspace, "surface.txt"), "saved base\n");
      const child = path.join(h.root, "mixed-undo-child");
      await fs.promises.cp(h.workspace, child, { recursive: true });
      await fs.promises.writeFile(path.join(child, "disk.txt"), "disk child\n");
      await fs.promises.writeFile(path.join(child, "surface.txt"), "surface child\n");
      const result = await h.workingStates.withStore("ws", "mixed-undo-result", async (store) => {
        const base = await store.captureDirectory(h.workspace);
        const draft = await store.putObject(Buffer.from(surfaceText));
        const saved = base["surface.txt"]!;
        await store.createBranch("ws", "thread-mixed-undo", {
          ...base,
          "surface.txt": {
            kind: "regular-file", objectHash: draft.hash, byteLength: draft.byteLength,
            ...(saved.kind === "regular-file" && saved.mode !== undefined ? { mode: saved.mode } : {}),
          },
        }, "base", ["surface.txt"]);
        return store.publishDirectoryResult("thread-mixed-undo", child);
      });
      const coordinator = new IntegrationCoordinator({
        workingStates: h.workingStates,
        inspectDirtyBuffers: async () => [dirtyPublication("surface.txt", surfaceText, surfaceRevision)],
        requestSurfaceOperation: async (request) => {
          if (request.action === "capture") return [{
            resource: { workspaceId: "ws", resourceId: "surface.txt" }, status: "captured",
            documentInstanceId: "document-surface.txt", beforeLocalEditRevision: surfaceRevision,
            beforeHash: textHash(surfaceText), content: surfaceText,
          }];
          if (request.action === "apply") {
            const before = surfaceText;
            surfaceText = request.targets[0]!.newText!;
            const beforeRevision = surfaceRevision++;
            return [{
              resource: { workspaceId: "ws", resourceId: "surface.txt" }, status: "applied",
              documentInstanceId: "document-surface.txt", beforeLocalEditRevision: beforeRevision,
              beforeHash: textHash(before), afterLocalEditRevision: surfaceRevision, afterHash: textHash(surfaceText),
            }];
          }
          surfaceText = "surface draft\n";
          surfaceRevision += 1;
          return [{
            resource: { workspaceId: "ws", resourceId: "surface.txt" }, status: "undone",
            documentInstanceId: "document-surface.txt", afterLocalEditRevision: surfaceRevision,
            afterHash: textHash(surfaceText),
          }];
        },
      });
      const merged = await coordinator.mergeResult({
        workspaceId: "ws", threadId: "thread-mixed-undo", branchId: "thread-mixed-undo",
        resultRevision: result.resultRevision,
      });
      expect(merged.status).toBe("applied");
      expect(await fs.promises.readFile(path.join(h.workspace, "disk.txt"), "utf8")).toBe("disk child\n");
      expect(surfaceText).toBe("surface child\n");
      const undone = await coordinator.undoIntegration({
        workspaceId: "ws", threadId: "thread-mixed-undo", operationId: merged.operationId,
        sourceOwner: { ownerId: "editor-a", generation: 1 },
      });
      expect(undone.status).toBe("compensated");
      expect(await fs.promises.readFile(path.join(h.workspace, "disk.txt"), "utf8")).toBe("disk base\n");
      expect(surfaceText).toBe("surface draft\n");
    } finally {
      await h.engine.dispose();
    }
  });

  it("normalizes a UTF-8 BOM and CRLF draft for surface merge while preserving its editor format binding", async () => {
    const h = await createHarness();
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    try {
      await fs.promises.writeFile(path.join(h.workspace, "draft-crlf.txt"), "saved\r\n");
      const child = path.join(h.root, "surface-crlf-child");
      await fs.promises.mkdir(child);
      await fs.promises.writeFile(path.join(child, "draft-crlf.txt"), Buffer.concat([bom, Buffer.from("child\r\n")]));
      const result = await h.workingStates.withStore("ws", "surface-crlf-result", async (store) => {
        const disk = await store.captureDirectory(h.workspace);
        const draft = await store.putObject(Buffer.concat([bom, Buffer.from("base\r\n")]));
        const current = disk["draft-crlf.txt"]!;
        await store.createBranch("ws", "thread-surface-crlf", {
          ...disk,
          "draft-crlf.txt": {
            kind: "regular-file", objectHash: draft.hash, byteLength: draft.byteLength,
            ...(current.kind === "regular-file" && current.mode !== undefined ? { mode: current.mode } : {}),
          },
        }, "base", ["draft-crlf.txt"]);
        return store.publishDirectoryResult("thread-surface-crlf", child);
      });
      let appliedText: string | undefined;
      const basePublication = dirtyPublication("draft-crlf.txt", "base\n", 6);
      const publication = {
        ...basePublication,
        resources: [{ ...basePublication.resources[0]!, bom: true, lineEnding: "crlf" as const }],
      };
      const coordinator = new IntegrationCoordinator({
        workingStates: h.workingStates,
        inspectDirtyBuffers: async () => [publication],
        requestSurfaceOperation: async (request) => {
          if (request.action === "capture") return [{
            resource: { workspaceId: "ws", resourceId: "draft-crlf.txt" }, status: "captured",
            documentInstanceId: "document-draft-crlf.txt", beforeLocalEditRevision: 6,
            beforeHash: textHash("base\n"), content: "base\n",
          }];
          appliedText = request.targets[0]?.newText;
          return [{
            resource: { workspaceId: "ws", resourceId: "draft-crlf.txt" }, status: "applied",
            documentInstanceId: "document-draft-crlf.txt", beforeLocalEditRevision: 6,
            beforeHash: textHash("base\n"), afterLocalEditRevision: 7, afterHash: textHash("child\n"),
          }];
        },
      });
      const merged = await coordinator.mergeResult({
        workspaceId: "ws", threadId: "thread-surface-crlf", branchId: "thread-surface-crlf",
        resultRevision: result.resultRevision,
      });
      expect(merged.status).toBe("applied");
      expect(appliedText).toBe("child\n");
      expect(merged.preview?.binding["draft-crlf.txt"]).toMatchObject({ bom: true, lineEnding: "crlf" });
      expect(await fs.promises.readFile(path.join(h.workspace, "draft-crlf.txt"), "utf8")).toBe("saved\r\n");
    } finally {
      await h.engine.dispose();
    }
  });

  it("classifies a live dirty publication as a surface target even after the draft is saved on disk", async () => {
    const h = await createHarness();
    const coordinator = new IntegrationCoordinator({
      workingStates: h.workingStates,
      inspectDirtyBuffers: async () => [dirtyPublication("live.txt", "saved disk\n", 3)],
      requestSurfaceOperation: async () => [{
        resource: { workspaceId: "ws", resourceId: "live.txt" }, status: "captured",
        documentInstanceId: "document-live.txt", beforeLocalEditRevision: 3,
        beforeHash: textHash("saved disk\n"), content: "saved disk\n",
      }],
    });
    try {
      await fs.promises.writeFile(path.join(h.workspace, "live.txt"), "saved disk\n");
      const child = path.join(h.root, "child-live");
      await fs.promises.mkdir(child);
      await fs.promises.writeFile(path.join(child, "live.txt"), "child\n");
      const result = await prepareResult(h, child, "thread-live");
      const preview = await coordinator.previewResult({
        workspaceId: "ws",
        threadId: "thread-live",
        branchId: "thread-live",
        resultRevision: result.resultRevision,
      });
      expect(preview.mergeReady).toBe(true);
      expect(preview.surfaceTargetPaths).toEqual(["live.txt"]);
      expect(preview.paths[0]?.target).toBe("surface");
    } finally {
      await h.engine.dispose();
    }
  });

  it("does not fall back to disk when the turn's explicit draft owner is disconnected", async () => {
    const h = await createHarness();
    const coordinator = new IntegrationCoordinator({
      workingStates: h.workingStates,
      inspectDirtyBuffers: async () => [],
    });
    try {
      await fs.promises.writeFile(path.join(h.workspace, "draft.txt"), "saved baseline\n");
      const child = path.join(h.root, "child-disconnected-owner");
      await fs.promises.mkdir(child);
      await fs.promises.writeFile(path.join(child, "draft.txt"), "child\n");
      const result = await h.workingStates.withStore("ws", "disconnected-owner-result", async (store) => {
        const base = await store.captureDirectory(h.workspace);
        await store.createBranch("ws", "thread-disconnected-owner", base, "base", ["draft.txt"]);
        return store.publishDirectoryResult("thread-disconnected-owner", child);
      });
      const preview = await coordinator.previewResult({
        workspaceId: "ws",
        threadId: "thread-disconnected-owner",
        branchId: "thread-disconnected-owner",
        resultRevision: result.resultRevision,
        sourceOwner: { ownerId: "disconnected-editor", generation: 4 },
      });
      expect(preview.mergeReady).toBe(false);
      expect(preview.unavailablePaths).toEqual(["draft.txt"]);
      expect(preview.paths[0]?.target).toBe("unavailable");
      expect(await fs.promises.readFile(path.join(h.workspace, "draft.txt"), "utf8")).toBe("saved baseline\n");
    } finally {
      await h.engine.dispose();
    }
  });

  it("applies a virtual new file that omitted mode onto the workspace", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "kept.txt"), "base\n");
      const result = await h.workingStates.withStore("ws", "virtual-new-file", async (store) => {
        await store.createBranch("ws", "thread-virtual-new", await store.captureDirectory(h.workspace), "base");
        const object = await store.putObject(Buffer.from("added by virtual write\n"));
        expect(await store.commitVirtualWrite("thread-virtual-new", 0, "added.txt", {
          kind: "regular-file",
          objectHash: object.hash,
          byteLength: object.byteLength,
        })).toMatchObject({ status: "committed" });
        return store.publishHeadResult("thread-virtual-new");
      });
      const merged = await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-virtual-new",
        branchId: "thread-virtual-new",
        resultRevision: result.resultRevision,
      });
      expect(merged).toMatchObject({ status: "applied" });
      expect(merged.appliedPaths).toEqual(["added.txt"]);
      expect(await fs.promises.readFile(path.join(h.workspace, "added.txt"), "utf8")).toBe("added by virtual write\n");
      expect(await fs.promises.readFile(path.join(h.workspace, "kept.txt"), "utf8")).toBe("base\n");
      const added = path.join(h.workspace, "added.txt");
      const beforeMode = (await fs.promises.lstat(added)).mode & 0o7777;
      await fs.promises.chmod(added, beforeMode ^ 0o111);
      const afterMode = (await fs.promises.lstat(added)).mode & 0o7777;
      if (afterMode === beforeMode) return;
      const undone = await h.coordinator.undoIntegration({
        workspaceId: "ws",
        threadId: "thread-virtual-new",
        operationId: merged.operationId,
      });
      expect(undone.status).toBe("needs-attention");
    } finally {
      await h.engine.dispose();
    }
  });

  it("applies a materialized parent directory without writing recovery objects into that directory", async () => {
    const h = await createHarness();
    const parentDir = path.join(h.root, "parent-worktree");
    try {
      await fs.promises.mkdir(parentDir, { recursive: true });
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "parent\n");
      await fs.promises.writeFile(path.join(parentDir, "a.txt"), "parent\n");
      const child = path.join(h.root, "dir-child");
      await fs.promises.cp(h.workspace, child, { recursive: true });
      await fs.promises.writeFile(path.join(child, "a.txt"), "grandchild\n");
      const result = await prepareResult(h, child);
      const merged = await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-1",
        branchId: "thread-1",
        resultRevision: result.resultRevision,
        parentAuthority: { kind: "directory", directory: parentDir, workspaceId: "parent-exec" },
      });
      expect(merged).toMatchObject({ status: "applied", appliedPaths: ["a.txt"] });
      expect(await fs.promises.readFile(path.join(parentDir, "a.txt"), "utf8")).toBe("grandchild\n");
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("parent\n");
      expect(await fs.promises.stat(path.join(parentDir, ".piarium")).then(() => true, () => false)).toBe(false);
      const parentListing = await fs.promises.readdir(parentDir, { recursive: true });
      expect(parentListing.some((entry) => String(entry).includes("staging") || String(entry).includes("objects"))).toBe(false);
    } finally {
      await h.engine.dispose();
    }
  });

  it("persists a branch parent integration so retry is idempotent and undo is reversible", async () => {
    const h = await createHarness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "kept.txt"), "base\n");
      const published = await h.workingStates.withStore("ws", "branch-parent-setup", async (store) => {
        const captured = await store.captureDirectory(h.workspace);
        await store.createBranch("ws", "thread-parent", captured, "base");
        await store.createBranch("ws", "thread-child", captured, "base");
        const object = await store.putObject(Buffer.from("from-child\n"));
        await store.commitVirtualWrites("thread-child", 0, {
          "child.txt": { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength },
        });
        return store.publishHeadResult("thread-child");
      });
      const first = await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-child",
        branchId: "thread-child",
        resultRevision: published.resultRevision,
        parentAuthority: { kind: "branch", branchId: "thread-parent" },
      });
      expect(first).toMatchObject({ status: "applied", appliedPaths: ["child.txt"] });
      const rows = await h.workingStates.withStore("ws", "inspect-branch-integration", async (_store, context) => (
        context.database.prepare(`SELECT id, state FROM operations WHERE kind = 'integration'`).all() as Array<{ id: string; state: string }>
      ), "shared");
      expect(rows).toEqual([{ id: first.operationId, state: "complete" }]);
      const retry = await h.coordinator.mergeResult({
        workspaceId: "ws",
        threadId: "thread-child",
        branchId: "thread-child",
        resultRevision: published.resultRevision,
        parentAuthority: { kind: "branch", branchId: "thread-parent" },
      });
      expect(retry.operationId).toBe(first.operationId);
      expect(retry.status).toBe("applied");
      await h.workingStates.withStore("ws", "assert-parent-has-child", async (store) => {
        const live = store.effectiveState("thread-parent")!;
        const childFile = live["child.txt"];
        if (childFile?.kind !== "regular-file") throw new Error("expected child file on parent");
        expect(await store.getObject(childFile.objectHash)).toEqual(Buffer.from("from-child\n"));
      }, "shared");
      const undone = await h.coordinator.undoIntegration({
        workspaceId: "ws",
        threadId: "thread-child",
        operationId: first.operationId,
      });
      expect(undone.status).toBe("compensated");
      await h.workingStates.withStore("ws", "assert-parent-restored", async (store) => {
        const live = store.effectiveState("thread-parent")!;
        expect(live["child.txt"] ?? { kind: "missing" }).toEqual({ kind: "missing" });
      }, "shared");
    } finally {
      await h.engine.dispose();
    }
  });
});
