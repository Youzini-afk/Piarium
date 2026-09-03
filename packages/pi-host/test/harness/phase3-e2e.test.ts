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
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const SESSION_ID = "p3-e2e-session";
const WORKSPACE_ID = "p3-e2e-workspace";

async function setupP3E2E() {
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
  });
  registerHarnessServices(router, harnessServiceHost);

  bridge = new HostServicesBridge({
    emit: (_event, data) => {
      void router.processEvent({
        kind: "host",
        sessionId: data.sessionId,
        envelope: { kind: "event", event: "harness.request", data },
      });
    },
    sessionId: SESSION_ID,
    defaultTimeoutMs: 10000,
  });

  return { workspaceRoot, dataDir, threadRegistry, harnessServiceHost, router, bridge };
}

async function executeTool(
  tool: ToolDefinition,
  params: Record<string, unknown>,
): Promise<{ text: string; details: unknown }> {
  const result = await tool.execute("test-call", params as never, undefined, undefined, undefined as never) as { content: Array<{ type: string; text: string }>; details?: unknown };
  return { text: result.content.map((c) => c.text).join("\n"), details: result.details };
}

describe("Phase 3 e2e integration", () => {
  it("dispatch → bridge → router → registry: creates thread and spawns session", async () => {
    const { workspaceRoot, dataDir, threadRegistry, bridge, harnessServiceHost } = await setupP3E2E();
    try {
      const dispatchTool = createDispatchTool(bridge, SESSION_ID);
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
