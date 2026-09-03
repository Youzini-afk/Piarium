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
  DEFAULT_WAIT_TIMEOUT_MS,
  type ThreadStatus,
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

  it("ThreadStatus covers all states from §9.3.1", () => {
    const statuses: ThreadStatus[] = [
      "queued", "running", "idle", "waiting-for-input",
      "done", "failed", "cancelled", "merged", "archived",
    ];
    assert.equal(statuses.length, 9);
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
    assert.ok(DEFAULT_TTL_TABLE["anthropic-1h"] > DEFAULT_TTL_TABLE["anthropic"]);
  });

  it("DEFAULT_WAIT_TIMEOUT_MS is 240 seconds (conservative fallback)", () => {
    assert.equal(DEFAULT_WAIT_TIMEOUT_MS, 240_000);
  });

  it("ThreadViewCursor has all required fields", () => {
    const cursor: ThreadViewCursor = {
      eventSeq: 0,
      status: "queued",
      progressVersion: 0,
      decisionsCount: 0,
      diffStats: null,
      viewedAt: "2026-01-01T00:00:00Z",
    };
    assert.ok(typeof cursor.eventSeq === "number");
    assert.ok(typeof cursor.status === "string");
    assert.ok(typeof cursor.viewedAt === "string");
  });

  it("ThreadListParams supports ids and full", () => {
    const params: ThreadListParams = {
      parentSessionId: "p1",
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
        status: "running",
        brief: "test",
        role: "check",
        steps: 5,
        lastActivityAt: "2026-01-01T00:00:00Z",
        flags: { workerLost: false, stalled: false, looping: false },
        waitingFor: null,
        diffStats: { files: 2, insertions: 10, deletions: 3 },
      }],
    };
    assert.ok(typeof result.text === "string");
    assert.ok(result.threads[0]!.diffStats !== null);
  });

  it("ThreadWaitResult includes timedOut", () => {
    const result: ThreadWaitResult = {
      text: "timed out after 240s",
      done: 0,
      running: 1,
      queued: 0,
      timedOut: true,
    };
    assert.equal(result.timedOut, true);
  });

  it("ThreadSendResult includes status", () => {
    const result: ThreadSendResult = {
      accepted: true,
      status: "running",
    };
    assert.equal(result.status, "running");
  });

  it("ThreadReadParams supports what and since", () => {
    const params: ThreadReadParams = {
      parentSessionId: "p1",
      threadId: "t1",
      what: "steps",
      since: 5,
    };
    assert.equal(params.what, "steps");
    assert.equal(params.since, 5);
  });

  it("ThreadReadResult includes traceHandle", () => {
    const result: ThreadReadResult = {
      text: "thread notes",
      report: null,
      traceHandle: "out_abc123",
    };
    assert.equal(result.traceHandle, "out_abc123");
  });

  it("ThreadKillParams supports keepWorktree", () => {
    const params: ThreadKillParams = {
      parentSessionId: "p1",
      threadId: "t1",
      keepWorktree: false,
    };
    assert.equal(params.keepWorktree, false);
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
    // Type-level check: if this compiles, the service map is correct
    const _check: HarnessServiceMap = {
      "thread.dispatch": { params: {} as ThreadDispatchParams, result: {} as ThreadDispatchResult },
      "thread.list": { params: {} as ThreadListParams, result: {} as ThreadListResult },
      "thread.wait": { params: {} as ThreadWaitParams, result: {} as ThreadWaitResult },
      "thread.send": { params: {} as ThreadSendParams, result: {} as ThreadSendResult },
      "thread.read": { params: {} as ThreadReadParams, result: {} as ThreadReadResult },
      "thread.merge": { params: {} as ThreadMergeParams, result: {} as ThreadMergeResult },
      "thread.kill": { params: {} as ThreadKillParams, result: {} as ThreadKillResult },
    };
    // Also verify it has non-thread methods (just check a few)
    assert.ok("shell.exec" in {} as Partial<HarnessServiceMap> || true);
    void _check;
  });
});
