import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createThreadRegistry,
  type ThreadRecord,
  type ThreadReport,
} from "./thread-registry.js";

describe("thread registry", () => {
  let dataDir: string;
  let registry: ReturnType<typeof createThreadRegistry>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "thread-reg-"));
    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
  });

  afterEach(() => {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
  });

  it("createThread creates a queued thread", async () => {
    const record = await registry.createThread({
      parentSessionId: "parent-1",
      brief: "write tests",
      role: "check",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    expect(record.id).toMatch(/^thread-/);
    expect(record.status).toBe("queued");
    expect(record.brief).toBe("write tests");
    expect(record.role).toBe("check");
    expect(record.flags).toEqual({ workerLost: false, stalled: false, looping: false });
  });

  it("createThread with autoRun=false creates an idle thread", async () => {
    const record = await registry.createThread({
      parentSessionId: "parent-1",
      brief: "discuss approach",
      kind: "discussion",
      createdBy: "user",
      autoRun: false,
      worktree: "none",
      tools: [],
      permissions: {},
    });
    expect(record.status).toBe("idle");
    expect(record.role).toBeNull();
  });

  it("getThread returns the thread by id", async () => {
    const created = await registry.createThread({
      parentSessionId: "parent-1",
      brief: "test",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    const fetched = await registry.getThread("parent-1", created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
  });

  it("getThread returns null for unknown id", async () => {
    const fetched = await registry.getThread("parent-1", "nonexistent");
    expect(fetched).toBeNull();
  });

  it("listThreads returns all non-hidden threads", async () => {
    await registry.createThread({
      parentSessionId: "parent-1",
      brief: "task 1",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    await registry.createThread({
      parentSessionId: "parent-1",
      brief: "task 2",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
      hidden: true,
    });
    const visible = await registry.listThreads("parent-1");
    expect(visible.length).toBe(1);
    const all = await registry.listThreads("parent-1", true);
    expect(all.length).toBe(2);
  });

  it("setSessionId updates status to running", async () => {
    const created = await registry.createThread({
      parentSessionId: "parent-1",
      brief: "test",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    const updated = await registry.setSessionId("parent-1", created.id, "session-123");
    expect(updated!.status).toBe("running");
    expect(updated!.sessionId).toBe("session-123");
  });

  it("markWorkerLost sets the workerLost flag", async () => {
    const created = await registry.createThread({
      parentSessionId: "parent-1",
      brief: "test",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    const updated = await registry.markWorkerLost("parent-1", created.id);
    expect(updated!.flags.workerLost).toBe(true);
  });

  it("resumeThread clears workerLost and sets running", async () => {
    const created = await registry.createThread({
      parentSessionId: "parent-1",
      brief: "test",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    await registry.markWorkerLost("parent-1", created.id);
    const updated = await registry.resumeThread("parent-1", created.id);
    expect(updated!.flags.workerLost).toBe(false);
    expect(updated!.status).toBe("running");
  });

  it("cancelThread sets status to cancelled", async () => {
    const created = await registry.createThread({
      parentSessionId: "parent-1",
      brief: "test",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    const updated = await registry.cancelThread("parent-1", created.id, "user cancelled");
    expect(updated!.status).toBe("cancelled");
    expect(updated!.exitReason).toBe("user cancelled");
  });

  it("completeThread is idempotent", async () => {
    const created = await registry.createThread({
      parentSessionId: "parent-1",
      brief: "test",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    const report: ThreadReport = {
      conclusion: "done",
      changedFiles: ["a.ts"],
      unresolved: [],
      deviations: [],
      confidence: 0.9,
      traceHandle: "trace-1",
      blocksSnapshot: {},
    };
    const first = await registry.completeThread("parent-1", created.id, report);
    expect(first!.status).toBe("done");
    expect(first!.report).toEqual(report);
    // Second call should return the same record without changing
    const second = await registry.completeThread("parent-1", created.id, report);
    expect(second!.status).toBe("done");
    expect(second!.updatedAt).toBe(first!.updatedAt);
  });

  it("mergeThread sets status to merged", async () => {
    const created = await registry.createThread({
      parentSessionId: "parent-1",
      brief: "test",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    const report: ThreadReport = {
      conclusion: "done",
      changedFiles: [],
      unresolved: [],
      deviations: [],
      confidence: 1,
      traceHandle: "t",
      blocksSnapshot: {},
    };
    await registry.completeThread("parent-1", created.id, report);
    const merged = await registry.mergeThread("parent-1", created.id);
    expect(merged!.status).toBe("merged");
  });

  it("convertThread changes kind to implementation", async () => {
    const created = await registry.createThread({
      parentSessionId: "parent-1",
      brief: "discuss",
      kind: "discussion",
      createdBy: "user",
      autoRun: false,
      worktree: "none",
      tools: [],
      permissions: {},
    });
    const updated = await registry.convertThread("parent-1", created.id);
    expect(updated!.kind).toBe("implementation");
  });

  it("updateProgress updates steps and tokens", async () => {
    const created = await registry.createThread({
      parentSessionId: "parent-1",
      brief: "test",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    const updated = await registry.updateProgress("parent-1", created.id, {
      steps: 5,
      tokens: { input: 1000, output: 500 },
      lastToolCall: { name: "bash", at: "2026-09-03T12:00:00Z" },
    });
    expect(updated!.steps).toBe(5);
    expect(updated!.tokens.input).toBe(1000);
    expect(updated!.tokens.output).toBe(500);
    expect(updated!.lastToolCall!.name).toBe("bash");
  });

  it("setWaitingFor sets status to waiting-for-input", async () => {
    const created = await registry.createThread({
      parentSessionId: "parent-1",
      brief: "test",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    const updated = await registry.setWaitingFor("parent-1", created.id, {
      kind: "permission",
      text: "allow bash?",
    });
    expect(updated!.status).toBe("waiting-for-input");
    expect(updated!.waitingFor!.kind).toBe("permission");
    // Clear it
    const cleared = await registry.setWaitingFor("parent-1", created.id, null);
    expect(cleared!.status).toBe("running");
    expect(cleared!.waitingFor).toBeNull();
  });

  it("cancelAllForParent cancels all running threads", async () => {
    await registry.createThread({
      parentSessionId: "parent-1",
      brief: "task 1",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    await registry.createThread({
      parentSessionId: "parent-1",
      brief: "task 2",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    await registry.cancelAllForParent("parent-1");
    const threads = await registry.listThreads("parent-1", true);
    expect(threads.every((t) => t.status === "cancelled")).toBe(true);
  });

  it("persists across registry instances", async () => {
    const created = await registry.createThread({
      parentSessionId: "parent-1",
      brief: "persist test",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    // Create a new registry pointing to the same data dir
    const registry2 = createThreadRegistry({ dataDir, hostId: "test-host" });
    const fetched = await registry2.getThread("parent-1", created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.brief).toBe("persist test");
  });

  it("onThreadChanged callback is called on updates", async () => {
    const changes: ThreadRecord[] = [];
    const reg = createThreadRegistry({
      dataDir,
      hostId: "test-host",
      onThreadChanged: (_parentId, thread) => changes.push(thread),
    });
    const created = await reg.createThread({
      parentSessionId: "parent-1",
      brief: "callback test",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    expect(changes.length).toBe(1);
    expect(changes[0]!.id).toBe(created.id);
    await reg.cancelThread("parent-1", created.id);
    expect(changes.length).toBe(2);
    expect(changes[1]!.status).toBe("cancelled");
  });

  it("onThreadDone callback is called when thread completes", async () => {
    const doneCalls: Array<{ threadId: string; report: ThreadReport }> = [];
    const reg = createThreadRegistry({
      dataDir,
      hostId: "test-host",
      onThreadDone: (_parentId, threadId, report) => doneCalls.push({ threadId, report }),
    });
    const created = await reg.createThread({
      parentSessionId: "parent-1",
      brief: "done test",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    const report: ThreadReport = {
      conclusion: "all done",
      changedFiles: ["a.ts"],
      unresolved: [],
      deviations: [],
      confidence: 0.95,
      traceHandle: "trace-1",
      blocksSnapshot: {},
    };
    await reg.completeThread("parent-1", created.id, report);
    expect(doneCalls.length).toBe(1);
    expect(doneCalls[0]!.threadId).toBe(created.id);
    expect(doneCalls[0]!.report.conclusion).toBe("all done");
  });

  it("deleteThread removes the thread", async () => {
    const created = await registry.createThread({
      parentSessionId: "parent-1",
      brief: "delete me",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    const deleted = await registry.deleteThread("parent-1", created.id);
    expect(deleted).toBe(true);
    const fetched = await registry.getThread("parent-1", created.id);
    expect(fetched).toBeNull();
  });

  it("setFlags updates individual flags", async () => {
    const created = await registry.createThread({
      parentSessionId: "parent-1",
      brief: "flag test",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    const updated = await registry.setFlags("parent-1", created.id, { stalled: true });
    expect(updated!.flags.stalled).toBe(true);
    expect(updated!.flags.workerLost).toBe(false); // unchanged
  });

  // ── New tests for §9.3 redo ───────────────────────────────────────

  it("eventSeq increments on every state change", async () => {
    const created = await registry.createThread({
      parentSessionId: "parent-1",
      brief: "seq test",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    expect(created.eventSeq).toBeGreaterThan(0);
    const seq1 = created.eventSeq;
    const updated = await registry.setSessionId("parent-1", created.id, "session-1");
    expect(updated!.eventSeq).toBeGreaterThan(seq1);
  });

  it("observer cursor starts null and can be set/get", async () => {
    const created = await registry.createThread({
      parentSessionId: "parent-1",
      brief: "cursor test",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    expect(registry.getCursor("observer-1", created.id)).toBeNull();
    registry.setCursor("observer-1", created.id, {
      eventSeq: created.eventSeq,
      status: created.status,
      progressVersion: 0,
      decisionsCount: 0,
      diffStats: null,
      viewedAt: new Date().toISOString(),
    });
    const cursor = registry.getCursor("observer-1", created.id);
    expect(cursor).not.toBeNull();
    expect(cursor!.status).toBe("queued");
  });

  it("clearCursorsForSession removes all cursors for an observer", async () => {
    const t1 = await registry.createThread({
      parentSessionId: "parent-1",
      brief: "t1",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    const t2 = await registry.createThread({
      parentSessionId: "parent-1",
      brief: "t2",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    registry.setCursor("observer-1", t1.id, {
      eventSeq: 0, status: "queued", progressVersion: 0, decisionsCount: 0, diffStats: null, viewedAt: "",
    });
    registry.setCursor("observer-1", t2.id, {
      eventSeq: 0, status: "queued", progressVersion: 0, decisionsCount: 0, diffStats: null, viewedAt: "",
    });
    expect(registry.getCursor("observer-1", t1.id)).not.toBeNull();
    registry.clearCursorsForSession("observer-1");
    expect(registry.getCursor("observer-1", t1.id)).toBeNull();
    expect(registry.getCursor("observer-1", t2.id)).toBeNull();
  });

  it("subscribeToChanges is called when a thread changes", async () => {
    let called = 0;
    const unsub = registry.subscribeToChanges("parent-1", () => { called++; });
    await registry.createThread({
      parentSessionId: "parent-1",
      brief: "sub test",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    expect(called).toBeGreaterThan(0);
    unsub();
    const calledBefore = called;
    await registry.createThread({
      parentSessionId: "parent-1",
      brief: "after unsub",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    expect(called).toBe(calledBefore); // no more callbacks after unsubscribe
  });

  it("maxConcurrency limits active threads", async () => {
    const reg = createThreadRegistry({ dataDir, hostId: "test-host", maxConcurrency: 2 });
    // Create 2 running threads
    const t1 = await reg.createThread({
      parentSessionId: "parent-1",
      brief: "t1",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    await reg.setSessionId("parent-1", t1.id, "sess-1");
    const t2 = await reg.createThread({
      parentSessionId: "parent-1",
      brief: "t2",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    await reg.setSessionId("parent-1", t2.id, "sess-2");
    // Third thread should still be queued (concurrency full)
    const t3 = await reg.createThread({
      parentSessionId: "parent-1",
      brief: "t3",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    expect(t3.status).toBe("queued");
    expect(reg.maxConcurrency).toBe(2);
  });

  it("tryDequeue returns the oldest queued thread", async () => {
    const t1 = await registry.createThread({
      parentSessionId: "parent-1",
      brief: "first",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    await registry.createThread({
      parentSessionId: "parent-1",
      brief: "second",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    const dequeued = await registry.tryDequeue("parent-1");
    expect(dequeued).not.toBeNull();
    expect(dequeued!.id).toBe(t1.id); // oldest first
  });

  it("deleteThread cleans up cursors", async () => {
    const created = await registry.createThread({
      parentSessionId: "parent-1",
      brief: "cleanup",
      kind: "implementation",
      createdBy: "agent",
      autoRun: true,
      worktree: "isolated",
      tools: [],
      permissions: {},
    });
    registry.setCursor("observer-1", created.id, {
      eventSeq: 0, status: "queued", progressVersion: 0, decisionsCount: 0, diffStats: null, viewedAt: "",
    });
    expect(registry.getCursor("observer-1", created.id)).not.toBeNull();
    await registry.deleteThread("parent-1", created.id);
    expect(registry.getCursor("observer-1", created.id)).toBeNull();
  });
});
