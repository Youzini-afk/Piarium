/**
 * Protocol contract tests for thread types (§9.3).
 *
 * Verifies that the thread protocol types are structurally sound and
 * that the service map covers all thread methods.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isHarnessMethod,
  DEFAULT_TTL_TABLE,
  type Thread,
  type ThreadRun,
  type ThreadReadWhat,
  type ThreadViewCursor,
  type ThreadListParams,
  type ThreadListResult,
  type ThreadWaitParams,
  type ThreadWaitResult,
  type ThreadSendParams,
  type ThreadSendResult,
  type ThreadReadParams,
  type ThreadReadResult,
  type ThreadMergeParams,
  type ThreadMergeResult,
  type ThreadKillParams,
  type ThreadKillResult,
  type ThreadDispatchParams,
  type ThreadDispatchResult,
  type HarnessServiceMap,
  type HostEventData,
} from "../src/index.js";

describe("thread protocol types (§9.3)", () => {
  it("all thread methods are recognized by isHarnessMethod", () => {
    const threadMethods = [
      "thread.dispatch",
      "thread.list",
      "thread.wait",
      "thread.send",
      "thread.read",
      "thread.merge",
      "thread.kill",
    ];
    for (const method of threadMethods) {
      assert.ok(isHarnessMethod(method), `${method} should be a harness method`);
    }
  });

  it("separates durable work from an execution attempt", () => {
    const run: ThreadRun = {
      id: "run-1", threadId: "thread-1", attempt: 1, runtimeId: "pi", sessionId: "session-child",
      workerState: "lost", outcome: "lost", exitReason: "host restarted",
      tokens: { input: 1, output: 2, cacheRead: 3 }, costUsd: null, steps: 4, lastToolCall: null,
      startedAt: "2026-01-01T00:00:00Z", lastActivityAt: "2026-01-01T00:01:00Z", endedAt: "2026-01-01T00:01:00Z",
    };
    const thread: Thread = {
      id: "thread-1", parent: { kind: "session", id: "parent-1" }, workspaceId: "workspace-1",
      forkPoint: null, brief: "test", role: "check", model: null, createdBy: "agent", kind: "implementation",
      manifest: { carryBlocks: true, concurrency: 12, scope: [], systemPromptFragment: "Run checks.", tools: ["read", "bash"], worktree: "shared" },
      worktree: null, lifecycle: "active", attention: "permission", waitingFor: { kind: "permission", text: "allow?" },
      integration: "conflict", diffStats: null, report: null, activeRunId: run.id,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:01:00Z", eventSeq: 2, hidden: false,
    };
    assert.equal(thread.lifecycle, "active");
    assert.equal(thread.attention, "permission");
    assert.equal(thread.integration, "conflict");
    assert.equal(run.outcome, "lost");
  });

  it("ThreadReadWhat has exactly three options", () => {
    const whats: ThreadReadWhat[] = ["blocks", "report", "steps"];
    assert.equal(whats.length, 3);
  });

  it("DEFAULT_TTL_TABLE has entries for known providers", () => {
    assert.ok(typeof DEFAULT_TTL_TABLE["anthropic"] === "number");
    assert.ok(typeof DEFAULT_TTL_TABLE["openai"] === "number");
    assert.ok(typeof DEFAULT_TTL_TABLE["gemini"] === "number");
    // Anthropic 1h cache has longer TTL
    const anthropicTtl = DEFAULT_TTL_TABLE["anthropic"];
    const anthropic1hTtl = DEFAULT_TTL_TABLE["anthropic-1h"];
    assert.ok(typeof anthropicTtl === "number" && typeof anthropic1hTtl === "number");
    assert.ok(anthropic1hTtl > anthropicTtl);
  });

  it("ThreadViewCursor has all required fields", () => {
    const cursor: ThreadViewCursor = {
      eventSeq: 0,
      lifecycle: "queued",
      attention: "none",
      integration: "none",
      activeRunId: null,
      workerState: null,
      outcome: null,
      progressVersion: 0,
      decisionsCount: 0,
      diffStats: null,
      viewedAt: "2026-01-01T00:00:00Z",
    };
    assert.ok(typeof cursor.eventSeq === "number");
    assert.equal(cursor.lifecycle, "queued");
    assert.ok(typeof cursor.viewedAt === "string");
  });

  it("ThreadListParams supports ids and full", () => {
    const params: ThreadListParams = {
      ids: ["t1", "t2"],
      full: true,
    };
    assert.deepEqual(params.ids, ["t1", "t2"]);
    assert.equal(params.full, true);
  });

  it("ThreadListResult includes text and diffStats", () => {
    const result: ThreadListResult = {
      text: "2 threads · 1 changed",
      threads: [{
        id: "t1",
        lifecycle: "active",
        attention: "none",
        integration: "dirty",
        brief: "test",
        createdAt: "2026-01-01T00:00:00Z",
        role: "check",
        updatedAt: "2026-01-01T00:01:00Z",
        activeRun: null,
        waitingFor: null,
        diffStats: { files: 2, insertions: 10, deletions: 3 },
      }],
    };
    assert.ok(typeof result.text === "string");
    assert.ok(result.threads[0]!.diffStats !== null);
  });

  it("ThreadWaitResult includes timedOut and a waiting count", () => {
    const result: ThreadWaitResult = {
      text: "timed out after 240s — 0 done · 1 running · 1 waiting · 0 queued",
      done: 0,
      running: 1,
      // Idle / waiting-for-input threads need their own bucket: they are
      // the ones somebody has to answer (§9.3.5).
      waiting: 1,
      queued: 0,
      timedOut: true,
    };
    assert.equal(result.timedOut, true);
    assert.equal(result.waiting, 1);
  });

  it("ThreadSendResult reports orthogonal state", () => {
    const result: ThreadSendResult = {
      accepted: true,
      lifecycle: "active",
      attention: "none",
    };
    assert.equal(result.lifecycle, "active");
  });

  it("thread change events carry workspace, parent edge, and active Run separately", () => {
    const event = {
      workspaceId: "workspace-1",
      parent: { kind: "session", id: "parent-1" },
      thread: {} as Thread,
      activeRun: {} as ThreadRun,
    } satisfies HostEventData<"harness.thread.changed">;
    assert.equal(event.workspaceId, "workspace-1");
    assert.equal(event.parent.kind, "session");
  });

  it("ThreadReadParams supports what and since", () => {
    const params: ThreadReadParams = {
      threadId: "t1",
      what: "steps",
      since: 5,
    };
    assert.equal(params.what, "steps");
    assert.equal(params.since, 5);
  });

  it("ThreadReadResult carries a durable transcript reference", () => {
    const result: ThreadReadResult = {
      text: "thread notes",
      report: null,
      transcriptRef: { runtimeId: "pi", sessionId: "child-1", fromEntryId: null, toEntryId: null },
    };
    assert.equal(result.transcriptRef?.runtimeId, "pi");
  });

  it("ThreadKillParams supports keepWorktree", () => {
    const params: ThreadKillParams = {
      threadId: "t1",
      keepWorktree: false,
    };
    assert.equal(params.keepWorktree, false);
  });

  it("ThreadMergeParams can select an immutable native result revision", () => {
    const params: ThreadMergeParams = { threadId: "thread-1", resultRevision: 2 };
    assert.equal(params.resultRevision, 2);
  });

  it("ThreadDispatchResult includes queued", () => {
    const result: ThreadDispatchResult = {
      text: "queued as thread-abc",
      threadId: "thread-abc",
      queued: true,
    };
    assert.equal(result.queued, true);
  });

  it("HarnessServiceMap includes all thread methods", () => {
    // Type-level check: if this compiles, the thread method keys exist on HarnessServiceMap
    const _check: Partial<HarnessServiceMap> = {
      "thread.dispatch": { params: {} as ThreadDispatchParams, result: {} as ThreadDispatchResult },
      "thread.list": { params: {} as ThreadListParams, result: {} as ThreadListResult },
      "thread.wait": { params: {} as ThreadWaitParams, result: {} as ThreadWaitResult },
      "thread.send": { params: {} as ThreadSendParams, result: {} as ThreadSendResult },
      "thread.read": { params: {} as ThreadReadParams, result: {} as ThreadReadResult },
      "thread.merge": { params: {} as ThreadMergeParams, result: {} as ThreadMergeResult },
      "thread.kill": { params: {} as ThreadKillParams, result: {} as ThreadKillResult },
    };
    assert.ok("thread.dispatch" in _check);
    assert.ok("thread.wait" in _check);
    assert.ok("thread.kill" in _check);
    void _check;
  });
});
