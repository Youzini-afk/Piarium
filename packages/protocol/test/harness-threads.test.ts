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
    const anthropicTtl = DEFAULT_TTL_TABLE["anthropic"];
    const anthropic1hTtl = DEFAULT_TTL_TABLE["anthropic-1h"];
    assert.ok(typeof anthropicTtl === "number" && typeof anthropic1hTtl === "number");
    assert.ok(anthropic1hTtl > anthropicTtl);
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

  it("ThreadSendResult includes status", () => {
    const result: ThreadSendResult = {
      accepted: true,
      status: "running",
    };
    assert.equal(result.status, "running");
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
