import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createThreadRegistry } from "./thread-registry.js";
import { createThreadDispatchService, createThreadMergeService } from "./thread-services.js";
import type { AgentInputContext } from "@piarium/protocol";

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
  it("persists a starting Run and returns before worktree or child-session setup finishes", async () => {
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
    } as never);
    await expect(service.handle({ role: "hard-implement", task: "Use the draft" }, serviceContext({
      source: "surface",
      workspaceId: "workspace-1",
      dirtyPaths: ["draft.ts"],
      snapshot: { status: "ready", ref: "snapshot-ref" },
    }))).rejects.toThrow("catalog write failed");
    expect(cleanup).toHaveBeenCalledOnce();
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
    expect(result.text).toContain("left untouched on disk");
    expect(result.text).toContain("parent editor");
    expect(setIntegration).toHaveBeenCalledWith("workspace-1", "thread-1", "conflict", expect.anything());
  });
});
