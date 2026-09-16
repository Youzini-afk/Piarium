import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createThreadRegistry } from "./thread-registry.js";
import { createThreadDispatchService, createThreadKillService, createThreadMergeService, createThreadSendService, createThreadWaitService } from "./thread-services.js";
import { createThreadRuntime, ThreadRuntimeError } from "./thread-runtime.js";
import type { AgentInputContext, SessionEntriesResult, SessionSnapshot, SessionStats, SessionSummary } from "@piarium/protocol";

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
        preset: "hard-implement",
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
        preset: "hard-implement",
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

  it.each(["quick-implement", "retrieval"])("promotes %s to an isolated launch when dirty drafts are captured", async (preset) => {
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
      const result = await service.handle(
        preset === "retrieval"
          ? { preset, task: "Use the draft", model: { providerId: "anthropic", modelId: "haiku" } }
          : { preset, task: "Use the draft" },
        serviceContext(inputContext),
      );
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
      const result = await service.handle({ preset: "hard-implement", task: "Use the draft" }, serviceContext({
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
      await expect(service.handle({ preset: "hard-implement", task: "Use the draft" }, serviceContext({
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

  it("keeps the preset worktree policy for a validated empty surface snapshot", async () => {
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
      const result = await service.handle({
        preset: "retrieval",
        task: "Inspect state",
        model: { providerId: "anthropic", modelId: "haiku" },
      }, serviceContext({
        source: "surface",
        workspaceId: "workspace-1",
        dirtyPaths: [],
        snapshot: { status: "ready", ref: "empty-snapshot" },
      }));
      const thread = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, result.threadId);
      expect(thread?.manifest).toMatchObject({
        draftBaselineId: null,
        worktree: "none",
        carryBlocks: false,
        tools: expect.arrayContaining(["submit_facts", "explore", "read"]),
      });
      expect(thread?.manifest.tools).not.toEqual(expect.arrayContaining(["bash", "edit", "write"]));
      expect(thread?.model).toEqual({ providerId: "anthropic", modelId: "haiku" });
      expect(capture).toHaveBeenCalledOnce();
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("refuses retrieval dispatch when the preset slot is not configured", async () => {
    const service = createThreadDispatchService({
      threadRegistry: {
        maxConcurrency: 12,
        countActiveInRoot: vi.fn(async () => 0),
        createThread: vi.fn(),
      },
      threadSpawnSession: vi.fn(),
    } as never);
    await expect(service.handle({ preset: "retrieval", task: "Inspect state" }, serviceContext())).rejects.toMatchObject({
      harnessCode: "unavailable",
      message: expect.stringContaining("models.retrievalAgent"),
    });
  });

  it("runs a preset-less dispatch on the caller's resolved model and tools", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-plain-dispatch-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const spawn = vi.fn(async () => ({ sessionId: "child" }));
    const service = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: spawn,
      threadPrepareIsolatedBranch: prepareIsolatedBranch,
    } as never);
    try {
      const result = await service.handle({
        task: "Summarize the diff",
        model: { providerId: "anthropic", modelId: "claude-sonnet-4" },
        tools: ["read", "grep", "bash"],
      }, serviceContext());
      expect(result.queued).toBe(false);
      const thread = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, result.threadId);
      expect(thread).toMatchObject({
        preset: null,
        brief: "Summarize the diff",
        model: { providerId: "anthropic", modelId: "claude-sonnet-4" },
        manifest: { tools: ["read", "grep", "bash"], worktree: "isolated", systemPromptFragment: null },
      });
      const run = await registry.getActiveRun("workspace-1", result.threadId);
      expect(run?.frozen).toMatchObject({
        model: { providerId: "anthropic", modelId: "claude-sonnet-4" },
        tools: ["read", "grep", "bash"],
        worktree: "isolated",
        inputOrigin: "task",
      });
      expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
        tools: ["read", "grep", "bash"],
        model: { providerId: "anthropic", modelId: "claude-sonnet-4" },
      }));
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("honors an explicit shared worktree only when asked", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-shared-dispatch-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const service = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: vi.fn(async () => ({ sessionId: "child" })),
      threadPrepareIsolatedBranch: prepareIsolatedBranch,
    } as never);
    try {
      const result = await service.handle({
        task: "Patch the live tree",
        worktree: "shared",
        model: { providerId: "anthropic", modelId: "claude-sonnet-4" },
        tools: ["read", "edit"],
      }, serviceContext());
      const thread = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, result.threadId);
      expect(thread?.manifest.worktree).toBe("shared");
      expect(prepareIsolatedBranch).not.toHaveBeenCalled();
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("rejects a preset-less dispatch without a resolved model and an unknown preset", async () => {
    const service = createThreadDispatchService({
      threadRegistry: {
        maxConcurrency: 12,
        countActiveInRoot: vi.fn(async () => 0),
        createThread: vi.fn(),
      },
      threadSpawnSession: vi.fn(),
    } as never);
    await expect(service.handle({ task: "No model resolved" }, serviceContext())).rejects.toMatchObject({
      harnessCode: "invalid-params",
    });
    await expect(service.handle({ preset: "does-not-exist", task: "Bad preset" }, serviceContext())).rejects.toMatchObject({
      harnessCode: "invalid-params",
      message: expect.stringContaining("Unknown preset"),
    });
  });

  it("denies a nested preset-less dispatch claiming tools outside the owning Run", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-nested-tools-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const service = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: vi.fn(async () => ({ sessionId: "grandchild" })),
      threadPrepareIsolatedBranch: prepareIsolatedBranch,
    } as never);
    try {
      const parent = await registry.createThread({
        workspaceId: "workspace-1",
        parent: { kind: "session", id: "root-session" },
        brief: "limited parent",
        preset: null,
        kind: "implementation",
        createdBy: "agent",
        concurrency: 2,
        autoRun: true,
        worktree: "isolated",
        tools: ["read", "dispatch"],
        permissions: {},
      });
      const run = await registry.startRun("workspace-1", parent.id);
      await registry.markRunRunning("workspace-1", parent.id, run.id, "limited-session");
      const ctx = {
        ...serviceContext(),
        sessionId: "limited-session",
        actor: { ...serviceContext().actor, sessionId: "limited-session" },
      };
      await expect(service.handle({
        task: "Write beyond the parent",
        model: { providerId: "anthropic", modelId: "claude-sonnet-4" },
        tools: ["read", "write"],
      }, ctx)).rejects.toMatchObject({ harnessCode: "denied" });
      const allowed = await service.handle({
        task: "Read within the parent",
        model: { providerId: "anthropic", modelId: "claude-sonnet-4" },
        tools: ["read"],
      }, ctx);
      expect(allowed.queued).toBe(false);
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
        countActiveInRoot: vi.fn(async () => 0),
        createThread: vi.fn(async () => { throw new Error("catalog write failed"); }),
      },
      threadSpawnSession: vi.fn(),
      threadCaptureDraftBaseline: vi.fn(async () => ({ draftBaselineId: "draft-orphan", cleanup })),
      threadPrepareIsolatedBranch: prepareIsolatedBranch,
    } as never);
    await expect(service.handle({ preset: "hard-implement", task: "Use the draft" }, serviceContext({
      source: "surface",
      workspaceId: "workspace-1",
      dirtyPaths: ["draft.ts"],
      snapshot: { status: "ready", ref: "snapshot-ref" },
    }))).rejects.toThrow("catalog write failed");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("parents a nested dispatch to the owning Thread and reuses its concurrency queue", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-nested-dispatch-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const spawn = vi.fn(async () => ({ sessionId: "grandchild" }));
    const service = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: spawn,
      threadPrepareIsolatedBranch: prepareIsolatedBranch,
    } as never);
    try {
      const parent = await registry.createThread({
        workspaceId: "workspace-1",
        parent: { kind: "session", id: "root-session" },
        brief: "parent implementer",
        preset: "hard-implement",
        kind: "implementation",
        createdBy: "agent",
        concurrency: 1,
        autoRun: true,
        worktree: "isolated",
        tools: ["dispatch", "threads", "wait", "read_thread", "send", "kill", "merge"],
        permissions: { mode: "accept-edits" },
      });
      const run = await registry.startRun("workspace-1", parent.id);
      await registry.markRunRunning("workspace-1", parent.id, run.id, "child-session");
      const nestedCtx = {
        ...serviceContext(),
        sessionId: "child-session",
        workspaceId: "execution-ws",
        actor: { ...serviceContext().actor, sessionId: "child-session", workspaceId: "execution-ws" },
      };
      const first = await service.handle({ concurrency: 1, preset: "check", task: "Run the suite" }, nestedCtx);
      const queued = await service.handle({ concurrency: 1, preset: "check", task: "Second check" }, nestedCtx);
      const queuedRetrieval = await service.handle({
        concurrency: 1,
        preset: "retrieval",
        task: "Read the parent-frozen fact",
        model: { providerId: "test", modelId: "retrieval" },
      }, nestedCtx);
      // The owner itself occupies the shared root budget (concurrency 1), so
      // every nested dispatch queues until the owner yields its slot (3.18C).
      expect(first.queued).toBe(true);
      expect(queued.queued).toBe(true);
      expect(queuedRetrieval.queued).toBe(true);
      const retrieval = await registry.getThread(
        "workspace-1",
        { kind: "thread", id: parent.id },
        queuedRetrieval.threadId,
      );
      expect(retrieval?.manifest.worktree).toBe("isolated");
      expect(prepareIsolatedBranch).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: "workspace-1",
        parent: { kind: "thread", id: parent.id },
        threadId: queuedRetrieval.threadId,
      }));
      expect(await registry.getThread("workspace-1", { kind: "thread", id: parent.id }, first.threadId)).toMatchObject({
        parent: { kind: "thread", id: parent.id },
        preset: "check",
        manifest: { permissions: { mode: "accept-edits" } },
      });
      expect(await registry.listThreads("workspace-1", { kind: "session", id: "root-session" })).toEqual([
        expect.objectContaining({ id: parent.id }),
      ]);
      // Nothing spawns while the owner still holds the shared budget.
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("rejects nested scope expansion and unauthorized thread tools", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-nested-deny-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const service = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: vi.fn(async () => ({ sessionId: "grandchild" })),
      threadPrepareIsolatedBranch: prepareIsolatedBranch,
    } as never);
    try {
      const scoped = await registry.createThread({
        workspaceId: "workspace-1",
        parent: { kind: "session", id: "root-session" },
        brief: "scoped parent",
        preset: "hard-implement",
        kind: "implementation",
        createdBy: "agent",
        concurrency: 2,
        autoRun: true,
        worktree: "isolated",
        tools: ["dispatch"],
        permissions: {},
        scope: ["src"],
      });
      const scopedRun = await registry.startRun("workspace-1", scoped.id);
      await registry.markRunRunning("workspace-1", scoped.id, scopedRun.id, "scoped-session");
      await expect(service.handle({
        preset: "check",
        task: "Leave src",
        scope: ["docs"],
      }, { ...serviceContext(), sessionId: "scoped-session", actor: { ...serviceContext().actor, sessionId: "scoped-session" } }))
        .rejects.toMatchObject({ harnessCode: "denied" });

      const review = await registry.createThread({
        workspaceId: "workspace-1",
        parent: { kind: "session", id: "root-session" },
        brief: "review parent",
        preset: "review",
        kind: "implementation",
        createdBy: "agent",
        concurrency: 2,
        autoRun: true,
        worktree: "none",
        tools: ["read", "grep"],
        permissions: {},
      });
      const reviewRun = await registry.startRun("workspace-1", review.id);
      await registry.markRunRunning("workspace-1", review.id, reviewRun.id, "review-session");
      await expect(service.handle({
        preset: "hard-implement",
        task: "Should not nest",
      }, { ...serviceContext(), sessionId: "review-session", actor: { ...serviceContext().actor, sessionId: "review-session" } }))
        .rejects.toMatchObject({ harnessCode: "denied" });
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
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
        preset: "hard-implement",
        task: "Capture must finish",
      }, serviceContext())).rejects.toMatchObject({ harnessCode: "unavailable" });
      expect(spawn).not.toHaveBeenCalled();
      expect(await registry.listThreads("workspace-1", { kind: "session", id: "parent-1" })).toEqual([]);
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("preserves a retryable baseline-changed failure and deletes the Thread", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-baseline-changed-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const spawn = vi.fn(async () => ({ sessionId: "child" }));
    const service = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: spawn,
      threadPrepareIsolatedBranch: vi.fn(async () => {
        throw new ThreadRuntimeError(
          "unavailable",
          "Thread baseline is unavailable because the parent workspace changed during capture (baseline-changed)",
          { retryable: true },
        );
      }),
    } as never);
    try {
      await expect(service.handle({
        concurrency: 1,
        preset: "hard-implement",
        task: "Capture must stay honest",
      }, serviceContext())).rejects.toMatchObject({
        harnessCode: "unavailable",
        harnessRetryable: true,
        message: expect.stringContaining("baseline-changed"),
      });
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

  it("accepts relative scope names that contain consecutive dots through dispatch", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-scope-dots-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const service = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: vi.fn(async () => ({ sessionId: "dotted-session" })),
      threadPrepareIsolatedBranch: prepareIsolatedBranch,
    } as never);
    try {
      const result = await service.handle({
        preset: "check",
        task: "Names with dots",
        scope: ["src/foo..bar", "version...txt"],
      }, serviceContext());
      const thread = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, result.threadId);
      expect(thread?.manifest.scope).toEqual(["src/foo..bar", "version...txt"]);

      const scoped = await registry.createThread({
        workspaceId: "workspace-1",
        parent: { kind: "session", id: "root-session" },
        brief: "scoped parent",
        preset: "hard-implement",
        kind: "implementation",
        createdBy: "agent",
        concurrency: 2,
        autoRun: true,
        worktree: "isolated",
        tools: ["dispatch"],
        permissions: {},
        scope: ["src"],
      });
      const run = await registry.startRun("workspace-1", scoped.id);
      await registry.markRunRunning("workspace-1", scoped.id, run.id, "dotted-parent");
      const nested = await service.handle({
        preset: "check",
        task: "Nested dotted name",
        scope: ["src/foo..bar"],
      }, {
        ...serviceContext(),
        sessionId: "dotted-parent",
        actor: { ...serviceContext().actor, sessionId: "dotted-parent" },
      });
      const child = await registry.getThread("workspace-1", { kind: "thread", id: scoped.id }, nested.threadId);
      expect(child?.manifest.scope).toEqual(["src/foo..bar"]);
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("releases a surface draft when nested scope is rejected", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-scope-cleanup-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const cleanup = vi.fn(async () => undefined);
    const capture = vi.fn(async () => ({ draftBaselineId: "draft-1", cleanup }));
    const service = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: vi.fn(async () => ({ sessionId: "grandchild" })),
      threadPrepareIsolatedBranch: prepareIsolatedBranch,
      threadCaptureDraftBaseline: capture,
    } as never);
    try {
      const scoped = await registry.createThread({
        workspaceId: "workspace-1",
        parent: { kind: "session", id: "root-session" },
        brief: "scoped parent",
        preset: "hard-implement",
        kind: "implementation",
        createdBy: "agent",
        concurrency: 2,
        autoRun: true,
        worktree: "isolated",
        tools: ["dispatch"],
        permissions: {},
        scope: ["src"],
      });
      const run = await registry.startRun("workspace-1", scoped.id);
      await registry.markRunRunning("workspace-1", scoped.id, run.id, "scoped-session");
      await expect(service.handle({
        preset: "check",
        task: "Leave src",
        scope: ["docs"],
      }, {
        ...serviceContext({
          source: "surface",
          workspaceId: "workspace-1",
          dirtyPaths: ["draft.ts"],
          snapshot: { status: "ready", ref: "snapshot-ref" },
        }),
        sessionId: "scoped-session",
        actor: { ...serviceContext().actor, sessionId: "scoped-session" },
      })).rejects.toMatchObject({ harnessCode: "denied" });
      expect(cleanup).toHaveBeenCalledOnce();
      expect(await registry.listThreads("workspace-1", { kind: "thread", id: scoped.id })).toEqual([]);
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("kills descendant threads including queued children through the runtime cascade", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-kill-cascade-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    let seq = 0;
    const snapshotOf = (sessionId: string): SessionSnapshot => ({
      activeTools: ["read", "kill"],
      busy: false,
      cwd: "/workspace",
      features: { revision: 0, schemaVersion: 1 },
      followUp: [],
      followUpMode: "one-at-a-time",
      isCompacting: false,
      isStreaming: false,
      leafId: "entry-1",
      pendingMessageCount: 0,
      retryAttempt: 0,
      sessionId,
      steering: [],
      steeringMode: "all",
      thinkingLevel: "off",
      workspace: { authorityId: "workspace-1", id: "workspace-1", kind: "workspace" },
    });
    const sessions = {
      create: vi.fn(async () => snapshotOf(`child-${++seq}`)),
      open: vi.fn(async (input: { sessionId: string }) => snapshotOf(input.sessionId)),
      prompt: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      snapshot: vi.fn(async (sessionId: string) => snapshotOf(sessionId)),
      summary: vi.fn(async (sessionId: string): Promise<SessionSummary> => ({
        allMessagesText: "",
        createdAt: "2026-09-04T00:00:00.000Z",
        cwd: "/workspace",
        firstMessage: "",
        id: sessionId,
        messageCount: 0,
        persisted: true,
        sessionFile: `/sessions/${sessionId}.jsonl`,
        updatedAt: "2026-09-04T00:00:00.000Z",
      })),
      stats: vi.fn(async (): Promise<SessionStats> => ({
        cost: 0,
        sessionId: "unused",
        tokens: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        totalMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        assistantMessages: 0,
        userMessages: 0,
      })),
      entries: vi.fn(async (sessionId: string, scope: "branch" | "all" = "branch"): Promise<SessionEntriesResult> => ({
        sessionId,
        scope,
        leafId: "entry-1",
        entries: [],
      })),
    };
    const runtime = createThreadRuntime({
      registry,
      sessions,
      resolveWorkspaceRoot: async () => "/workspace",
      resolveRuntimeWorkspaceId: async () => "workspace-1",
      worktrees: {
        prepare: async () => ({ cwd: "/workspace", worktree: null }),
        snapshot: async (worktree) => worktree,
        inspect: async () => ({ patch: "", untracked: [], changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
        merge: async () => ({ merged: 0, conflicts: [], conflictState: "none", changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
      },
    });
    const killed: string[] = [];
    const service = createThreadKillService({
      threadRegistry: registry,
      threadKillSession: async (threadId: string, keepWorktree?: boolean, workspaceId?: string) => {
        killed.push(threadId);
        await runtime.kill(threadId, keepWorktree, workspaceId);
      },
    } as never);
    const createInput = (
      parent: { kind: "session" | "thread"; id: string },
      brief: string,
      worktree: "isolated" | "none" = "none",
    ) => ({
      workspaceId: "workspace-1",
      parent,
      brief,
      preset: "hard-implement" as const,
      kind: "implementation" as const,
      createdBy: "agent" as const,
      concurrency: 2,
      autoRun: true,
      worktree,
      tools: ["kill", "read"],
      permissions: {},
    });
    try {
      const parent = await registry.createThread(createInput({ kind: "session", id: "parent-1" }, "parent"));
      const parentRun = await registry.startRun("workspace-1", parent.id);
      await runtime.spawn({ ...createInput({ kind: "session", id: "parent-1" }, "parent"), threadId: parent.id, runId: parentRun.id });
      const child = await registry.createThread(createInput({ kind: "thread", id: parent.id }, "child"));
      const childRun = await registry.startRun("workspace-1", child.id);
      await runtime.spawn({ ...createInput({ kind: "thread", id: parent.id }, "child"), threadId: child.id, runId: childRun.id });
      const grandchild = await registry.createThread(createInput({ kind: "thread", id: child.id }, "grandchild"));
      const result = await service.handle({ threadId: parent.id }, serviceContext());
      expect(result.text).toContain(parent.id);
      expect(killed).toEqual([parent.id]);
      expect(await registry.getThread("workspace-1", { kind: "thread", id: child.id }, grandchild.id)).toMatchObject({
        lifecycle: "settled",
      });
      expect(await registry.getThread("workspace-1", { kind: "thread", id: parent.id }, child.id)).toMatchObject({
        lifecycle: "settled",
      });
      expect(await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, parent.id)).toMatchObject({
        lifecycle: "settled",
      });
      expect(await registry.getActiveRun("workspace-1", parent.id)).toMatchObject({ outcome: "cancelled" });
      expect(await registry.getActiveRun("workspace-1", child.id)).toMatchObject({ outcome: "cancelled" });
      expect(await registry.getActiveRun("workspace-1", grandchild.id)).toBeNull();
      expect(sessions.abort).toHaveBeenCalled();
      expect(sessions.close).toHaveBeenCalled();
    } finally {
      await runtime.dispose();
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("captures the parent's committed input for an inherit dispatch", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-dispatch-inherit-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const spawn = vi.fn(async () => ({ sessionId: "child-9" }));
    const capture = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      text: `[committed summary]\nPARENT SUMMARY for ${sessionId}`,
      anchors: ["anchor-1"],
    }));
    const service = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: spawn,
      threadPrepareIsolatedBranch: prepareIsolatedBranch,
      threadCaptureInputContext: capture,
    } as never);
    try {
      const result = await service.handle({
        task: "Continue in my context",
        input: "inherit",
        model: { providerId: "openai", modelId: "gpt-test" },
      }, serviceContext());
      expect(capture).toHaveBeenCalledWith({ sessionId: "parent-1" });
      expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
        inputOrigin: "inherit",
        inheritedContext: expect.objectContaining({
          fromSessionId: "parent-1",
          anchors: ["anchor-1"],
        }),
      }));
      const thread = await registry.getThreadById("workspace-1", result.threadId);
      expect(thread?.manifest.inputOrigin).toBe("inherit");
      expect(thread?.manifest.inheritedContext?.text).toContain("PARENT SUMMARY");
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("rejects an inherit dispatch when parent input capture is unavailable", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-dispatch-inherit-off-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const spawn = vi.fn(async () => ({ sessionId: "child-9" }));
    const service = createThreadDispatchService({
      threadRegistry: registry,
      threadSpawnSession: spawn,
      threadPrepareIsolatedBranch: prepareIsolatedBranch,
    } as never);
    try {
      await expect(service.handle({
        task: "Continue in my context",
        input: "inherit",
        model: { providerId: "openai", modelId: "gpt-test" },
      }, serviceContext())).rejects.toMatchObject({ harnessCode: "unavailable" });
      expect(spawn).not.toHaveBeenCalled();
      expect(await registry.listThreads("workspace-1", { kind: "session", id: "parent-1" })).toEqual([]);
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("rejects thread tools when a session binding has no matching catalog owner", async () => {
    const service = createThreadDispatchService({
      threadRegistry: {
        getSessionBinding: async () => ({
          sessionId: "orphan-session",
          owningWorkspaceId: "workspace-1",
          threadId: "missing-thread",
          runId: "run-1",
          parent: { kind: "session", id: "parent-1" },
        }),
        getThreadById: async () => null,
        maxConcurrency: 12,
      },
      threadSpawnSession: vi.fn(async () => ({ sessionId: "grandchild" })),
      threadPrepareIsolatedBranch: prepareIsolatedBranch,
    } as never);
    await expect(service.handle({
      preset: "check",
      task: "Should not skip the owner allowlist",
    }, {
      ...serviceContext(),
      sessionId: "orphan-session",
      workspaceId: "execution-ws",
      actor: { ...serviceContext().actor, sessionId: "orphan-session", workspaceId: "execution-ws" },
    })).rejects.toMatchObject({ harnessCode: "denied" });
    expect(prepareIsolatedBranch).not.toHaveBeenCalled();
  });

  const settledThread = async (registry: ReturnType<typeof createThreadRegistry>) => {
    const thread = await registry.createThread({
      workspaceId: "workspace-1",
      parent: { kind: "session", id: "parent-1" },
      brief: "Implement the feature",
      kind: "implementation" as const,
      createdBy: "agent" as const,
      concurrency: 2,
      autoRun: true,
      worktree: "isolated" as const,
      tools: ["read", "edit"],
      permissions: {},
    });
    const run = await registry.startRun("workspace-1", thread.id);
    await registry.endRun("workspace-1", thread.id, run.id, "success", null, {
      blocksSnapshot: {},
      changedFiles: ["a.ts"],
      conclusion: "done",
      confidence: 0.8,
      deviations: [],
      transcriptRef: { fromEntryId: null, runtimeId: "pi", sessionId: "child-1", toEntryId: null },
      unresolved: [],
    });
    return { thread, run };
  };

  it("routes a request on a settled Thread to a new Run instead of reopening send", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-send-request-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const continueRun = vi.fn(async () => ({ runId: "run-2" }));
    const sendToSession = vi.fn(async () => {});
    const service = createThreadSendService({
      threadRegistry: registry,
      threadSendToSession: sendToSession,
      threadContinueRun: continueRun,
    } as never);
    try {
      const { thread } = await settledThread(registry);
      const result = await service.handle({
        threadId: thread.id,
        message: "Apply the review feedback",
        from: "parent-agent",
        kind: "request",
      }, serviceContext());
      expect(result).toMatchObject({ accepted: true, lifecycle: "active", runId: "run-2" });
      expect(continueRun).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: "workspace-1",
        parent: { kind: "session", id: "parent-1" },
        threadId: thread.id,
        mode: "continue",
        task: "Apply the review feedback",
      }));
      expect(sendToSession).not.toHaveBeenCalled();
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("passes context fresh through to the continuation mode", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-send-fresh-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const continueRun = vi.fn(async () => ({ runId: "run-3" }));
    const service = createThreadSendService({
      threadRegistry: registry,
      threadSendToSession: vi.fn(async () => {}),
      threadContinueRun: continueRun,
    } as never);
    try {
      const { thread } = await settledThread(registry);
      await service.handle({
        threadId: thread.id,
        message: "Rebuild and fix",
        from: "parent-agent",
        kind: "request",
        context: "fresh",
      }, serviceContext());
      expect(continueRun).toHaveBeenCalledWith(expect.objectContaining({ mode: "fresh" }));
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("holds a plain inform to a settled Thread and rejects context without a request", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-send-settled-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const continueRun = vi.fn(async () => ({ runId: "run-4" }));
    const sendToSession = vi.fn(async () => {});
    const service = createThreadSendService({
      threadRegistry: registry,
      threadSendToSession: sendToSession,
      threadContinueRun: continueRun,
    } as never);
    try {
      const { thread } = await settledThread(registry);
      // inform is recorded for the next Run's input — it never starts one.
      const held = await service.handle({
        threadId: thread.id,
        message: "still there?",
        from: "parent-agent",
      }, serviceContext());
      expect(held).toMatchObject({ accepted: true, lifecycle: "settled", delivery: "held" });
      const recorded = await registry.getThreadById("workspace-1", thread.id);
      expect(recorded?.messages).toEqual([
        expect.objectContaining({ direction: "in", kind: "inform", text: "still there?", status: "held" }),
      ]);
      await expect(service.handle({
        threadId: thread.id,
        message: "still there?",
        from: "parent-agent",
        context: "fresh",
      }, serviceContext())).rejects.toMatchObject({ harnessCode: "invalid-params" });
      expect(continueRun).not.toHaveBeenCalled();
      expect(sendToSession).not.toHaveBeenCalled();
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  // --- Directed messaging and shared root admission (D-285.6 / 3.18C) ---

  const runningThread = async (
    registry: ReturnType<typeof createThreadRegistry>,
    parent: { kind: "session" | "thread"; id: string },
    brief: string,
    concurrency = 2,
  ) => {
    const thread = await registry.createThread({
      workspaceId: "workspace-1",
      parent,
      brief,
      kind: "implementation" as const,
      createdBy: "agent" as const,
      concurrency,
      autoRun: true,
      worktree: "isolated" as const,
      tools: ["send", "wait", "dispatch", "read", "edit"],
      permissions: {},
    });
    const run = await registry.startRun("workspace-1", thread.id);
    const sessionId = `session-${thread.id}`;
    await registry.markRunRunning("workspace-1", thread.id, run.id, sessionId);
    return { thread, run, sessionId };
  };

  const threadCtx = (sessionId: string) => ({
    ...serviceContext(),
    sessionId,
    actor: { ...serviceContext().actor, sessionId },
  });

  it("delivers inform to a running target without starting a Run", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-send-inform-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const sendToSession = vi.fn(async () => {});
    const service = createThreadSendService({
      threadRegistry: registry,
      threadSendToSession: sendToSession,
      threadContinueRun: vi.fn(),
    } as never);
    try {
      const { thread, run, sessionId } = await runningThread(registry, { kind: "session", id: "parent-1" }, "work");
      const result = await service.handle(
        { threadId: thread.id, message: "note this", from: "parent-agent" },
        serviceContext(),
      );
      expect(result).toMatchObject({ accepted: true, lifecycle: "active", delivery: "delivered", runId: run.id });
      expect(sendToSession).toHaveBeenCalledWith(sessionId, "note this", { from: "the parent agent" });
      expect((await registry.getThreadById("workspace-1", thread.id))?.messages).toEqual([
        expect.objectContaining({ direction: "in", kind: "inform", status: "delivered" }),
      ]);
      const runs = await registry.listRuns("workspace-1", thread.id);
      expect(runs).toHaveLength(1);
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("holds inform for a waiting target and delivers a request that clears the wait", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-send-waiting-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const sendToSession = vi.fn(async () => {});
    const service = createThreadSendService({
      threadRegistry: registry,
      threadSendToSession: sendToSession,
    } as never);
    try {
      const { thread, sessionId } = await runningThread(registry, { kind: "session", id: "parent-1" }, "work");
      await registry.setAttention("workspace-1", thread.id, "thread", { kind: "thread", text: "Waiting on a child" });
      const held = await service.handle(
        { threadId: thread.id, message: "fyi only", from: "parent-agent" },
        serviceContext(),
      );
      expect(held).toMatchObject({ accepted: true, delivery: "held" });
      expect(sendToSession).not.toHaveBeenCalled();
      const woken = await service.handle(
        { threadId: thread.id, message: "do more", from: "parent-agent", kind: "request", requestId: "req-wake" },
        serviceContext(),
      );
      expect(woken).toMatchObject({ accepted: true, delivery: "delivered", attention: "none" });
      // Held messages flush ahead of the request at the same boundary.
      expect(sendToSession).toHaveBeenNthCalledWith(1, sessionId, "fyi only", { from: "the parent agent" });
      expect(sendToSession).toHaveBeenNthCalledWith(2, sessionId, "do more", { from: "the parent agent", requestId: "req-wake" });
      expect((await registry.getThreadById("workspace-1", thread.id))?.attention).toBe("none");
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("resolves the actual request on replyTo and completes the requester's wait", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-send-reply-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const sendToSession = vi.fn(async () => {});
    const service = createThreadSendService({
      threadRegistry: registry,
      threadSendToSession: sendToSession,
    } as never);
    try {
      const asker = await runningThread(registry, { kind: "session", id: "root-1" }, "asker");
      const answerer = await runningThread(registry, { kind: "session", id: "root-1" }, "answerer");
      // Asker requests an answer from its sibling.
      const sent = await service.handle(
        { threadId: answerer.thread.id, message: "what is the count?", from: "parent-agent", kind: "request", requestId: "req-1" },
        threadCtx(asker.sessionId),
      );
      expect(sent).toMatchObject({ accepted: true, delivery: "delivered", messageId: "req-1" });
      // The asker waits on the dependency and yields its slot.
      await registry.setAttention("workspace-1", asker.thread.id, "thread", { kind: "thread", text: "Waiting on answerer" });
      // Sibling answers with replyTo — the reply resolves both ledgers and clears the wait.
      const reply = await service.handle(
        { threadId: asker.thread.id, message: "count is 3", from: "parent-agent", replyTo: "req-1" },
        threadCtx(answerer.sessionId),
      );
      expect(reply).toMatchObject({ accepted: true, delivery: "delivered", attention: "none" });
      expect(sendToSession).toHaveBeenLastCalledWith(asker.sessionId, "count is 3", { from: `thread ${answerer.thread.id}` });
      const askerNow = await registry.getThreadById("workspace-1", asker.thread.id);
      expect(askerNow?.attention).toBe("none");
      expect(askerNow?.waitingFor).toBeNull();
      expect(askerNow?.messages?.find((m) => m.id === "req-1" && m.direction === "out")?.status).toBe("resolved");
      const answererNow = await registry.getThreadById("workspace-1", answerer.thread.id);
      expect(answererNow?.messages?.find((m) => m.id === "req-1" && m.direction === "in")?.status).toBe("resolved");
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("returns the recorded outcome for a duplicate requestId instead of re-delivering", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-send-dedupe-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const sendToSession = vi.fn(async () => {});
    const service = createThreadSendService({
      threadRegistry: registry,
      threadSendToSession: sendToSession,
    } as never);
    try {
      const { thread } = await runningThread(registry, { kind: "session", id: "parent-1" }, "work");
      const params = { threadId: thread.id, message: "run it", from: "parent-agent" as const, kind: "request" as const, requestId: "req-dupe" };
      const first = await service.handle(params, serviceContext());
      const retry = await service.handle(params, serviceContext());
      expect(first).toMatchObject({ accepted: true, delivery: "delivered", messageId: "req-dupe" });
      expect(retry).toMatchObject({ accepted: true, messageId: "req-dupe" });
      expect(sendToSession).toHaveBeenCalledTimes(1);
      expect((await registry.listRuns("workspace-1", thread.id))).toHaveLength(1);
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("rejects targets outside the caller's root-task relationships", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-send-scope-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const service = createThreadSendService({
      threadRegistry: registry,
      threadSendToSession: vi.fn(async () => {}),
    } as never);
    try {
      const mine = await runningThread(registry, { kind: "session", id: "parent-1" }, "mine");
      const foreign = await runningThread(registry, { kind: "session", id: "other-root" }, "foreign");
      // A session caller only reaches its own children.
      await expect(service.handle(
        { threadId: foreign.thread.id, message: "hi", from: "parent-agent" },
        serviceContext(),
      )).rejects.toMatchObject({ harnessCode: "denied" });
      // A thread caller cannot reach a cousin under a different root.
      await expect(service.handle(
        { threadId: foreign.thread.id, message: "hi", from: "parent-agent" },
        threadCtx(mine.sessionId),
      )).rejects.toMatchObject({ harnessCode: "denied" });
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("reaches the caller's own parent and siblings", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-send-family-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const sendToSession = vi.fn(async () => {});
    const service = createThreadSendService({
      threadRegistry: registry,
      threadSendToSession: sendToSession,
    } as never);
    try {
      const parent = await runningThread(registry, { kind: "session", id: "root-1" }, "parent thread", 4);
      const child = await runningThread(registry, { kind: "thread", id: parent.thread.id }, "child thread");
      const sibling = await runningThread(registry, { kind: "thread", id: parent.thread.id }, "sibling thread");
      // to: "parent" resolves the parent thread for a nested caller.
      const up = await service.handle(
        { to: "parent", message: "question for you", from: "parent-agent" },
        threadCtx(child.sessionId),
      );
      expect(up).toMatchObject({ accepted: true, delivery: "delivered" });
      expect(sendToSession).toHaveBeenCalledWith(parent.sessionId, "question for you", { from: `thread ${child.thread.id}` });
      // Sibling under the same parent thread is reachable.
      const sideways = await service.handle(
        { threadId: sibling.thread.id, message: "note", from: "parent-agent" },
        threadCtx(child.sessionId),
      );
      expect(sideways).toMatchObject({ accepted: true, delivery: "delivered" });
      // A root child sending to its parent session.
      const session = await service.handle(
        { to: "parent", message: "answer", from: "parent-agent" },
        threadCtx(parent.sessionId),
      );
      expect(session).toMatchObject({ accepted: true, delivery: "delivered" });
      expect(sendToSession).toHaveBeenCalledWith("root-1", "answer", { from: `thread ${parent.thread.id}` });
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("records a parked request behind a full shared budget and reports scheduled", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-send-parked-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const continueRun = vi.fn(async () => ({}));
    const service = createThreadSendService({
      threadRegistry: registry,
      threadSendToSession: vi.fn(async () => {}),
      threadContinueRun: continueRun,
    } as never);
    try {
      const { thread } = await settledThread(registry);
      const result = await service.handle({
        threadId: thread.id,
        message: "run when free",
        from: "parent-agent",
        kind: "request",
        requestId: "req-park",
      }, serviceContext());
      expect(result).toMatchObject({ accepted: true, lifecycle: "settled", delivery: "scheduled" });
      const recorded = await registry.getThreadById("workspace-1", thread.id);
      expect(recorded?.messages).toEqual([
        expect.objectContaining({ direction: "in", id: "req-park", kind: "request", status: "pending" }),
      ]);
      // A retry with the same id returns the parked outcome — no second schedule.
      const retry = await service.handle({
        threadId: thread.id,
        message: "run when free",
        from: "parent-agent",
        kind: "request",
        requestId: "req-park",
      }, serviceContext());
      expect(retry).toMatchObject({ accepted: true, delivery: "scheduled" });
      expect(continueRun).toHaveBeenCalledTimes(1);
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("re-admits a lost worker through the continuation path on request", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-send-lost-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const continueRun = vi.fn(async () => ({ runId: "run-lost-2" }));
    const service = createThreadSendService({
      threadRegistry: registry,
      threadSendToSession: vi.fn(async () => {}),
      threadContinueRun: continueRun,
    } as never);
    try {
      const { thread } = await runningThread(registry, { kind: "session", id: "parent-1" }, "work");
      // The worker is lost (host restart semantics) while the Thread stays active.
      await registry.reconcileWorkspace("workspace-1", new Set());
      const result = await service.handle({
        threadId: thread.id,
        message: "come back",
        from: "parent-agent",
        kind: "request",
      }, serviceContext());
      expect(result).toMatchObject({ accepted: true, delivery: "delivered", runId: "run-lost-2" });
      expect(continueRun).toHaveBeenCalledWith(expect.objectContaining({
        threadId: thread.id,
        mode: "continue",
        task: "come back",
      }));
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("reports accurate status for queued, archived, and deleted targets", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-send-status-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const service = createThreadSendService({
      threadRegistry: registry,
      threadSendToSession: vi.fn(async () => {}),
      threadContinueRun: vi.fn(),
    } as never);
    try {
      const queued = await registry.createThread({
        workspaceId: "workspace-1",
        parent: { kind: "session", id: "parent-1" },
        brief: "queued",
        kind: "implementation",
        createdBy: "agent",
        concurrency: 1,
        autoRun: true,
        worktree: "isolated",
        tools: [],
        permissions: {},
      });
      const queuedSend = await service.handle(
        { threadId: queued.id, message: "later", from: "parent-agent" },
        serviceContext(),
      );
      expect(queuedSend).toMatchObject({ accepted: true, lifecycle: "queued", delivery: "scheduled" });
      const { thread } = await settledThread(registry);
      await registry.archiveThread("workspace-1", thread.id);
      await expect(service.handle(
        { threadId: thread.id, message: "hi", from: "parent-agent" },
        serviceContext(),
      )).rejects.toMatchObject({ harnessCode: "unavailable", message: expect.stringContaining("archived") });
      await expect(service.handle(
        { threadId: "thread-missing", message: "hi", from: "parent-agent" },
        serviceContext(),
      )).rejects.toMatchObject({ harnessCode: "not-found" });
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("yields the shared execution slot while a thread waits and re-admits on return", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-wait-yield-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const service = createThreadWaitService({
      threadRegistry: registry,
      threadSendToSession: vi.fn(async () => {}),
    } as never);
    try {
      const owner = await runningThread(registry, { kind: "session", id: "root-1" }, "owner", 1);
      // The owner occupies the whole shared budget.
      expect(await registry.countActiveInRoot("workspace-1", { kind: "thread", id: owner.thread.id })).toBe(1);
      const pending = service.handle({ timeoutMs: 300 }, threadCtx(owner.sessionId));
      // The blocked wait marks a dependency wait — the slot is released.
      await vi.waitFor(async () => {
        expect((await registry.getThreadById("workspace-1", owner.thread.id))?.waitingFor?.kind).toBe("thread");
      });
      expect(await registry.countActiveInRoot("workspace-1", { kind: "thread", id: owner.thread.id })).toBe(0);
      const result = await pending;
      expect(result.timedOut).toBe(true);
      // Returning re-admits the slot.
      expect((await registry.getThreadById("workspace-1", owner.thread.id))?.waitingFor).toBeNull();
      expect(await registry.countActiveInRoot("workspace-1", { kind: "thread", id: owner.thread.id })).toBe(1);
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("wakes a waiting thread caller when a reply lands on its own record", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "thread-wait-wake-"));
    const registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    const waitService = createThreadWaitService({
      threadRegistry: registry,
      threadSendToSession: vi.fn(async () => {}),
    } as never);
    const sendService = createThreadSendService({
      threadRegistry: registry,
      threadSendToSession: vi.fn(async () => {}),
    } as never);
    try {
      const asker = await runningThread(registry, { kind: "session", id: "root-1" }, "asker");
      const answerer = await runningThread(registry, { kind: "session", id: "root-1" }, "answerer");
      await sendService.handle(
        { threadId: answerer.thread.id, message: "count?", from: "parent-agent", kind: "request", requestId: "req-wake-1" },
        threadCtx(asker.sessionId),
      );
      const waiting = waitService.handle({ timeoutMs: 5_000 }, threadCtx(asker.sessionId));
      await vi.waitFor(async () => {
        expect((await registry.getThreadById("workspace-1", asker.thread.id))?.waitingFor?.kind).toBe("thread");
      });
      // The sibling's reply is a change on the caller's own record — the wait
      // completes without polling.
      await sendService.handle(
        { threadId: asker.thread.id, message: "three", from: "parent-agent", replyTo: "req-wake-1" },
        threadCtx(answerer.sessionId),
      );
      const result = await waiting;
      expect(result.timedOut).toBe(false);
      expect((await registry.getThreadById("workspace-1", asker.thread.id))?.waitingFor).toBeNull();
    } finally {
      await registry.dispose();
      rmSync(dataDir, { force: true, recursive: true });
    }
  });
});
