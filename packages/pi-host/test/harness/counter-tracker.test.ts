import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarnessCounterTracker } from "../../src/harness/counter-tracker.js";

function createFakePi() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    pi: {
      on: (event: string, handler: (...args: unknown[]) => unknown) => { handlers.set(event, handler); },
    } as never,
    emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
    hasHandler: (event: string) => handlers.has(event),
  };
}

describe("harness counter tracker", () => {
  it("counts tool errors", () => {
    const tracker = createHarnessCounterTracker();
    const { pi, emit } = createFakePi();
    tracker.extension(pi);

    emit("tool_result", { type: "tool_result", toolName: "read", input: { path: "a" }, content: [{ type: "text", text: "ok" }], isError: false });
    emit("tool_result", { type: "tool_result", toolName: "edit", input: { path: "b" }, content: [{ type: "text", text: "fail" }], isError: true });
    emit("tool_result", { type: "tool_result", toolName: "write", input: { path: "c" }, content: [{ type: "text", text: "fail2" }], isError: true });

    const counters = tracker.getCounters();
    assert.equal(counters.toolErrors, 2);
  });

  it("counts output bytes from text content", () => {
    const tracker = createHarnessCounterTracker();
    const { pi, emit } = createFakePi();
    tracker.extension(pi);

    emit("tool_result", { type: "tool_result", toolName: "read", input: {}, content: [{ type: "text", text: "hello" }], isError: false });
    emit("tool_result", { type: "tool_result", toolName: "read", input: {}, content: [{ type: "text", text: "world" }], isError: false });

    const counters = tracker.getCounters();
    assert.equal(counters.outputBytes, 10); // "hello" (5) + "world" (5)
  });

  it("counts retries for same tool + same args within 3 steps", () => {
    const tracker = createHarnessCounterTracker();
    const { pi, emit } = createFakePi();
    tracker.extension(pi);

    // Step 1: call read with path "a"
    emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
    emit("tool_result", { type: "tool_result", toolName: "read", input: { path: "a" }, content: [{ type: "text", text: "x" }], isError: false });

    // Step 2: different args — not a retry
    emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 0 });
    emit("tool_result", { type: "tool_result", toolName: "read", input: { path: "b" }, content: [{ type: "text", text: "y" }], isError: false });

    // Step 3: same args as step 1 — retry!
    emit("turn_start", { type: "turn_start", turnIndex: 2, timestamp: 0 });
    emit("tool_result", { type: "tool_result", toolName: "read", input: { path: "a" }, content: [{ type: "text", text: "z" }], isError: false });

    const counters = tracker.getCounters();
    assert.equal(counters.toolRetries, 1);
  });

  it("does not count retries after 3 steps", () => {
    const tracker = createHarnessCounterTracker();
    const { pi, emit } = createFakePi();
    tracker.extension(pi);

    // Step 1
    emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 });
    emit("tool_result", { type: "tool_result", toolName: "read", input: { path: "a" }, content: [{ type: "text", text: "x" }], isError: false });

    // Step 5 (more than 3 steps later)
    emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 0 });
    emit("turn_start", { type: "turn_start", turnIndex: 2, timestamp: 0 });
    emit("turn_start", { type: "turn_start", turnIndex: 3, timestamp: 0 });
    emit("turn_start", { type: "turn_start", turnIndex: 4, timestamp: 0 });
    emit("tool_result", { type: "tool_result", toolName: "read", input: { path: "a" }, content: [{ type: "text", text: "z" }], isError: false });

    const counters = tracker.getCounters();
    assert.equal(counters.toolRetries, 0);
  });

  it("computes cacheHitRatio from cacheRead and input", () => {
    const tracker = createHarnessCounterTracker();
    const { pi } = createFakePi();
    tracker.extension(pi);

    // cacheRead=80, input=20 → ratio = 80/(80+20) = 0.8
    const counters = tracker.getCounters(80, 20);
    assert.equal(counters.cacheHitRatio, 0.8);
  });

  it("returns null cacheHitRatio when cacheRead and input are undefined", () => {
    const tracker = createHarnessCounterTracker();
    const { pi } = createFakePi();
    tracker.extension(pi);

    const counters = tracker.getCounters();
    assert.equal(counters.cacheHitRatio, null);
  });

  it("attributes auxiliary model usage to its slot without mutating returned snapshots", () => {
    const tracker = createHarnessCounterTracker();
    const usage = {
      input: 10,
      output: 3,
      cacheRead: 20,
      cacheWrite: 4,
      totalTokens: 37,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
    };
    tracker.recordModelUsage("reader", usage);
    tracker.recordModelUsage("reader", usage);
    tracker.recordModelUsage("permissionJudge", { ...usage, totalTokens: 12, cost: { ...usage.cost, total: 0.01 } });

    const first = tracker.getCounters();
    assert.deepEqual(first.modelSlotUsage.reader, {
      calls: 2,
      cost: 0.074,
      tokens: { cacheRead: 40, cacheWrite: 8, input: 20, output: 6, total: 74 },
    });
    assert.equal(first.modelSlotUsage.permissionJudge?.calls, 1);
    first.modelSlotUsage.reader!.calls = 99;
    assert.equal(tracker.getCounters().modelSlotUsage.reader?.calls, 2);
  });

  it("counts default observation views without counting explicit output slices", () => {
    const tracker = createHarnessCounterTracker();
    const { pi, emit } = createFakePi();
    tracker.extension(pi);
    const result = { type: "tool_result", content: [], isError: false };
    emit("tool_result", { ...result, toolName: "threads", input: {} });
    emit("tool_result", { ...result, toolName: "wait", input: {} });
    emit("tool_result", { ...result, toolName: "read_thread", input: { id: "t1" } });
    emit("tool_result", { ...result, toolName: "diagnostics", input: { path: "a.ts" } });
    emit("tool_result", { ...result, toolName: "diagnostics", input: { path: "a.ts", full: true } });
    emit("tool_result", { ...result, toolName: "get_output", input: { handle: "sh_1" } });
    emit("tool_result", { ...result, toolName: "get_output", input: { handle: "sh_1", offset: 0 } });
    emit("tool_result", { ...result, toolName: "get_output", input: { handle: "out_static" } });
    emit("tool_result", { ...result, toolName: "read", input: { path: "a.ts" } });
    assert.equal(tracker.getCounters().observationCalls, 5);
  });

  it("reset clears all counters", () => {
    const tracker = createHarnessCounterTracker();
    const { pi, emit } = createFakePi();
    tracker.extension(pi);

    emit("tool_result", { type: "tool_result", toolName: "read", input: {}, content: [{ type: "text", text: "hello" }], isError: true });
    assert.equal(tracker.getCounters().toolErrors, 1);
    assert.equal(tracker.getCounters().outputBytes, 5);

    tracker.reset();
    const counters = tracker.getCounters();
    assert.equal(counters.toolErrors, 0);
    assert.equal(counters.outputBytes, 0);
    assert.equal(counters.observationCalls, 0);
    assert.equal(counters.toolRetries, 0);
    assert.deepEqual(counters.modelSlotUsage, {});
  });
});
