import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createThreadRegistry } from "./thread-registry.js";
import { createThreadDispatchService, createThreadKillService, createThreadMergeService } from "./thread-services.js";
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
      const result = await service.handle(
        role === "retrieval"
          ? { role, task: "Use the draft", model: { providerId: "anthropic", modelId: "haiku" } }
          : { role, task: "Use the draft" },
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
      const result = await service.handle({
        role: "retrieval",
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

  it("refuses retrieval dispatch when the role slot is not configured", async () => {
    const service = createThreadDispatchService({
      threadRegistry: {
        maxConcurrency: 12,
        countActive: vi.fn(async () => 0),
        createThread: vi.fn(),
      },
      threadSpawnSession: vi.fn(),
    } as never);
    await expect(service.handle({ role: "retrieval", task: "Inspect state" }, serviceContext())).rejects.toMatchObject({
      harnessCode: "unavailable",
      message: expect.stringContaining("models.retrievalAgent"),
    });
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
        role: "hard-implement",
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
      const first = await service.handle({ concurrency: 1, role: "check", task: "Run the suite" }, nestedCtx);
      const queued = await service.handle({ concurrency: 1, role: "check", task: "Second check" }, nestedCtx);
      expect(first.queued).toBe(false);
      expect(queued.queued).toBe(true);
      expect(await registry.getThread("workspace-1", { kind: "thread", id: parent.id }, first.threadId)).toMatchObject({
        parent: { kind: "thread", id: parent.id },
        role: "check",
        manifest: { permissions: { mode: "accept-edits" } },
      });
      expect(await registry.listThreads("workspace-1", { kind: "session", id: "root-session" })).toEqual([
        expect.objectContaining({ id: parent.id }),
      ]);
      expect(spawn).toHaveBeenCalledOnce();
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
        role: "hard-implement",
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
        role: "check",
        task: "Leave src",
        scope: ["docs"],
      }, { ...serviceContext(), sessionId: "scoped-session", actor: { ...serviceContext().actor, sessionId: "scoped-session" } }))
        .rejects.toMatchObject({ harnessCode: "denied" });

      const review = await registry.createThread({
        workspaceId: "workspace-1",
        parent: { kind: "session", id: "root-session" },
        brief: "review parent",
        role: "review",
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
        role: "hard-implement",
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
        role: "hard-implement",
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
        role: "check",
        task: "Names with dots",
        scope: ["src/foo..bar", "version...txt"],
      }, serviceContext());
      const thread = await registry.getThread("workspace-1", { kind: "session", id: "parent-1" }, result.threadId);
      expect(thread?.manifest.scope).toEqual(["src/foo..bar", "version...txt"]);

      const scoped = await registry.createThread({
        workspaceId: "workspace-1",
        parent: { kind: "session", id: "root-session" },
        brief: "scoped parent",
        role: "hard-implement",
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
        role: "check",
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
        role: "hard-implement",
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
        role: "check",
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
      role: "hard-implement" as const,
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
      role: "check",
      task: "Should not skip the owner allowlist",
    }, {
      ...serviceContext(),
      sessionId: "orphan-session",
      workspaceId: "execution-ws",
      actor: { ...serviceContext().actor, sessionId: "orphan-session", workspaceId: "execution-ws" },
    })).rejects.toMatchObject({ harnessCode: "denied" });
    expect(prepareIsolatedBranch).not.toHaveBeenCalled();
  });
});
