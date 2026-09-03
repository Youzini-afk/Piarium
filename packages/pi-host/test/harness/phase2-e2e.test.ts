/**
 * Phase 2 e2e integration test — todo and recall tools through the full
 * bridge → router → service → knowledge store chain.
 *
 * Also tests zone2.assemble and compaction.before service handlers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHarnessServiceHost } from "../../../web/application-host/lib/harness/service-host.js";
import { createHarnessRouter } from "../../../web/application-host/lib/harness/router.js";
import { registerHarnessServices } from "../../../web/application-host/lib/harness/harness-services.js";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../../../web/application-host/lib/knowledge/store.js";
import { DEFAULT_TODO_SETTINGS } from "../../../web/application-host/lib/harness/todo-tool.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../web/application-host/lib/harness/compaction.js";

import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createTodoTool } from "../../src/harness/todo-tool.js";
import { createRecallTool } from "../../src/harness/recall-tool.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Zone2Material } from "../../../web/application-host/lib/harness/zone2.js";
import type { CompactionHandlerDeps, CompactionFacts } from "../../../web/application-host/lib/harness/compaction.js";
import type { TodoToolDeps } from "../../../web/application-host/lib/harness/todo-tool.js";
import type { RecallToolDeps } from "../../../web/application-host/lib/harness/recall-tool.js";

const SESSION_ID = "p2-e2e-session";
const WORKSPACE_ID = "p2-e2e-workspace";

async function setupP2E2E() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "p2-e2e-"));
  const dataDir = mkdtempSync(join(tmpdir(), "p2-e2e-data-"));

  // Open a real knowledge store
  const knowledgeStore = await openWorkspaceKnowledge({
    dataDir,
    hostId: "test-host",
    workspaceId: WORKSPACE_ID,
    embedding: null,
  });

  // Seed a knowledge node for recall
  await knowledgeStore.putKnowledge({
    scope: "workspace",
    status: "accepted",
    title: "Test decision",
    content: "Always use typebox for schemas",
    trigger: "schema typebox",
    source: "agent",
  });

  // Zone 2 provider — returns material with a knowledge hit
  async function zone2Provider(_sessionId: string, _sinceTurn: number): Promise<Zone2Material> {
    return {
      userEdits: [{ path: "src/index.ts", kind: "modified" }],
      userCommands: [],
      newDiagnostics: [],
      git: { branch: "main", changed: 1 },
      knowledge: [],
      blocks: [{ label: "plan", content: "- [ ] test e2e" }],
      contextUsage: { used: 5000, window: 200000 },
    };
  }

  // Compaction deps provider
  async function compactionDepsProvider(sessionId: string): Promise<CompactionHandlerDeps> {
    return {
      store: knowledgeStore,
      settings: DEFAULT_COMPACTION_SETTINGS,
      getFacts: async (): Promise<CompactionFacts> => ({
        touchedFiles: ["src/index.ts"],
        unresolvedDiagnostics: [],
        checkpoints: [],
      }),
      getEntryIdAtTurn: (_turnsAgo: number) => "entry-1",
      getTokensBefore: () => 50000,
    };
  }

  // Todo deps provider
  async function todoDepsProvider(sessionId: string): Promise<TodoToolDeps> {
    return {
      store: knowledgeStore,
      sessionId,
      settings: DEFAULT_TODO_SETTINGS,
      askConfirmation: async (_message: string) => true,
    };
  }

  // Recall deps provider
  async function recallDepsProvider(_sessionId: string): Promise<RecallToolDeps> {
    return {
      workspaceStore: knowledgeStore,
      userStore: null,
    };
  }

  const harnessServiceHost = createHarnessServiceHost({
    search: async () => ({ status: "empty" as const, generation: undefined }),
    resolveWorkspaceRoot: async () => workspaceRoot,
    discoveredShells: {
      hasBash: process.platform !== "win32",
      hasPowerShell: process.platform === "win32",
    },
    zone2Provider,
    compactionDepsProvider,
    todoDepsProvider,
    recallDepsProvider,
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

  return { workspaceRoot, dataDir, knowledgeStore, harnessServiceHost, router, bridge };
}

async function executeTool(
  tool: ToolDefinition,
  params: Record<string, unknown>,
): Promise<{ text: string; details: unknown }> {
  const result = await tool.execute("test-call", params as never, undefined, undefined, undefined as never) as { content: Array<{ type: string; text: string }>; details?: unknown };
  return { text: result.content.map((c) => c.text).join("\n"), details: result.details };
}

describe("Phase 2 e2e integration", () => {
  it("todo tool → bridge → router → service → store: upsert plan", async () => {
    const { workspaceRoot, dataDir, knowledgeStore, bridge, harnessServiceHost } = await setupP2E2E();
    try {
      const todoTool = createTodoTool(bridge, SESSION_ID);
      const { text, details } = await executeTool(todoTool, {
        items: [
          { text: "write tests", status: "open" },
          { text: "run tests", status: "done" },
        ],
        confidence: 0.8,
      });

      assert.match(text, /plan updated/, `todo tool should return "plan updated": got "${text}"`);
      assert.match(text, /1\/2 done/, `todo tool should report 1/2 done: got "${text}"`);

      // Verify the plan block was written to the store
      const blocks = await knowledgeStore.getBlocks(SESSION_ID);
      const planBlock = blocks.find((b) => b.label === "plan");
      assert.ok(planBlock, "plan block should exist in store");
      assert.match(planBlock!.content, /write tests/, "plan block should contain 'write tests'");
      assert.match(planBlock!.content, /\[x\] run tests/, "plan block should mark 'run tests' as done");
    } finally {
      await harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("recall tool → bridge → router → service → store: search knowledge", async () => {
    const { workspaceRoot, dataDir, knowledgeStore, bridge, harnessServiceHost } = await setupP2E2E();
    try {
      const recallTool = createRecallTool(bridge, SESSION_ID);
      const { text, details } = await executeTool(recallTool, {
        query: "typebox schema",
        k: 5,
      });

      assert.match(text, /memories for/, `recall tool should return memories: got "${text}"`);
      assert.match(text, /Always use typebox/, `recall tool should find seeded knowledge: got "${text}"`);

      const detailsObj = details as { count: number; results: Array<{ scope: string; title: string }> };
      assert.ok(detailsObj.count > 0, "recall details should have count > 0");
    } finally {
      await harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("zone2.assemble → bridge → router → service: returns assembled content", async () => {
    const { workspaceRoot, dataDir, bridge, harnessServiceHost } = await setupP2E2E();
    try {
      const result = await bridge.request("zone2.assemble", { sinceTurn: 0 });
      assert.ok(result.content, "zone2.assemble should return non-null content");
      assert.match(result.content!, /piarium-context/, "zone2 content should contain piarium-context marker");
      assert.match(result.content!, /plan/, "zone2 content should contain plan section");
    } finally {
      await harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("compaction.before → bridge → router → service: returns custom summary", async () => {
    const { workspaceRoot, dataDir, bridge, harnessServiceHost } = await setupP2E2E();
    try {
      const result = await bridge.request("compaction.before", {
        sessionId: SESSION_ID,
        firstKeptEntryId: "test-entry",
        tokensBefore: 50000,
      });
      assert.ok(result.summary, "compaction.before should return a summary");
      assert.match(result.summary, /piarium-compaction/, "summary should contain piarium-compaction marker");
      assert.equal(result.firstKeptEntryId, "entry-1", "firstKeptEntryId should come from deps");
      assert.equal(result.tokensBefore, 50000, "tokensBefore should come from deps");
    } finally {
      await harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("compaction.after → bridge → router → service: returns acknowledged", async () => {
    const { workspaceRoot, dataDir, bridge, harnessServiceHost } = await setupP2E2E();
    try {
      const result = await bridge.request("compaction.after", {
        sessionId: SESSION_ID,
        summary: "test summary",
        firstKeptEntryId: "test-entry",
        tokensBefore: 50000,
      });
      assert.equal(result.acknowledged, true, "compaction.after should return acknowledged: true");
    } finally {
      await harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });
});
