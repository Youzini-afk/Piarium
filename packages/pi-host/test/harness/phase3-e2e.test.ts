/** Thread tools through bridge → trusted router → durable Thread/ThreadRun registry. */
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
import {
  createDispatchTool,
  createKillTool,
  createMergeTool,
  createReadThreadTool,
  createThreadsTool,
  createWaitTool,
} from "../../src/harness/thread-tools.js";
import { HARNESS_MAX_REQUEST_TIMEOUT_MS, resolveRoles } from "@piarium/protocol";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const SESSION_ID = "p3-e2e-session";
const WORKSPACE_ID = "p3-e2e-workspace";
const PARENT = { kind: "session", id: SESSION_ID } as const;
const ACTOR = { authorityInstanceId: "test-authority", sessionId: SESSION_ID, workerId: "test-worker", workerGeneration: 1 } as const;
const CAPABILITIES = ["context.session", "control.thread", "read.lsp", "read.output"] as const;
const TEST_MAIN_MODEL = { providerId: "anthropic", modelId: "claude-sonnet-4" };
const TEST_ROLES = resolveRoles({ check: TEST_MAIN_MODEL }, TEST_MAIN_MODEL);

const threadInput = (brief: string) => ({
  workspaceId: WORKSPACE_ID,
  parent: PARENT,
  brief,
  role: "check",
  kind: "implementation" as const,
  createdBy: "agent" as const,
  concurrency: 12,
  autoRun: true,
  worktree: "isolated" as const,
  tools: [] as string[],
  permissions: {},
});

const report = (conclusion = "all tests pass"): ThreadReport => ({
  conclusion,
  changedFiles: ["test.ts"],
  unresolved: [],
  deviations: [],
  confidence: 0.9,
  transcriptRef: { runtimeId: "pi", sessionId: "child-1", fromEntryId: "entry-1", toEntryId: "entry-2" },
  blocksSnapshot: {},
});

async function setup(options: { transportTimeoutMs?: number } = {}) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "p3-e2e-"));
  const dataDir = mkdtempSync(join(tmpdir(), "p3-e2e-data-"));
  const threadRegistry = createThreadRegistry({ dataDir, hostId: "test-host" });
  let sessionCounter = 0;
  const sent: Array<{ sessionId: string; message: string }> = [];
  const harnessServiceHost = createHarnessServiceHost({
    search: async () => ({ status: "empty" as const, generation: undefined }),
    resolveWorkspaceRoot: async () => workspaceRoot,
    discoveredShells: { hasBash: process.platform !== "win32", hasPowerShell: process.platform === "win32" },
    threadRegistry,
    threadSpawnSession: async (input) => {
      const sessionId = `child-session-${++sessionCounter}`;
      await threadRegistry.markRunRunning(input.workspaceId, input.threadId, input.runId, sessionId);
      return { sessionId };
    },
    threadKillSession: async () => {},
    threadApplyWorktreeDiff: async () => ({ merged: 3, conflicts: [] }),
    threadSendToSession: async (sessionId, message) => { sent.push({ sessionId, message }); },
    threadTranscriptReader: {
      read: async (ref, since = 0) => `[entries ${since + 1}–2 of 2]\n${ref.sessionId}: durable transcript`,
    },
  });
  harnessServiceHost.registerSession({ actor: ACTOR, grantedCapabilities: CAPABILITIES, workspaceId: WORKSPACE_ID, workspaceRoot });

  let bridge: HostServicesBridge;
  const router = createHarnessRouter({
    respond: async (sessionId, requestId, outcome) => { bridge.respond(sessionId, requestId, outcome); },
    resolveActor: (identity) => harnessServiceHost.resolveActor(identity),
    ...(options.transportTimeoutMs !== undefined ? { defaultTimeoutMs: options.transportTimeoutMs } : {}),
  });
  registerHarnessServices(router, harnessServiceHost);
  const emittedRequests: Array<{ method: string; timeoutMs?: number }> = [];
  bridge = new HostServicesBridge({
    emit: (_event, data) => {
      emittedRequests.push({ method: data.method, ...(data.timeoutMs === undefined ? {} : { timeoutMs: data.timeoutMs }) });
      void router.processEvent({ actor: ACTOR, kind: "host", envelope: { kind: "event", event: "harness.request", data } });
    },
    sessionId: SESSION_ID,
    defaultTimeoutMs: options.transportTimeoutMs ?? 10_000,
  });

  const dispose = async () => {
    bridge.dispose();
    router.dispose();
    await harnessServiceHost.dispose();
    await threadRegistry.dispose();
    try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
  };
  return { bridge, threadRegistry, sent, emittedRequests, dispose };
}

async function executeTool(tool: ToolDefinition, params: Record<string, unknown>) {
  const result = await tool.execute("test-call", params as never, undefined, undefined, undefined as never) as {
    content: Array<{ type: string; text: string }>;
    details?: unknown;
    isError?: boolean;
  };
  return {
    text: result.content.map((part) => part.text).join("\n"),
    details: result.details,
    isError: result.isError === true,
  };
}

describe("Phase 3 Thread/ThreadRun e2e", () => {
  it("dispatch creates a Thread and a running attempt", async () => {
    const harness = await setup();
    try {
      const result = await executeTool(createDispatchTool(harness.bridge, SESSION_ID, TEST_ROLES), {
        role: "check",
        task: "run tests",
      });
      assert.match(result.text, /dispatched/);
      const threadId = (result.details as { threadId: string }).threadId;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if ((await harness.threadRegistry.getActiveRun(WORKSPACE_ID, threadId))?.workerState === "running") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const thread = await harness.threadRegistry.getThread(WORKSPACE_ID, PARENT, threadId);
      const run = await harness.threadRegistry.getActiveRun(WORKSPACE_ID, threadId);
      assert.equal(thread?.lifecycle, "active");
      assert.equal(run?.attempt, 1);
      assert.equal(run?.workerState, "running");
      assert.match(run?.sessionId ?? "", /^child-session-/);
    } finally {
      await harness.dispose();
    }
  });

  it("threads lists orthogonal state and becomes incremental", async () => {
    const harness = await setup();
    try {
      await harness.threadRegistry.createThread(threadInput("queued work"));
      const tool = createThreadsTool(harness.bridge, SESSION_ID);
      const first = await executeTool(tool, {});
      const second = await executeTool(tool, {});
      assert.match(first.text, /queued/);
      assert.match(second.text, /no changes since last view/);
    } finally {
      await harness.dispose();
    }
  });

  it("wait timeout is a normal result and outlives a smaller transport default", async () => {
    const harness = await setup({ transportTimeoutMs: 200 });
    try {
      const thread = await harness.threadRegistry.createThread(threadInput("long runner"));
      const run = await harness.threadRegistry.startRun(WORKSPACE_ID, thread.id);
      await harness.threadRegistry.markRunRunning(WORKSPACE_ID, thread.id, run.id, "child-1");
      await executeTool(createThreadsTool(harness.bridge, SESSION_ID), {});
      const started = Date.now();
      const result = await executeTool(createWaitTool(harness.bridge, SESSION_ID), { timeout_ms: 600 });
      assert.ok(Date.now() - started >= 500);
      assert.equal(result.isError, false);
      assert.equal((result.details as { timedOut: boolean }).timedOut, true);
      assert.match(result.text, /timed out/);
    } finally {
      await harness.dispose();
    }
  });

  it("wait wakes on attention and preserves the question", async () => {
    const harness = await setup({ transportTimeoutMs: 200 });
    try {
      const thread = await harness.threadRegistry.createThread(threadInput("ask"));
      const run = await harness.threadRegistry.startRun(WORKSPACE_ID, thread.id);
      await harness.threadRegistry.markRunRunning(WORKSPACE_ID, thread.id, run.id, "child-1");
      await executeTool(createThreadsTool(harness.bridge, SESSION_ID), {});
      const timer = setTimeout(() => {
        void harness.threadRegistry.setAttention(WORKSPACE_ID, thread.id, "user", { kind: "user", text: "Which config?" });
      }, 100);
      const result = await executeTool(createWaitTool(harness.bridge, SESSION_ID), { timeout_ms: 2_000 });
      clearTimeout(timer);
      assert.equal((result.details as { timedOut: boolean }).timedOut, false);
      assert.match(result.text, /waiting for user/);
      assert.match(result.text, /Which config/);
    } finally {
      await harness.dispose();
    }
  });

  it("read_thread and merge use the settled run plus Thread integration", async () => {
    const harness = await setup();
    try {
      const thread = await harness.threadRegistry.createThread(threadInput("finish"));
      const run = await harness.threadRegistry.startRun(WORKSPACE_ID, thread.id);
      await harness.threadRegistry.markRunRunning(WORKSPACE_ID, thread.id, run.id, "child-1");
      await harness.threadRegistry.completeThread(WORKSPACE_ID, thread.id, report("completed successfully"));
      const readResult = await executeTool(createReadThreadTool(harness.bridge, SESSION_ID), { threadId: thread.id, what: "report" });
      assert.match(readResult.text, /completed successfully/);
      const steps = await executeTool(createReadThreadTool(harness.bridge, SESSION_ID), { threadId: thread.id, what: "steps", since: 1 });
      assert.match(steps.text, /child-1: durable transcript/);
      const mergeResult = await executeTool(createMergeTool(harness.bridge, SESSION_ID), { threadId: thread.id });
      assert.match(mergeResult.text, /merged 3 files/);
      assert.equal((await harness.threadRegistry.getThread(WORKSPACE_ID, PARENT, thread.id))?.integration, "merged");
    } finally {
      await harness.dispose();
    }
  });

  it("kill ends the current Run instead of rewriting it as an unstarted thread", async () => {
    const harness = await setup();
    try {
      const thread = await harness.threadRegistry.createThread(threadInput("stop"));
      const run = await harness.threadRegistry.startRun(WORKSPACE_ID, thread.id);
      await harness.threadRegistry.markRunRunning(WORKSPACE_ID, thread.id, run.id, "child-1");
      const result = await executeTool(createKillTool(harness.bridge, SESSION_ID), { threadId: thread.id });
      assert.match(result.text, /killed/);
      assert.equal((await harness.threadRegistry.getActiveRun(WORKSPACE_ID, thread.id))?.outcome, "cancelled");
      assert.equal((await harness.threadRegistry.getThread(WORKSPACE_ID, PARENT, thread.id))?.lifecycle, "settled");
    } finally {
      await harness.dispose();
    }
  });

  it("uses the explicit transport ceiling only as a deadline, not a cache wake schedule", async () => {
    const harness = await setup({ transportTimeoutMs: 200 });
    try {
      await executeTool(createWaitTool(harness.bridge, SESSION_ID), { timeout_ms: 50 });
      const request = harness.emittedRequests.find((entry) => entry.method === "thread.wait");
      assert.equal(request?.timeoutMs, 5_050);
      assert.ok((request?.timeoutMs ?? 0) < HARNESS_MAX_REQUEST_TIMEOUT_MS);
    } finally {
      await harness.dispose();
    }
  });
});
