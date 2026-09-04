/**
 * Phase 3 e2e integration test — thread tools through the full
 * bridge → router → service → thread registry chain.
 *
 * Tests: dispatch, threads (list), wait, read_thread, merge, kill.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHarnessServiceHost } from "../../../web/application-host/lib/harness/service-host.js";
import { createHarnessRouter } from "../../../web/application-host/lib/harness/router.js";
import { registerHarnessServices } from "../../../web/application-host/lib/harness/harness-services.js";
import { createThreadRegistry, type ThreadReport } from "../../../web/application-host/lib/harness/thread-registry.js";

import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createDispatchTool, createThreadsTool, createWaitTool, createReadThreadTool, createMergeTool, createKillTool } from "../../src/harness/thread-tools.js";
import { DEFAULT_WAIT_TIMEOUT_MS, resolveRoles } from "@piarium/protocol";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const SESSION_ID = "p3-e2e-session";
const WORKSPACE_ID = "p3-e2e-workspace";

async function setupP3E2E(options: {
  /** Transport defaults. A small value proves that a per-request timeout
   * (thread.wait) overrides them instead of being cut short. */
  transportTimeoutMs?: number;
} = {}) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "p3-e2e-"));
  const dataDir = mkdtempSync(join(tmpdir(), "p3-e2e-data-"));

  const threadRegistry = createThreadRegistry({ dataDir, hostId: "test-host" });

  // Mock spawn/kill/apply/send functions
  let sessionCounter = 0;
  const threadSpawnSession = async () => ({
    sessionId: `child-session-${++sessionCounter}`,
  });
  const threadKillSession = async (_threadId: string) => {};
  const threadApplyWorktreeDiff = async (_threadId: string) => ({
    merged: 3,
    conflicts: [] as string[],
  });
  const threadSendToSession = async (_sessionId: string, _message: string, _from: "user" | "parent-agent") => {};

  const harnessServiceHost = createHarnessServiceHost({
    search: async () => ({ status: "empty" as const, generation: undefined }),
    resolveWorkspaceRoot: async () => workspaceRoot,
    discoveredShells: {
      hasBash: process.platform !== "win32",
      hasPowerShell: process.platform === "win32",
    },
    threadRegistry,
    threadSpawnSession,
    threadKillSession,
    threadApplyWorktreeDiff,
    threadSendToSession,
  });
  harnessServiceHost.registerSession({ sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, workspaceRoot });

  let bridge: HostServicesBridge;
  const router = createHarnessRouter({
    respond: async (sessionId, requestId, outcome) => {
      bridge.respond(sessionId, requestId, outcome);
    },
    resolveWorkspace: async () => WORKSPACE_ID,
    ...(options.transportTimeoutMs !== undefined ? { defaultTimeoutMs: options.transportTimeoutMs } : {}),
  });
  registerHarnessServices(router, harnessServiceHost);

  const emittedRequests: Array<{ method: string; timeoutMs?: number }> = [];
  bridge = new HostServicesBridge({
    emit: (_event, data) => {
      emittedRequests.push({ method: data.method, ...(data.timeoutMs !== undefined ? { timeoutMs: data.timeoutMs } : {}) });
      void router.processEvent({
        kind: "host",
        sessionId: data.sessionId,
        envelope: { kind: "event", event: "harness.request", data },
      });
    },
    sessionId: SESSION_ID,
    defaultTimeoutMs: options.transportTimeoutMs ?? 10000,
  });

  return { workspaceRoot, dataDir, threadRegistry, harnessServiceHost, router, bridge, emittedRequests };
}

async function executeTool(
  tool: ToolDefinition,
  params: Record<string, unknown>,
): Promise<{ text: string; details: unknown; isError: boolean }> {
  const result = await tool.execute("test-call", params as never, undefined, undefined, undefined as never) as { content: Array<{ type: string; text: string }>; details?: unknown; isError?: boolean };
  return {
    text: result.content.map((c) => c.text).join("\n"),
    details: result.details,
    isError: result.isError === true,
  };
}

/** Roles a test session can dispatch: `check` plus the two main-model roles. */
const TEST_MAIN_MODEL = { providerId: "anthropic", modelId: "claude-sonnet-4" };
const TEST_ROLES = resolveRoles({ check: TEST_MAIN_MODEL }, TEST_MAIN_MODEL);

describe("Phase 3 e2e integration", () => {
  it("dispatch → bridge → router → registry: creates thread and spawns session", async () => {
    const { workspaceRoot, dataDir, threadRegistry, bridge, harnessServiceHost } = await setupP3E2E();
    try {
      const dispatchTool = createDispatchTool(bridge, SESSION_ID, TEST_ROLES);
      const { text, details } = await executeTool(dispatchTool, {
        role: "check",
        task: "run tests",
      });
      assert.match(text, /dispatched/, `dispatch should return "dispatched": got "${text}"`);
      const threadId = (details as { threadId: string }).threadId;
      assert.ok(threadId, "dispatch should return a threadId");

      // Verify thread was created in registry
      const thread = await threadRegistry.getThread(SESSION_ID, threadId);
      assert.ok(thread, "thread should exist in registry");
      assert.equal(thread!.brief, "run tests");
      assert.equal(thread!.role, "check");
      assert.equal(thread!.status, "running"); // setSessionId was called
      assert.ok(thread!.sessionId, "thread should have a sessionId");
    } finally {
      await harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("threads → bridge → router → registry: lists threads", async () => {
    const { workspaceRoot, dataDir, threadRegistry, bridge, harnessServiceHost } = await setupP3E2E();
    try {
      // Create two threads
      await threadRegistry.createThread({
        parentSessionId: SESSION_ID,
        brief: "task 1",
        role: "check",
        kind: "implementation",
        createdBy: "agent",
        autoRun: true,
        worktree: "isolated",
        tools: [],
        permissions: {},
      });
      await threadRegistry.createThread({
        parentSessionId: SESSION_ID,
        brief: "task 2",
        role: "explore",
        kind: "implementation",
        createdBy: "agent",
        autoRun: true,
        worktree: "isolated",
        tools: [],
        permissions: {},
      });

      const threadsTool = createThreadsTool(bridge, SESSION_ID);
      const { text } = await executeTool(threadsTool, {});
      // threads text shows thread IDs and status (incremental format)
      assert.match(text, /thread-\w+/, "threads should list at least one thread");
      assert.match(text, /queued/, "threads should show queued status");
    } finally {
      await harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("wait → bridge → router → registry: reports done/running/queued", async () => {
    const { workspaceRoot, dataDir, threadRegistry, bridge, harnessServiceHost } = await setupP3E2E();
    try {
      const thread = await threadRegistry.createThread({
        parentSessionId: SESSION_ID,
        brief: "running task",
        role: "check",
        kind: "implementation",
        createdBy: "agent",
        autoRun: true,
        worktree: "isolated",
        tools: [],
        permissions: {},
      });

      const waitTool = createWaitTool(bridge, SESSION_ID);
      // Use short timeout to avoid blocking the test
      const { text, details } = await executeTool(waitTool, { timeout_ms: 500 });
      assert.match(text, /0 done/, "wait should report 0 done");
      assert.match(text, /1 queued/, "wait should report 1 queued");
      const detailsObj = details as { done: number; running: number; queued: number; timedOut: boolean };
      assert.equal(detailsObj.queued, 1);
      assert.equal(detailsObj.done, 0);

      // Complete the thread and wait again — should return immediately due to state change
      await threadRegistry.setSessionId(SESSION_ID, thread.id, "session-child");
      const report: ThreadReport = {
        conclusion: "all tests pass",
        changedFiles: ["test.ts"],
        unresolved: [],
        deviations: [],
        confidence: 0.9,
        traceHandle: "trace-1",
        blocksSnapshot: {},
      };
      await threadRegistry.completeThread(SESSION_ID, thread.id, report);

      const { text: text2 } = await executeTool(waitTool, { timeout_ms: 5000 });
      assert.match(text2, /1 done/, "wait should report 1 done after completion");
    } finally {
      await harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("read_thread → bridge → router → registry: returns thread status and report", async () => {
    const { workspaceRoot, dataDir, threadRegistry, bridge, harnessServiceHost } = await setupP3E2E();
    try {
      const thread = await threadRegistry.createThread({
        parentSessionId: SESSION_ID,
        brief: "read me",
        role: "check",
        kind: "implementation",
        createdBy: "agent",
        autoRun: true,
        worktree: "isolated",
        tools: [],
        permissions: {},
      });
      await threadRegistry.setSessionId(SESSION_ID, thread.id, "session-child");
      const report: ThreadReport = {
        conclusion: "completed successfully",
        changedFiles: ["a.ts", "b.ts"],
        unresolved: ["c.ts"],
        deviations: [],
        confidence: 0.85,
        traceHandle: "trace-2",
        blocksSnapshot: {},
      };
      await threadRegistry.completeThread(SESSION_ID, thread.id, report);

      const readTool = createReadThreadTool(bridge, SESSION_ID);
      // Default what="blocks" shows status/notes; use what="report" for the full report
      const { text: blocksText } = await executeTool(readTool, { threadId: thread.id });
      assert.match(blocksText, /done/, "read_thread blocks should include status");
      const { text } = await executeTool(readTool, { threadId: thread.id, what: "report" });
      assert.match(text, /completed successfully/, "read_thread report should include conclusion");
      assert.match(text, /a\.ts/, "read_thread report should include changed files");
      assert.match(text, /0\.85/, "read_thread report should include confidence");
    } finally {
      await harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("merge → bridge → router → registry: merges completed thread", async () => {
    const { workspaceRoot, dataDir, threadRegistry, bridge, harnessServiceHost } = await setupP3E2E();
    try {
      const thread = await threadRegistry.createThread({
        parentSessionId: SESSION_ID,
        brief: "merge me",
        role: "check",
        kind: "implementation",
        createdBy: "agent",
        autoRun: true,
        worktree: "isolated",
        tools: [],
        permissions: {},
      });
      await threadRegistry.setSessionId(SESSION_ID, thread.id, "session-child");
      const report: ThreadReport = {
        conclusion: "done",
        changedFiles: ["a.ts"],
        unresolved: [],
        deviations: [],
        confidence: 1,
        traceHandle: "t",
        blocksSnapshot: {},
      };
      await threadRegistry.completeThread(SESSION_ID, thread.id, report);

      const mergeTool = createMergeTool(bridge, SESSION_ID);
      const { text } = await executeTool(mergeTool, { threadId: thread.id });
      assert.match(text, /merged 3 files/, "merge should report merged files");

      // Verify thread status is now merged
      const merged = await threadRegistry.getThread(SESSION_ID, thread.id);
      assert.equal(merged!.status, "merged");
    } finally {
      await harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("kill → bridge → router → registry: cancels thread", async () => {
    const { workspaceRoot, dataDir, threadRegistry, bridge, harnessServiceHost } = await setupP3E2E();
    try {
      const thread = await threadRegistry.createThread({
        parentSessionId: SESSION_ID,
        brief: "kill me",
        role: "check",
        kind: "implementation",
        createdBy: "agent",
        autoRun: true,
        worktree: "isolated",
        tools: [],
        permissions: {},
      });

      const killTool = createKillTool(bridge, SESSION_ID);
      const { text } = await executeTool(killTool, { threadId: thread.id });
      assert.match(text, /killed/, "kill should return killed message");

      const killed = await threadRegistry.getThread(SESSION_ID, thread.id);
      assert.equal(killed!.status, "cancelled");
    } finally {
      await harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });
});

/**
 * `wait` is the one call that is supposed to block for minutes. Both the
 * bridge and the router default to 30s, so unless the per-request timeout is
 * carried across the transport, a real `wait` dies at 30s with an error —
 * the exact opposite of "timing out is a normal result".
 *
 * These tests set both transport defaults to 200ms and ask for a longer
 * wait: with the timeout carried, the call blocks for the requested
 * duration; without it, the transport aborts at 200ms and the tool reports
 * an error instead.
 */
describe("Phase 3 e2e — wait blocks past the transport defaults", () => {
  /** Advance the observer cursor so a following `wait` has nothing new. */
  async function drainCursor(bridge: HostServicesBridge): Promise<void> {
    const threadsTool = createThreadsTool(bridge, SESSION_ID);
    await executeTool(threadsTool, {});
  }

  it("blocks for the requested timeout and reports a normal (non-error) timeout", async () => {
    const { workspaceRoot, dataDir, threadRegistry, bridge, harnessServiceHost } =
      await setupP3E2E({ transportTimeoutMs: 200 });
    try {
      const thread = await threadRegistry.createThread({
        parentSessionId: SESSION_ID,
        brief: "long runner",
        role: "check",
        kind: "implementation",
        createdBy: "agent",
        autoRun: true,
        worktree: "isolated",
        tools: [],
        permissions: {},
      });
      await threadRegistry.setSessionId(SESSION_ID, thread.id, "child-session-1");
      await drainCursor(bridge);

      const waitTool = createWaitTool(bridge, SESSION_ID);
      const startedAt = Date.now();
      const { text, details, isError } = await executeTool(waitTool, { timeout_ms: 1500 });
      const elapsed = Date.now() - startedAt;

      assert.ok(
        elapsed >= 1400,
        `wait must block for the requested 1500ms, not the 200ms transport default (elapsed ${elapsed}ms)`,
      );
      assert.equal(isError, false, "a wait timeout is a normal result, not a tool error");
      assert.equal((details as { timedOut: boolean }).timedOut, true);
      assert.match(text, /timed out after 2s/, "the timeout line must say so plainly");
    } finally {
      await harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("returns early when a thread starts waiting for input", async () => {
    const { workspaceRoot, dataDir, threadRegistry, bridge, harnessServiceHost } =
      await setupP3E2E({ transportTimeoutMs: 200 });
    try {
      const thread = await threadRegistry.createThread({
        parentSessionId: SESSION_ID,
        brief: "asks a question",
        role: "check",
        kind: "implementation",
        createdBy: "agent",
        autoRun: true,
        worktree: "isolated",
        tools: [],
        permissions: {},
      });
      await threadRegistry.setSessionId(SESSION_ID, thread.id, "child-session-1");
      await drainCursor(bridge);

      const timer = setTimeout(() => {
        void threadRegistry.setWaitingFor(SESSION_ID, thread.id, {
          kind: "user",
          text: "Which config file should I edit?",
        });
      }, 250);

      const waitTool = createWaitTool(bridge, SESSION_ID);
      const startedAt = Date.now();
      const { text, details, isError } = await executeTool(waitTool, { timeout_ms: 5000 });
      const elapsed = Date.now() - startedAt;
      clearTimeout(timer);

      assert.equal(isError, false);
      assert.equal((details as { timedOut: boolean }).timedOut, false, "the wait was woken, not timed out");
      assert.ok(elapsed < 4000, `wait must wake on the state change (elapsed ${elapsed}ms)`);
      assert.match(text, /waiting for user/, "the question must be surfaced — it is the actionable part");
      assert.match(text, /Which config file/);
    } finally {
      await harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("carries a timeout larger than the requested wait to the transport", async () => {
    // Guards the concrete numbers: the tool must ask the transport for more
    // than the wait itself needs, and the default wait must outlast the 30s
    // transport default it overrides. Uses a short wait so the assertion
    // costs milliseconds rather than four minutes.
    const { workspaceRoot, dataDir, bridge, harnessServiceHost, emittedRequests } =
      await setupP3E2E({ transportTimeoutMs: 200 });
    try {
      const waitTool = createWaitTool(bridge, SESSION_ID);
      await executeTool(waitTool, { timeout_ms: 300 });
      const waitRequest = emittedRequests.find((r) => r.method === "thread.wait");
      assert.ok(waitRequest, "wait must reach the transport");
      assert.equal(
        waitRequest!.timeoutMs,
        300 + 5_000,
        "the transport timeout must exceed the wait itself, or it cuts the wait short",
      );
      assert.ok(
        DEFAULT_WAIT_TIMEOUT_MS > 30_000,
        "the default wait must outlast the 30s transport default it overrides",
      );
    } finally {
      await harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });
});
