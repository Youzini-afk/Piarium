import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiMessage, SessionEntriesResult, SessionSnapshot, SessionStats, SessionSummary } from "@piarium/protocol";
import { createThreadRegistry, type CreateThreadInput } from "./thread-registry.js";
import { createThreadRuntime, type ThreadSessionAdapter } from "./thread-runtime.js";

const WORKSPACE = "workspace-1";
const PARENT = { kind: "session", id: "parent-1" } as const;

const snapshot = (sessionId: string, cwd = "/workspace/thread"): SessionSnapshot => ({
  activeTools: ["read", "edit"],
  busy: false,
  cwd,
  features: { revision: 0, schemaVersion: 1 },
  followUp: [],
  followUpMode: "one-at-a-time",
  isCompacting: false,
  isStreaming: false,
  leafId: "entry-2",
  pendingMessageCount: 0,
  retryAttempt: 0,
  sessionId,
  steering: [],
  steeringMode: "all",
  thinkingLevel: "off",
  workspace: { authorityId: WORKSPACE, id: WORKSPACE, kind: "workspace" },
});

const summary = (sessionId: string): SessionSummary => ({
  allMessagesText: "",
  createdAt: "2026-09-04T00:00:00.000Z",
  cwd: "/workspace",
  firstMessage: "",
  id: sessionId,
  messageCount: 0,
  persisted: true,
  sessionFile: `/sessions/${sessionId}.jsonl`,
  updatedAt: "2026-09-04T00:00:00.000Z",
});

const stats: SessionStats = {
  cost: 0.25,
  sessionId: "child-1",
  tokens: { cacheRead: 30, cacheWrite: 0, input: 100, output: 20, total: 150 },
  totalMessages: 2,
  toolCalls: 3,
  toolResults: 3,
  assistantMessages: 1,
  userMessages: 1,
};

const assistantMessage = (text: string): PiMessage => ({
  api: "test",
  content: [{ type: "text", text }],
  model: "test-model",
  provider: "test-provider",
  role: "assistant",
  stopReason: "stop",
  timestamp: 0,
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  },
});

const createInput = (): CreateThreadInput => ({
  workspaceId: WORKSPACE,
  parent: PARENT,
  brief: "Implement the feature",
  role: "hard-implement",
  kind: "implementation",
  createdBy: "agent",
  concurrency: 12,
  autoRun: true,
  worktree: "isolated",
  model: { providerId: "test-provider", modelId: "test-model" },
  scope: ["src"],
  tools: ["read", "edit"],
  permissions: {},
  systemPromptFragment: "Work carefully.",
});

describe("thread runtime", () => {
  let dataDir: string;
  let registry: ReturnType<typeof createThreadRegistry>;
  let sessionAdapter: ThreadSessionAdapter;
  let runtime: ReturnType<typeof createThreadRuntime>;
  let sent: string[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "thread-runtime-"));
    registry = createThreadRegistry({ dataDir, hostId: "host-1" });
    sent = [];
    sessionAdapter = {
      create: vi.fn(async () => snapshot("child-1")),
      open: vi.fn(async (input) => snapshot(input.sessionId, input.cwd)),
      prompt: vi.fn(async (_sessionId, text) => { sent.push(text); }),
      send: vi.fn(async (_sessionId, text) => { sent.push(text); }),
      abort: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      summary: vi.fn(async (sessionId) => summary(sessionId)),
      stats: vi.fn(async () => stats),
      entries: vi.fn(async (): Promise<SessionEntriesResult> => ({
        sessionId: "child-1",
        scope: "branch",
        leafId: "entry-2",
        entries: [
          { id: "entry-1", parentId: null, timestamp: "2026-09-04T00:00:00.000Z", type: "message", message: { role: "user", content: "task", timestamp: 0 } },
          { id: "entry-2", parentId: "entry-1", timestamp: "2026-09-04T00:01:00.000Z", type: "message", message: assistantMessage("done") },
        ],
      })),
    };
    runtime = createThreadRuntime({
      registry,
      sessions: sessionAdapter,
      resolveWorkspaceRoot: async () => "/workspace",
      resolveRuntimeWorkspaceId: async () => "runtime-workspace-1",
      worktrees: {
        prepare: async () => ({ cwd: "/workspace/thread", worktree: { path: "/workspace/thread", base: "base" } }),
        inspect: async () => ({ patch: "", untracked: [], changedFiles: ["a.ts"], diffStats: { files: 1, insertions: 2, deletions: 0 } }),
        merge: async () => ({ merged: 1, conflicts: [], conflictState: "none", changedFiles: ["a.ts"], diffStats: { files: 1, insertions: 2, deletions: 0 } }),
      },
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await registry.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const start = async () => {
    const input = createInput();
    const thread = await registry.createThread(input);
    const run = await registry.startRun(WORKSPACE, thread.id);
    await runtime.spawn({ ...input, threadId: thread.id, runId: run.id });
    return { input, thread, run };
  };

  it("creates a real child session, selects its role model, and starts the Run", async () => {
    const { thread, run } = await start();
    expect(sessionAdapter.create).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/workspace/thread",
      parentSession: "/sessions/parent-1.jsonl",
      workspaceId: "runtime-workspace-1",
    }));
    expect(sessionAdapter.create).toHaveBeenCalledWith(expect.objectContaining({
      model: { providerId: "test-provider", modelId: "test-model" },
      scope: ["src"],
      tools: ["read", "edit"],
      workspaceId: "runtime-workspace-1",
    }));
    expect(sent[0]).toContain("Implement the feature");
    expect(sent[0]).toContain("Work carefully.");
    expect(await registry.getActiveRun(WORKSPACE, thread.id)).toMatchObject({ id: run.id, workerState: "running", sessionId: "child-1" });
    expect(await registry.getThread(WORKSPACE, PARENT, thread.id)).toMatchObject({ worktree: { path: "/workspace/thread", base: "base" } });
  });

  it("projects agent settlement into metrics, a durable transcript ref, and a report", async () => {
    const { thread } = await start();
    runtime.processEvent({
      kind: "host",
      sessionId: "child-1",
      envelope: { kind: "event", event: "agent.event", data: { event: { type: "agent_end", messages: [assistantMessage("Implemented it")], willRetry: false } } },
    });
    runtime.processEvent({
      kind: "host",
      sessionId: "child-1",
      envelope: { kind: "event", event: "agent.event", data: { event: { type: "agent_settled" } } },
    });
    await runtime.drain();
    expect(await registry.getActiveRun(WORKSPACE, thread.id)).toMatchObject({
      workerState: "exited",
      outcome: "success",
      tokens: { input: 100, output: 20, cacheRead: 30 },
    });
    expect(await registry.getThread(WORKSPACE, PARENT, thread.id)).toMatchObject({
      lifecycle: "settled",
      integration: "merge-ready",
      report: {
        conclusion: "Implemented it",
        changedFiles: ["a.ts"],
        transcriptRef: { sessionId: "child-1", fromEntryId: "entry-1", toEntryId: "entry-2" },
      },
    });
  });

  it("ends a crashed attempt as lost and automatically resumes the same Pi session in attempt two", async () => {
    const { thread } = await start();
    await registry.setAttention(WORKSPACE, thread.id, "user", { kind: "user", text: "Need input" });
    runtime.processEvent({ kind: "worker.exit", sessionId: "child-1", expected: false });
    await runtime.drain();
    expect((await registry.listRuns(WORKSPACE, thread.id))[0]).toMatchObject({ outcome: "lost" });

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if ((await registry.listRuns(WORKSPACE, thread.id)).length === 2) {
        const active = await registry.getActiveRun(WORKSPACE, thread.id);
        if (active?.workerState === "running") break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const runs = await registry.listRuns(WORKSPACE, thread.id);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ attempt: 2, sessionId: "child-1", workerState: "running" });
    expect((await registry.getThread(WORKSPACE, PARENT, thread.id))?.attention).toBe("user");
    expect(sessionAdapter.open).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "child-1", cwd: "/workspace/thread" }));
    expect(sent.at(-1)).toContain("previous worker was interrupted");
  });

  it("restarts a Run that crashed before a child session id was persisted", async () => {
    const input = createInput();
    const thread = await registry.createThread(input);
    const first = await registry.startRun(WORKSPACE, thread.id);
    await registry.endRun(WORKSPACE, thread.id, first.id, "lost", "host restarted");

    await runtime.resumeLostForParent(WORKSPACE, PARENT);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if ((await registry.getActiveRun(WORKSPACE, thread.id))?.workerState === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const runs = await registry.listRuns(WORKSPACE, thread.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ sessionId: null, outcome: "lost" });
    expect(runs[1]).toMatchObject({ sessionId: "child-1", workerState: "running" });
    expect(sessionAdapter.create).toHaveBeenCalledWith(expect.objectContaining({ tools: input.tools }));
  });

  it("stops automatic recovery after a second consecutive worker crash", async () => {
    const { thread } = await start();
    runtime.processEvent({ kind: "worker.exit", sessionId: "child-1", expected: false });
    await runtime.drain();
    expect(await registry.getActiveRun(WORKSPACE, thread.id)).toMatchObject({ attempt: 2, workerState: "running" });

    runtime.processEvent({ kind: "worker.exit", sessionId: "child-1", expected: false });
    await runtime.drain();
    expect(await registry.getActiveRun(WORKSPACE, thread.id)).toMatchObject({ attempt: 2, outcome: "lost" });
    expect(await registry.getThread(WORKSPACE, PARENT, thread.id)).toMatchObject({ attention: "stalled" });
    expect(await registry.listRuns(WORKSPACE, thread.id)).toHaveLength(2);
  });

  it("marks six identical tool calls as looping and clears the signal when activity changes", async () => {
    const { thread } = await start();
    for (let index = 0; index < 6; index += 1) {
      runtime.processEvent({
        kind: "host",
        sessionId: "child-1",
        envelope: {
          kind: "event",
          event: "agent.event",
          data: { event: { type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } } },
        },
      });
    }
    await runtime.drain();
    expect(await registry.getThread(WORKSPACE, PARENT, thread.id)).toMatchObject({ attention: "looping" });

    runtime.processEvent({
      kind: "host",
      sessionId: "child-1",
      envelope: {
        kind: "event",
        event: "agent.event",
        data: { event: { type: "tool_execution_start", toolName: "grep", args: { query: "different" } } },
      },
    });
    await runtime.drain();
    expect(await registry.getThread(WORKSPACE, PARENT, thread.id)).toMatchObject({ attention: "none" });
  });

  it("marks an event-silent Run as stalled and clears it on the next observed event", async () => {
    await runtime.dispose();
    runtime = createThreadRuntime({
      registry,
      sessions: sessionAdapter,
      resolveWorkspaceRoot: async () => "/workspace",
      resolveRuntimeWorkspaceId: async () => "runtime-workspace-1",
      stalledAfterMs: () => 20,
      worktrees: {
        prepare: async () => ({ cwd: "/workspace/thread", worktree: { path: "/workspace/thread", base: "base" } }),
        inspect: async () => ({ patch: "", untracked: [], changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
        merge: async () => ({ merged: 0, conflicts: [], conflictState: "none", changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
      },
    });
    const { thread } = await start();
    await new Promise((resolve) => setTimeout(resolve, 35));
    await runtime.drain();
    expect(await registry.getThread(WORKSPACE, PARENT, thread.id)).toMatchObject({ attention: "stalled" });

    runtime.processEvent({
      kind: "host",
      sessionId: "child-1",
      envelope: { kind: "event", event: "agent.event", data: { event: { type: "message_update" } } },
    });
    await runtime.drain();
    expect(await registry.getThread(WORKSPACE, PARENT, thread.id)).toMatchObject({ attention: "none" });
  });

  it("projects interactive child prompts as attention and clears them when execution resumes", async () => {
    const { thread } = await start();
    runtime.processEvent({
      kind: "host",
      sessionId: "child-1",
      envelope: {
        kind: "event",
        event: "extension.ui.request",
        data: {
          id: "request-1",
          method: "select",
          payload: { title: "Allow bash?", options: ["Allow once", "Allow for this session", "Deny"] },
        },
      },
    });
    await runtime.drain();
    expect(await registry.getThread(WORKSPACE, PARENT, thread.id)).toMatchObject({
      attention: "permission",
      waitingFor: { kind: "permission", text: "Allow bash?" },
    });

    runtime.processEvent({
      kind: "host",
      sessionId: "child-1",
      envelope: { kind: "event", event: "agent.event", data: { event: { type: "message_update" } } },
    });
    await runtime.drain();
    expect(await registry.getThread(WORKSPACE, PARENT, thread.id)).toMatchObject({
      attention: "none",
      waitingFor: null,
    });
  });

  it("sends parent input, cancels before closing, and merges through the recorded worktree", async () => {
    const { thread } = await start();
    await runtime.send("child-1", "Please also check tests", "parent-agent");
    expect(sent.at(-1)).toContain("Message from the parent agent");
    await expect(runtime.merge(WORKSPACE, PARENT, thread.id)).resolves.toMatchObject({ merged: 1, conflicts: [] });
    await runtime.kill(thread.id);
    expect(await registry.getActiveRun(WORKSPACE, thread.id)).toMatchObject({ outcome: "cancelled" });
    expect(sessionAdapter.abort).toHaveBeenCalledWith("child-1");
    expect(sessionAdapter.close).toHaveBeenCalledWith("child-1");
  });
});
