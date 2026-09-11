import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createThreadRegistry } from "./thread-registry.js";
import { createThreadDispatchService, createThreadMergeService } from "./thread-services.js";
import type { AgentInputContext } from "@piarium/protocol";

const prepareIsolatedBranch = vi.fn(async () => ({
  branchId: "thread-baseline",
  worktree: { path: "/tmp/scratch", base: "zero-commit", viewMode: "virtual" as const, materialized: false, preparationStage: "ready" as const },
}));

const serviceContext = (inputContext?: AgentInputContext) => ({
  actor: {
    authorityInstanceId: "authority-1",
    grantedCapabilities: ["control.thread" as const],
    sessionId: "parent-1",
    workerGeneration: 1,
    workerId: "worker-1",
    workspaceId: "workspace-1",
  },
  authorizedPaths: [],
  sessionId: "parent-1",
  signal: new AbortController().signal,
  workspaceId: "workspace-1",
  ...(inputContext ? { inputContext } : {}),
});

describe("thread services", () => {
  beforeEach(() => {
    prepareIsolatedBranch.mockClear();
  });

  it("persists a starting Run and returns before child-session setup finishes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-dispatch-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    let markSpawnStarted!: () => void;
    const spawnStarted = new Promise<void>((resolve) => { markSpawnStarted = resolve; });
    const neverFinishes = new Promise<{ sessionId: string }>(() => {});
    const spawn = vi.fn(async () => {
      markSpawnStarted();
      return neverFinishes;
    });
    const service = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: spawn,
      threadPrepareIsolatedBranch: prepareIsolatedBranch,
    } as never);

    try {
      const result = await service.handle({
        concurrency: 1,
        role: "hard-implement",
        task: "Implement the vertical slice",
        model: { providerId: "openai", modelId: "gpt-test" },
      }, {
        actor: {
          authorityInstanceId: "authority-1",
          grantedCapabilities: ["control.thread"],
          sessionId: "parent-1",
          workerGeneration: 1,
          workerId: "worker-1",
          workspaceId: "workspace-1",
        },
        authorizedPaths: [],
        sessionId: "parent-1",
        signal: new AbortController().signal,
        workspaceId: "workspace-1",
      });
      await spawnStarted;

      expect(result.queued).toBe(false);
      expect(prepareIsolatedBranch).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledOnce();
      expect(await registry.getActiveRun("workspace-1", result.threadId)).toMatchObject({
        workerState: "starting",
        outcome: null,
      });
      const queued = await service.handle({
        concurrency: 1,
        role: "hard-implement",
        task: "Wait for the slot",
        model: { providerId: "openai", modelId: "gpt-test" },
      }, {
        actor: {
          authorityInstanceId: "authority-1",
          grantedCapabilities: ["control.thread"],
          sessionId: "parent-1",
          workerGeneration: 1,
          workerId: "worker-1",
          workspaceId: "workspace-1",
        },
        authorizedPaths: [],
        sessionId: "parent-1",
        signal: new AbortController().signal,
        workspaceId: "workspace-1",
      });
      expect(queued.queued).toBe(true);
      expect(prepareIsolatedBranch).toHaveBeenCalledTimes(2);
      expect(spawn).toHaveBeenCalledOnce();
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it.each(["quick-implement", "retrieval"])("promotes %s to an isolated launch when dirty drafts are captured", async (role) => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-draft-dispatch-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const spawn = vi.fn(async () => ({ sessionId: "child" }));
    const capture = vi.fn(async () => ({ draftBaselineId: "draft-fixed", cleanup: async () => undefined }));
    const service = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: spawn,
      threadCaptureDraftBaseline: capture,
      threadPrepareIsolatedBranch: prepareIsolatedBranch,
    } as never);
    const inputContext: AgentInputContext = {
      source: "surface",
      workspaceId: "workspace-1",
      dirtyPaths: ["draft.ts"],
      snapshot: { status: "ready", ref: "snapshot-ref" },
    };
    try {
      const result = await service.handle({ role, task: "Use the draft" }, serviceContext(inputContext));
      const thread = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, result.threadId);
      expect(thread?.manifest).toMatchObject({ draftBaselineId: "draft-fixed", worktree: "isolated" });
      expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ draftBaselineId: "draft-fixed", worktree: "isolated" }));
      expect(capture).toHaveBeenCalledWith("parent-1", "workspace-1", inputContext);
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("records a failed Run when draft baseline materialization rejects", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-draft-spawn-failure-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const service = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: vi.fn(async () => { throw new Error("draft materialization failed"); }),
      threadCaptureDraftBaseline: vi.fn(async () => ({ draftBaselineId: "draft-fixed", cleanup: async () => undefined })),
      threadPrepareIsolatedBranch: prepareIsolatedBranch,
    } as never);
    try {
      const result = await service.handle({ role: "hard-implement", task: "Use the draft" }, serviceContext({
        source: "surface",
        workspaceId: "workspace-1",
        dirtyPaths: ["draft.ts"],
        snapshot: { status: "ready", ref: "snapshot-ref" },
      }));
      await vi.waitFor(async () => {
        expect(await registry.getActiveRun("workspace-1", result.threadId)).toMatchObject({
          outcome: "failure",
          workerState: "exited",
          exitReason: "draft materialization failed",
        });
      });
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("does not create a thread when a dirty surface snapshot is unavailable", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-draft-unavailable-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const service = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: vi.fn(),
      threadCaptureDraftBaseline: vi.fn(async () => { throw new Error("snapshot expired"); }),
      threadPrepareIsolatedBranch: prepareIsolatedBranch,
    } as never);
    try {
      await expect(service.handle({ role: "hard-implement", task: "Use the draft" }, serviceContext({
        source: "surface",
        workspaceId: "workspace-1",
        dirtyPaths: ["draft.ts"],
        snapshot: { status: "unavailable", reason: "surface-unavailable" },
      }))).rejects.toMatchObject({ harnessCode: "unavailable" });
      expect(await registry.listThreads("workspace-1", { kind: "session", id: "parent-1" })).toEqual([]);
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("keeps the role worktree policy for a validated empty surface snapshot", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-empty-surface-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const capture = vi.fn(async () => ({ draftBaselineId: null, cleanup: async () => undefined }));
    const service = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: vi.fn(async () => ({ sessionId: "child" })),
      threadCaptureDraftBaseline: capture,
      threadPrepareIsolatedBranch: prepareIsolatedBranch,
    } as never);
    try {
      const result = await service.handle({ role: "retrieval", task: "Inspect state" }, serviceContext({
        source: "surface",
        workspaceId: "workspace-1",
        dirtyPaths: [],
        snapshot: { status: "ready", ref: "empty-snapshot" },
      }));
      const thread = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, result.threadId);
      expect(thread?.manifest).toMatchObject({ draftBaselineId: null, worktree: "none" });
      expect(capture).toHaveBeenCalledOnce();
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("cleans a captured draft baseline when Thread creation fails", async () => {
    const cleanup = vi.fn(async () => undefined);
    const service = createThreadDispatchService({
      threadRegistry: {
        maxConcurrency: 12,
        countActive: vi.fn(async () => 0),
        createThread: vi.fn(async () => { throw new Error("catalog write failed"); }),
      },
      threadSpawnSession: vi.fn(),
      threadCaptureDraftBaseline: vi.fn(async () => ({ draftBaselineId: "draft-orphan", cleanup })),
      threadPrepareIsolatedBranch: prepareIsolatedBranch,
    } as never);
    await expect(service.handle({ role: "hard-implement", task: "Use the draft" }, serviceContext({
      source: "surface",
      workspaceId: "workspace-1",
      dirtyPaths: ["draft.ts"],
      snapshot: { status: "ready", ref: "snapshot-ref" },
    }))).rejects.toThrow("catalog write failed");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("deletes the Thread when isolated baseline capture fails", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-baseline-fail-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const spawn = vi.fn(async () => ({ sessionId: "child" }));
    const service = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: spawn,
      threadPrepareIsolatedBranch: vi.fn(async () => {
        throw new Error("baseline capture incomplete");
      }),
    } as never);
    try {
      await expect(service.handle({
        concurrency: 1,
        role: "hard-implement",
        task: "Capture must finish",
      }, serviceContext())).rejects.toMatchObject({ harnessCode: "unavailable" });
      expect(spawn).not.toHaveBeenCalled();
      expect(await registry.listThreads("workspace-1", { kind: "session", id: "parent-1" })).toEqual([]);
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("identifies editor-surface conflicts without implying that their disk paths were written", async () => {
    const setIntegration = vi.fn(async () => null);
    const service = createThreadMergeService({
      threadRegistry: {
        getThread: vi.fn(async () => ({
          id: "thread-1",
          integration: "merge-ready",
          lifecycle: "settled",
          mergedResultRevision: undefined,
          resultRevision: 1,
          workBranchId: "branch-1",
          worktree: null,
        })),
        getActiveRun: vi.fn(async () => ({ outcome: "success" })),
        setIntegration,
      },
      threadApplyWorktreeDiff: vi.fn(async () => ({
        merged: 0,
        conflicts: ["draft.ts"],
        surfaceTargetPaths: ["draft.ts"],
        status: "conflict",
        appliedPaths: [],
        resultRevision: 1,
        operationId: "integration-1",
        diffStats: { files: 1, insertions: 0, deletions: 0 },
      })),
    } as never);

    const result = await service.handle({ threadId: "thread-1" }, serviceContext());
    expect(result).toMatchObject({
      conflicts: ["draft.ts"],
      merged: 0,
      status: "conflict",
      surfaceTargetPaths: ["draft.ts"],
    });
    expect(result.text).toContain("Editor draft paths still require attention");
    expect(result.text).toContain("originating surface");
    expect(setIntegration).toHaveBeenCalledWith("workspace-1", "thread-1", "conflict", expect.anything());
  });

  it("uses the originating owner and tells the agent that applied drafts remain unsaved", async () => {
    const apply = vi.fn(async () => ({
      merged: 1, conflicts: [], status: "applied", appliedPaths: ["draft.ts"], changedFiles: ["draft.ts"],
      resultRevision: 1, operationId: "integration-1",
      preview: { paths: [{ path: "draft.ts", target: "surface", phase: "surface-applied" }] },
    }));
    const owner = vi.fn(() => ({ ownerId: "originating-editor", generation: 2, workspaceId: "workspace-1" }));
    const service = createThreadMergeService({
      threadRegistry: {
        getThread: async () => ({
          id: "thread-1", integration: "merge-ready", lifecycle: "settled", resultRevision: 1,
          workBranchId: "branch-1", worktree: null,
        }),
        getActiveRun: async () => ({ outcome: "success" }),
      },
      agentInputSurfaceOwner: owner,
      threadApplyWorktreeDiff: apply,
    } as never);
    const ctx = serviceContext({ source: "surface", workspaceId: "workspace-1", dirtyPaths: ["draft.ts"], snapshot: { status: "ready", ref: "source-ref" } });
    const result = await service.handle({ threadId: "thread-1" }, ctx);
    expect(owner).toHaveBeenCalledWith("parent-1", ctx.inputContext);
    expect(apply).toHaveBeenCalledWith("workspace-1", { kind: "session", id: "parent-1" }, "thread-1", undefined, undefined, {
      sourceOwner: { ownerId: "originating-editor", generation: 2 }, signal: ctx.signal,
    });
    expect(result.surfaceTargetPaths).toEqual(["draft.ts"]);
    expect(result.text).toContain("Editor drafts updated without saving: draft.ts");
    expect(result.text).toContain("Disk-based commands still read the saved files");
  });
});
