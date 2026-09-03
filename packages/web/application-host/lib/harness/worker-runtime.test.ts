import { describe, it, expect, beforeEach } from "vitest";
import {
  createWorkerRuntime,
  getTtl,
  DEFAULT_DISPATCH_SETTINGS,
  TTL_TABLE,
  DEFAULT_TTL,
  type SpawnChildInput,
  type ChildResult,
} from "./worker-runtime.js";
import { resolveRoles, ROLE_DEFINITIONS } from "./roles.js";
import type { SlotResolution } from "./model-slots.js";

const mainModel: SlotResolution = { providerId: "anthropic", modelId: "claude-sonnet-4" };
const haiku: SlotResolution = { providerId: "anthropic", modelId: "claude-haiku" };

function makeDeps(overrides: Partial<{
  spawnSession: (input: SpawnChildInput) => Promise<{ childId: string; sessionId: string }>;
  killSession: (childId: string) => Promise<void>;
  applyWorktreeDiff: (childId: string) => Promise<{ merged: number; conflicts: string[] }>;
}> = {}) {
  let counter = 0;
  return {
    settings: DEFAULT_DISPATCH_SETTINGS,
    spawnSession: overrides.spawnSession ?? (async () => ({
      childId: `child-${++counter}`,
      sessionId: `session-${counter}`,
    })),
    killSession: overrides.killSession ?? (async () => {}),
    applyWorktreeDiff: overrides.applyWorktreeDiff ?? (async () => ({ merged: 3, conflicts: [] })),
    now: () => 1_000_000,
  };
}

describe("getTtl", () => {
  it("returns anthropic TTL", () => {
    expect(getTtl("anthropic")).toBe(TTL_TABLE["anthropic"]);
  });

  it("returns extended TTL for 1h cache", () => {
    expect(getTtl("anthropic", true)).toBe(TTL_TABLE["anthropic-1h"]);
  });

  it("returns default for unknown provider", () => {
    expect(getTtl("unknown")).toBe(DEFAULT_TTL);
  });
});

describe("createWorkerRuntime", () => {
  it("spawnChild creates a running child", async () => {
    const runtime = createWorkerRuntime(makeDeps());
    const result = await runtime.spawnChild({
      parentSessionId: "p1",
      role: "check",
      task: "run tests",
      worktree: { mode: "shared" },
      model: haiku,
      tools: ["bash"],
      permissions: {},
      systemPromptFragment: "",
      budget: { maxTurns: 10, maxTokens: 1000 },
    });
    expect(result.childId).toBeDefined();
    const children = runtime.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0]?.status).toBe("running");
  });

  it("dispatch returns dispatched message", async () => {
    const runtime = createWorkerRuntime(makeDeps());
    const roles = resolveRoles({ check: haiku }, mainModel);
    const checkRole = roles.find((r) => r.id === "check")!;
    const result = await runtime.dispatch("check", "run tests", {
      resolvedRole: checkRole,
      parentSessionId: "p1",
    });
    expect(result).toContain("dispatched");
    expect(result).toContain("check");
  });

  it("dispatch queues when concurrency full", async () => {
    // Use a runtime that tracks running count without actually spawning
    let counter = 0;
    const runtime = createWorkerRuntime({
      settings: { concurrency: 2, staleAfterMs: 300000, askBefore: {} },
      spawnSession: async () => ({
        childId: `child-${++counter}`,
        sessionId: `session-${counter}`,
      }),
      killSession: async () => {},
      applyWorktreeDiff: async () => ({ merged: 0, conflicts: [] }),
      now: () => 1_000_000,
    });
    // Fill up concurrency (limit is 2)
    for (let i = 0; i < 2; i++) {
      await runtime.spawnChild({
        parentSessionId: "p1", role: "check", task: "test",
        worktree: { mode: "shared" }, model: haiku, tools: [],
        permissions: {}, systemPromptFragment: "", budget: { maxTurns: 1, maxTokens: 1 },
      });
    }
    const roles = resolveRoles({ check: haiku }, mainModel);
    const checkRole = roles.find((r) => r.id === "check")!;
    const result = await runtime.dispatch("check", "test", {
      resolvedRole: checkRole, parentSessionId: "p1",
    });
    expect(result).toContain("queued");
  });

  it("wait formats done/running/queued", async () => {
    const runtime = createWorkerRuntime(makeDeps());
    const result = await runtime.spawnChild({
      parentSessionId: "p1", role: "check", task: "test",
      worktree: { mode: "shared" }, model: haiku, tools: [],
      permissions: {}, systemPromptFragment: "", budget: { maxTurns: 1, maxTokens: 1 },
    });
    // Complete the child
    runtime.completeChild(result.childId, {
      changedFiles: ["a.ts"],
      conclusion: "all good",
      unresolved: [],
      confidence: 0.9,
      traceHandle: "trace1",
    });
    const waitResult = await runtime.wait([result.childId], 1000);
    expect(waitResult).toContain("1 done");
    expect(waitResult).toContain("✔");
    expect(waitResult).toContain("all good");
  });

  it("wait marks stale children", async () => {
    let currentTime = 1_000_000;
    const runtime = createWorkerRuntime({
      settings: { concurrency: 12, staleAfterMs: 5 * 60_000, askBefore: {} },
      spawnSession: async () => ({ childId: "c-stale", sessionId: "s-stale" }),
      killSession: async () => {},
      applyWorktreeDiff: async () => ({ merged: 0, conflicts: [] }),
      now: () => currentTime,
    });
    // Spawn at time 1_000_000
    const result = await runtime.spawnChild({
      parentSessionId: "p1", role: "check", task: "test",
      worktree: { mode: "shared" }, model: haiku, tools: [],
      permissions: {}, systemPromptFragment: "", budget: { maxTurns: 1, maxTokens: 1 },
    });
    // Advance time by 10 minutes
    currentTime = 1_000_000 + 10 * 60_000;
    const waitResult = await runtime.wait([result.childId], 1000);
    expect(waitResult).toContain("⚠ no activity");
  });

  it("merge returns success on clean merge", async () => {
    const runtime = createWorkerRuntime(makeDeps());
    const result = await runtime.spawnChild({
      parentSessionId: "p1", role: "check", task: "test",
      worktree: { mode: "isolated" }, model: haiku, tools: [],
      permissions: {}, systemPromptFragment: "", budget: { maxTurns: 1, maxTokens: 1 },
    });
    runtime.completeChild(result.childId, {
      changedFiles: ["a.ts", "b.ts"],
      conclusion: "done", unresolved: [], confidence: 1,
      traceHandle: "t1",
    });
    const mergeResult = await runtime.merge(result.childId);
    expect(mergeResult).toContain("merged 3 files");
  });

  it("merge returns conflicts", async () => {
    const runtime = createWorkerRuntime(makeDeps({
      applyWorktreeDiff: async () => ({ merged: 0, conflicts: ["a.ts", "b.ts"] }),
    }));
    const result = await runtime.spawnChild({
      parentSessionId: "p1", role: "check", task: "test",
      worktree: { mode: "isolated" }, model: haiku, tools: [],
      permissions: {}, systemPromptFragment: "", budget: { maxTurns: 1, maxTokens: 1 },
    });
    runtime.completeChild(result.childId, {
      changedFiles: [], conclusion: "done", unresolved: [],
      confidence: 1, traceHandle: "t1",
    });
    const mergeResult = await runtime.merge(result.childId);
    expect(mergeResult).toContain("conflicts");
    expect(mergeResult).toContain("a.ts");
    expect(mergeResult).toContain("b.ts");
  });

  it("kill terminates running child", async () => {
    let killed = false;
    const runtime = createWorkerRuntime(makeDeps({
      killSession: async () => { killed = true; },
    }));
    const result = await runtime.spawnChild({
      parentSessionId: "p1", role: "check", task: "test",
      worktree: { mode: "shared" }, model: haiku, tools: [],
      permissions: {}, systemPromptFragment: "", budget: { maxTurns: 1, maxTokens: 1 },
    });
    const killResult = await runtime.kill(result.childId);
    expect(killed).toBe(true);
    expect(killResult).toContain("killed");
  });

  it("killAllForParent cascades", async () => {
    const runtime = createWorkerRuntime(makeDeps());
    await runtime.spawnChild({
      parentSessionId: "p1", role: "check", task: "test",
      worktree: { mode: "shared" }, model: haiku, tools: [],
      permissions: {}, systemPromptFragment: "", budget: { maxTurns: 1, maxTokens: 1 },
    });
    await runtime.spawnChild({
      parentSessionId: "p1", role: "check", task: "test2",
      worktree: { mode: "shared" }, model: haiku, tools: [],
      permissions: {}, systemPromptFragment: "", budget: { maxTurns: 1, maxTokens: 1 },
    });
    await runtime.spawnChild({
      parentSessionId: "p2", role: "check", task: "test3",
      worktree: { mode: "shared" }, model: haiku, tools: [],
      permissions: {}, systemPromptFragment: "", budget: { maxTurns: 1, maxTokens: 1 },
    });
    await runtime.killAllForParent("p1");
    const children = runtime.getChildren();
    const p1Children = children.filter((c) => c.parentSessionId === "p1");
    expect(p1Children.every((c) => c.status === "killed")).toBe(true);
    const p2Children = children.filter((c) => c.parentSessionId === "p2");
    expect(p2Children[0]?.status).toBe("running");
  });
});
