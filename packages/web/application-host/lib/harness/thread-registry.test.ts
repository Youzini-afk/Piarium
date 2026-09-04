import fs from "node:fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  THREAD_REGISTRY_SCHEMA_VERSION,
  ThreadRegistryError,
  createThreadRegistry,
  threadCatalogPath,
  type CreateThreadInput,
  type ThreadParent,
  type ThreadReport,
} from "./thread-registry.js";

const WORKSPACE = "workspace-1";
const PARENT: ThreadParent = { kind: "session", id: "parent-1" };

const createInput = (overrides: Partial<CreateThreadInput> = {}): CreateThreadInput => ({
  workspaceId: WORKSPACE,
  parent: PARENT,
  brief: "write tests",
  role: "check",
  kind: "implementation",
  createdBy: "agent",
  concurrency: 12,
  autoRun: true,
  worktree: "isolated",
  model: { providerId: "test-provider", modelId: "test-model" },
  tools: [],
  permissions: {},
  ...overrides,
});

const report = (conclusion = "done"): ThreadReport => ({
  conclusion,
  changedFiles: ["a.ts"],
  unresolved: [],
  deviations: [],
  confidence: 0.9,
  transcriptRef: { runtimeId: "pi", sessionId: "child-1", fromEntryId: "entry-1", toEntryId: "entry-2" },
  blocksSnapshot: {},
});

describe("thread registry", () => {
  let dataDir: string;
  let registry: ReturnType<typeof createThreadRegistry>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "thread-reg-"));
    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
  });

  afterEach(async () => {
    await registry.dispose();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
  });

  it("creates durable work separately from its first execution attempt", async () => {
    const thread = await registry.createThread(createInput());
    expect(thread.lifecycle).toBe("queued");
    expect(thread.activeRunId).toBeNull();
    expect(await registry.countActive(WORKSPACE, PARENT)).toBe(0);

    const starting = await registry.startRun(WORKSPACE, thread.id);
    expect(starting.attempt).toBe(1);
    expect(starting.workerState).toBe("starting");
    expect(await registry.countActive(WORKSPACE, PARENT)).toBe(1);

    const running = await registry.markRunRunning(WORKSPACE, thread.id, starting.id, "child-session-1");
    expect(running.sessionId).toBe("child-session-1");
    expect(running.workerState).toBe("running");
    expect((await registry.getThread(WORKSPACE, PARENT, thread.id))?.lifecycle).toBe("active");
  });

  it("persists the retained branch and result commit", async () => {
    const thread = await registry.createThread(createInput());
    await registry.setWorktree(WORKSPACE, thread.id, {
      path: "D:/worktrees/thread-1",
      base: "base-commit",
      branch: "piarium/thread-1",
      resultCommit: "result-commit",
    });
    await registry.dispose();
    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    expect((await registry.getThread(WORKSPACE, PARENT, thread.id))?.worktree).toEqual({
      path: "D:/worktrees/thread-1",
      base: "base-commit",
      branch: "piarium/thread-1",
      resultCommit: "result-commit",
    });
  });

  it("records a lost attempt and starts attempt two without erasing history or attention", async () => {
    const thread = await registry.createThread(createInput());
    const first = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, first.id, "child-session-1");
    await registry.setAttention(WORKSPACE, thread.id, "permission", { kind: "permission", text: "allow bash?" });
    await registry.endRun(WORKSPACE, thread.id, first.id, "lost", "worker exited");

    const second = await registry.startRun(WORKSPACE, thread.id);
    const current = await registry.getThread(WORKSPACE, PARENT, thread.id);
    const runs = await registry.listRuns(WORKSPACE, thread.id);
    expect(second.attempt).toBe(2);
    expect(current?.activeRunId).toBe(second.id);
    expect(current?.attention).toBe("permission");
    expect(runs.map((run) => [run.attempt, run.outcome, run.workerState])).toEqual([
      [1, "lost", "lost"],
      [2, null, "starting"],
    ]);
  });

  it("allows lifecycle, attention, and integration to change independently", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "child-session-1");
    await registry.setAttention(WORKSPACE, thread.id, "stalled");
    await registry.setIntegration(WORKSPACE, thread.id, "conflict", { files: 2, insertions: 3, deletions: 1 });
    const current = await registry.getThread(WORKSPACE, PARENT, thread.id);
    expect(current).toMatchObject({ lifecycle: "active", attention: "stalled", integration: "conflict" });
  });

  it("completes a run idempotently and retains merge state as a Thread concern", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "child-session-1");
    const first = await registry.completeThread(WORKSPACE, thread.id, report());
    const second = await registry.completeThread(WORKSPACE, thread.id, report("ignored"));
    expect(first?.lifecycle).toBe("settled");
    expect(first?.integration).toBe("merge-ready");
    expect(second).toEqual(first);
    await registry.mergeThread(WORKSPACE, thread.id);
    expect((await registry.getThread(WORKSPACE, PARENT, thread.id))?.integration).toBe("merged");
    expect((await registry.getActiveRun(WORKSPACE, thread.id))?.outcome).toBe("success");
  });

  it("supports a thread parent edge without mixing nested and root children", async () => {
    const root = await registry.createThread(createInput());
    const nestedParent: ThreadParent = { kind: "thread", id: root.id };
    const nested = await registry.createThread(createInput({ parent: nestedParent, brief: "nested" }));
    expect(await registry.listThreads(WORKSPACE, PARENT)).toEqual([root]);
    expect(await registry.listThreads(WORKSPACE, nestedParent)).toEqual([nested]);
    expect(await registry.getThread(WORKSPACE, PARENT, nested.id)).toBeNull();
  });

  it("stores metrics on the active run and diff integration on the Thread", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.updateRunProgress(WORKSPACE, thread.id, {
      steps: 5,
      tokens: { input: 100, output: 20 },
      costUsd: 0.01,
      lastToolCall: { name: "bash", at: "2026-09-04T00:00:00.000Z" },
      diffStats: { files: 1, insertions: 2, deletions: 0 },
    });
    expect(await registry.getActiveRun(WORKSPACE, thread.id)).toMatchObject({
      id: run.id,
      steps: 5,
      tokens: { input: 100, output: 20, cacheRead: 0 },
      costUsd: 0.01,
    });
    expect(await registry.getThread(WORKSPACE, PARENT, thread.id)).toMatchObject({
      integration: "dirty",
      diffStats: { files: 1, insertions: 2, deletions: 0 },
    });
  });

  it("persists one versioned atomic catalog per workspace", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    const path = threadCatalogPath(dataDir, "test-host", WORKSPACE);
    const document = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(document.schemaVersion).toBe(THREAD_REGISTRY_SCHEMA_VERSION);
    expect(document.workspaceId).toBe(WORKSPACE);
    expect(document.threads).toHaveLength(1);
    expect(document.runs).toHaveLength(1);

    const restarted = createThreadRegistry({ dataDir, hostId: "test-host" });
    expect((await restarted.getActiveRun(WORKSPACE, thread.id))?.id).toBe(run.id);
    expect((await restarted.getThread(WORKSPACE, PARENT, thread.id))?.model).toEqual({
      providerId: "test-provider",
      modelId: "test-model",
    });
    expect((await restarted.getThread(WORKSPACE, PARENT, thread.id))?.manifest).toMatchObject({
      carryBlocks: true,
      concurrency: 12,
      tools: [],
      worktree: "isolated",
    });
    await restarted.dispose();
  });

  it("treats only ENOENT as an empty catalog", async () => {
    expect(await registry.listThreads(WORKSPACE, PARENT)).toEqual([]);
    expect(fs.existsSync(threadCatalogPath(dataDir, "test-host", WORKSPACE))).toBe(false);
  });

  it("does not cache or overwrite malformed JSON", async () => {
    const path = threadCatalogPath(dataDir, "test-host", WORKSPACE);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{broken", "utf8");
    await expect(registry.listThreads(WORKSPACE, PARENT)).rejects.toMatchObject({ code: "corrupt" });
    await expect(registry.createThread(createInput())).rejects.toMatchObject({ code: "corrupt" });
    expect(await readFile(path, "utf8")).toBe("{broken");
  });

  it("rejects a future schema without changing it", async () => {
    const path = threadCatalogPath(dataDir, "test-host", WORKSPACE);
    await mkdir(dirname(path), { recursive: true });
    const future = JSON.stringify({ schemaVersion: 999, workspaceId: WORKSPACE, threads: [], runs: [] });
    await writeFile(path, future, "utf8");
    await expect(registry.listThreads(WORKSPACE, PARENT)).rejects.toMatchObject({ code: "future-schema" });
    expect(await readFile(path, "utf8")).toBe(future);
  });

  it("keeps permission errors distinct from an absent file", async () => {
    const path = threadCatalogPath(dataDir, "test-host", WORKSPACE);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ schemaVersion: 1, workspaceId: WORKSPACE, threads: [], runs: [] }), "utf8");
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const failing = createThreadRegistry({
      dataDir,
      hostId: "test-host",
      fsPromises: {
        mkdir: fs.promises.mkdir,
        readFile: vi.fn(async () => { throw denied; }) as typeof fs.promises.readFile,
        readdir: fs.promises.readdir,
        rename: fs.promises.rename,
        rm: fs.promises.rm,
        writeFile: fs.promises.writeFile,
      },
    });
    await expect(failing.listThreads(WORKSPACE, PARENT)).rejects.toMatchObject({ code: "read-failed" });
    expect(await readFile(path, "utf8")).toContain(`"workspaceId":"${WORKSPACE}"`);
    await failing.dispose();
  });

  it("imports a legacy parent array once the workspace relation is known", async () => {
    const legacyPath = join(dataDir, "threads", "test-host", `${PARENT.id}.json`);
    await mkdir(dirname(legacyPath), { recursive: true });
    const legacy = [{
      id: "thread-legacy", parentSessionId: PARENT.id, sessionId: "child-legacy", forkPoint: null,
      brief: "legacy", role: "check", createdBy: "agent", kind: "implementation", worktree: null,
      status: "running", flags: { workerLost: false, stalled: false, looping: false }, waitingFor: null,
      lastActivityAt: "2026-09-04T00:01:00.000Z", steps: 2, tokens: { input: 1, output: 2, cacheRead: 3 },
      costUsd: null, lastToolCall: null, diffStats: null, report: null, exitReason: null,
      createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:01:00.000Z", eventSeq: 4, hidden: false,
    }];
    writeFileSync(legacyPath, JSON.stringify(legacy), "utf8");
    const [thread] = await registry.listThreads(WORKSPACE, PARENT);
    expect(thread).toMatchObject({ id: "thread-legacy", lifecycle: "active", activeRunId: expect.any(String) });
    expect(await registry.getActiveRun(WORKSPACE, thread!.id)).toMatchObject({ attempt: 1, sessionId: "child-legacy", workerState: "running" });
    expect(readFileSync(legacyPath, "utf8")).toBe(JSON.stringify(legacy));
  });

  it("migrates schema v1 reports from an ephemeral trace handle on the next write", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "child-v1");
    await registry.completeThread(WORKSPACE, thread.id, report());
    const path = threadCatalogPath(dataDir, "test-host", WORKSPACE);
    const v1 = JSON.parse(await readFile(path, "utf8")) as {
      schemaVersion: number;
      threads: Array<{ report: Record<string, unknown> | null }>;
    };
    v1.schemaVersion = 1;
    delete (v1.threads[0] as Record<string, unknown>).manifest;
    const currentReport = v1.threads[0]!.report!;
    delete currentReport.transcriptRef;
    currentReport.traceHandle = "out_legacy";
    await writeFile(path, JSON.stringify(v1), "utf8");
    await registry.dispose();

    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    expect((await registry.getThread(WORKSPACE, PARENT, thread.id))?.report?.transcriptRef).toEqual({
      runtimeId: "pi",
      sessionId: "child-v1",
      fromEntryId: null,
      toEntryId: null,
    });
    await registry.setAttention(WORKSPACE, thread.id, "stalled");
    expect(JSON.parse(await readFile(path, "utf8")).schemaVersion).toBe(THREAD_REGISTRY_SCHEMA_VERSION);
  });

  it("reads schema v2 threads without a frozen model and upgrades on mutation", async () => {
    const thread = await registry.createThread(createInput());
    const path = threadCatalogPath(dataDir, "test-host", WORKSPACE);
    const v2 = JSON.parse(await readFile(path, "utf8")) as {
      schemaVersion: number;
      threads: Array<Record<string, unknown>>;
    };
    v2.schemaVersion = 2;
    delete v2.threads[0]!.model;
    delete v2.threads[0]!.manifest;
    await writeFile(path, JSON.stringify(v2), "utf8");
    await registry.dispose();

    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    expect((await registry.getThread(WORKSPACE, PARENT, thread.id))?.model).toBeNull();
    await registry.setAttention(WORKSPACE, thread.id, "stalled");
    expect(JSON.parse(await readFile(path, "utf8")).schemaVersion).toBe(THREAD_REGISTRY_SCHEMA_VERSION);
  });

  it("reads schema v3 threads by deriving their frozen launch manifest", async () => {
    const thread = await registry.createThread(createInput({
      role: "check",
      scope: ["packages/web"],
      tools: ["read"],
      worktree: "shared",
    }));
    const path = threadCatalogPath(dataDir, "test-host", WORKSPACE);
    const v3 = JSON.parse(await readFile(path, "utf8")) as {
      schemaVersion: number;
      threads: Array<Record<string, unknown>>;
    };
    v3.schemaVersion = 3;
    delete v3.threads[0]!.manifest;
    await writeFile(path, JSON.stringify(v3), "utf8");
    await registry.dispose();

    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    expect((await registry.getThread(WORKSPACE, PARENT, thread.id))?.manifest).toMatchObject({
      carryBlocks: true,
      tools: expect.arrayContaining(["read", "bash", "grep"]),
      worktree: "shared",
    });
  });

  it("upgrades schema v4 manifests with the historical carry-block default", async () => {
    const thread = await registry.createThread(createInput({ carryBlocks: false }));
    const path = threadCatalogPath(dataDir, "test-host", WORKSPACE);
    const v4 = JSON.parse(await readFile(path, "utf8")) as {
      schemaVersion: number;
      threads: Array<{ manifest: Record<string, unknown> }>;
    };
    v4.schemaVersion = 4;
    delete v4.threads[0]!.manifest.carryBlocks;
    await writeFile(path, JSON.stringify(v4), "utf8");
    await registry.dispose();

    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    expect((await registry.getThread(WORKSPACE, PARENT, thread.id))?.manifest.carryBlocks).toBe(true);
  });

  it("converts a live discussion by ending its old Run and starting a same-session implementation Run atomically", async () => {
    const thread = await registry.createThread(createInput({
      autoRun: true,
      carryBlocks: false,
      createdBy: "user",
      kind: "discussion",
      tools: ["read", "grep"],
      worktree: "none",
    }));
    const first = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, first.id, "child-discussion");
    await registry.setAttention(WORKSPACE, thread.id, "user", { kind: "user", text: "Continue" });

    const converted = await registry.convertThread(WORKSPACE, thread.id, {
      scope: [],
      tools: ["read", "edit", "bash"],
      worktree: { path: "D:/worktrees/thread", base: "base" },
    });
    expect(converted?.thread).toMatchObject({
      kind: "implementation",
      attention: "none",
      activeRunId: converted?.run.id,
      manifest: { carryBlocks: false, tools: ["read", "edit", "bash"], worktree: "isolated" },
      worktree: { path: "D:/worktrees/thread", base: "base" },
    });
    expect(await registry.listRuns(WORKSPACE, thread.id)).toMatchObject([
      { id: first.id, outcome: "success", workerState: "exited", exitReason: "converted to implementation" },
      { id: converted?.run.id, attempt: 2, outcome: null, workerState: "starting", sessionId: "child-discussion" },
    ]);
  });

  it("reconciles interrupted runs as lost while preserving pending attention", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "child-session-1");
    await registry.setAttention(WORKSPACE, thread.id, "user", { kind: "user", text: "Which file?" });
    await registry.dispose();

    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    const result = await registry.reconcileAfterHostRestart();
    expect(result).toMatchObject({ reconciledRuns: 1, workspaces: 1, failures: [] });
    expect(await registry.getActiveRun(WORKSPACE, thread.id)).toMatchObject({
      workerState: "lost",
      outcome: "lost",
      exitReason: "host restarted",
    });
    expect(await registry.getThread(WORKSPACE, PARENT, thread.id)).toMatchObject({
      lifecycle: "active",
      attention: "user",
      waitingFor: { text: "Which file?" },
    });
  });

  it("reports one corrupt workspace without hiding successful reconciliation of another", async () => {
    const thread = await registry.createThread(createInput());
    await registry.startRun(WORKSPACE, thread.id);
    const badPath = threadCatalogPath(dataDir, "test-host", "workspace-bad");
    await mkdir(dirname(badPath), { recursive: true });
    await writeFile(badPath, "not json", "utf8");
    await registry.dispose();

    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    const result = await registry.reconcileAfterHostRestart();
    expect(result.reconciledRuns).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ code: "corrupt", path: badPath });
  });

  it("does not publish a failed mutation into cache or disk", async () => {
    const thread = await registry.createThread(createInput());
    await registry.dispose();
    const failing = createThreadRegistry({
      dataDir,
      hostId: "test-host",
      fsPromises: {
        mkdir: fs.promises.mkdir,
        readFile: fs.promises.readFile,
        readdir: fs.promises.readdir,
        rename: vi.fn(async () => { throw Object.assign(new Error("locked"), { code: "EBUSY" }); }) as typeof fs.promises.rename,
        rm: fs.promises.rm,
        writeFile: fs.promises.writeFile,
      },
    });
    await expect(failing.setAttention(WORKSPACE, thread.id, "stalled")).rejects.toBeInstanceOf(ThreadRegistryError);
    expect((await failing.getThread(WORKSPACE, PARENT, thread.id))?.attention).toBe("none");
    await failing.dispose();
    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    expect((await registry.getThread(WORKSPACE, PARENT, thread.id))?.attention).toBe("none");
  });

  it("dequeues only after an active run frees a concurrency slot", async () => {
    const dequeued: string[] = [];
    await registry.dispose();
    registry = createThreadRegistry({
      dataDir,
      hostId: "test-host",
      maxConcurrency: 1,
      onThreadDequeued: async (_workspaceId, _parent, thread) => { dequeued.push(thread.id); },
    });
    const first = await registry.createThread(createInput({ brief: "first" }));
    const firstRun = await registry.startRun(WORKSPACE, first.id);
    await registry.markRunRunning(WORKSPACE, first.id, firstRun.id, "child-1");
    const second = await registry.createThread(createInput({ brief: "second" }));
    await registry.endRun(WORKSPACE, first.id, firstRun.id, "success", null, report());
    expect(dequeued).toEqual([second.id]);
  });

  it("uses the queued Thread's persisted concurrency after a restart or settings change", async () => {
    const dequeued: string[] = [];
    await registry.dispose();
    registry = createThreadRegistry({
      dataDir,
      hostId: "test-host",
      onThreadDequeued: async (_workspaceId, _parent, thread) => { dequeued.push(thread.id); },
    });
    const first = await registry.createThread(createInput({ brief: "first", concurrency: 2 }));
    const firstRun = await registry.startRun(WORKSPACE, first.id);
    await registry.markRunRunning(WORKSPACE, first.id, firstRun.id, "child-1");
    const second = await registry.createThread(createInput({ brief: "second", concurrency: 2 }));
    const secondRun = await registry.startRun(WORKSPACE, second.id);
    await registry.markRunRunning(WORKSPACE, second.id, secondRun.id, "child-2");
    const queued = await registry.createThread(createInput({ brief: "queued", concurrency: 1 }));

    await registry.endRun(WORKSPACE, first.id, firstRun.id, "success", null, report());
    expect(dequeued).toEqual([]);
    await registry.endRun(WORKSPACE, second.id, secondRun.id, "success", null, report());
    expect(dequeued).toEqual([queued.id]);
  });

  it("wakes scoped waiters and keeps observer cursors isolated", async () => {
    const thread = await registry.createThread(createInput());
    const wake = vi.fn();
    const unsubscribe = registry.subscribeToChanges(WORKSPACE, PARENT, wake);
    registry.setCursor("observer-1", thread.id, {
      eventSeq: thread.eventSeq,
      lifecycle: thread.lifecycle,
      attention: thread.attention,
      integration: thread.integration,
      activeRunId: null,
      workerState: null,
      outcome: null,
      progressVersion: 0,
      decisionsCount: 0,
      diffStats: null,
      viewedAt: "2026-09-04T00:00:00.000Z",
    });
    await registry.startRun(WORKSPACE, thread.id);
    expect(wake).toHaveBeenCalledOnce();
    expect(registry.getCursor("observer-1", thread.id)?.eventSeq).toBe(thread.eventSeq);
    registry.clearCursorsForSession("observer-1");
    expect(registry.getCursor("observer-1", thread.id)).toBeNull();
    unsubscribe();
  });

  it("archives active children when their parent session is deleted", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "child-1");
    await registry.cancelAllForParent(WORKSPACE, PARENT);
    expect(await registry.getThread(WORKSPACE, PARENT, thread.id)).toMatchObject({ lifecycle: "archived" });
    expect(await registry.getActiveRun(WORKSPACE, thread.id)).toMatchObject({ outcome: "cancelled" });
  });

  it("stops active children before parent deletion and archives settled siblings", async () => {
    const stopped: string[] = [];
    const active = await registry.createThread(createInput({ brief: "active" }));
    const activeRun = await registry.startRun(WORKSPACE, active.id);
    await registry.markRunRunning(WORKSPACE, active.id, activeRun.id, "child-active");
    const settled = await registry.createThread(createInput({ brief: "settled" }));
    const settledRun = await registry.startRun(WORKSPACE, settled.id);
    await registry.endRun(WORKSPACE, settled.id, settledRun.id, "success", null, report());

    await registry.cancelAllForParent(WORKSPACE, PARENT, async (thread) => { stopped.push(thread.id); });
    expect(stopped).toEqual([active.id]);
    expect(await registry.getThread(WORKSPACE, PARENT, active.id)).toMatchObject({ lifecycle: "archived" });
    expect(await registry.getThread(WORKSPACE, PARENT, settled.id)).toMatchObject({ lifecycle: "archived" });
    await expect(registry.createThread(createInput({ brief: "too late" }))).rejects.toThrow(/parent/);
  });

  it("archives a directly deleted child session without retaining a broken transcript reference", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "child-delete");
    await registry.completeThread(WORKSPACE, thread.id, report());

    const [archived] = await registry.archiveThreadsForDeletedSession(WORKSPACE, "child-delete");
    expect(archived).toMatchObject({ id: thread.id, lifecycle: "archived", report: null });
    expect(await registry.getActiveRun(WORKSPACE, thread.id)).toMatchObject({ outcome: "success" });
  });

  it("finds a deleted child session even when its runtime workspace differs from the parent catalog", async () => {
    const thread = await registry.createThread(createInput());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "child-worktree-session");
    await registry.dispose();

    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    const archived = await registry.archiveThreadsForDeletedSessionAcrossWorkspaces("child-worktree-session");
    expect(archived.map((entry) => entry.id)).toEqual([thread.id]);
    expect(await registry.getThread(WORKSPACE, PARENT, thread.id)).toMatchObject({ lifecycle: "archived" });
  });
});
