import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKnowledgeContextRuntime } from "./context-runtime.js";
import { createGitStatusObserver } from "./git-status-runtime.js";
import { openWorkspaceKnowledge, type KnowledgeStore } from "./store.js";

const TEST_DIR = join(tmpdir(), "piarium-knowledge-context-runtime");

describe("knowledge context runtime", () => {
  let store: KnowledgeStore;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = await openWorkspaceKnowledge({
      dataDir: TEST_DIR,
      hostId: "host-1",
      workspaceId: "workspace-1",
      embedding: null,
    });
  });

  afterEach(async () => {
    await store.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("fans a user document mutation out to each session and advances an event cursor", async () => {
    const runtime = createKnowledgeContextRuntime({ getStore: async () => store });
    runtime.bindSession("session-a", "workspace-1");
    runtime.bindSession("session-b", "workspace-1");
    runtime.observeDocumentMutation({
      workspaceId: "workspace-1",
      resourceId: "src/user.ts",
      kind: "modified",
      owner: { kind: "web-route", id: "editor" },
    });
    const first = await runtime.zone2Material({
      sessionId: "session-a",
      sinceTurn: 0,
      contextUsage: { used: 200, window: 1000 },
    });
    expect(first.material.userEdits).toEqual([{ path: "src/user.ts", kind: "modified" }]);
    expect(first.material.contextUsage).toEqual({ used: 200, window: 1000 });
    expect(first.eventCursor).toBeGreaterThan(0);
    await expect(runtime.zone2Material({
      sessionId: "session-a",
      sinceTurn: 0,
      afterEventId: first.eventCursor,
      contextUsage: null,
    })).resolves.toMatchObject({ material: { userEdits: [] } });
    await expect(runtime.zone2Material({
      sessionId: "session-b",
      sinceTurn: 0,
      contextUsage: null,
    })).resolves.toMatchObject({ material: { userEdits: [{ path: "src/user.ts" }] } });
    await runtime.dispose();
  });

  it("projects only prompt-relevant accepted knowledge into Zone 2", async () => {
    const runtime = createKnowledgeContextRuntime({ getStore: async () => store });
    runtime.bindSession("session-a", "workspace-1");
    await store.putKnowledge({
      scope: "workspace",
      status: "accepted",
      content: "Use Vitest for component tests",
      trigger: "vitest component tests",
    });
    await store.putKnowledge({
      scope: "workspace",
      status: "accepted",
      content: "Unrelated release policy",
      trigger: "publishing releases",
    });
    const result = await runtime.zone2Material({
      sessionId: "session-a",
      sinceTurn: 0,
      query: "fix the vitest component tests",
      contextUsage: null,
    });
    expect(result.material.knowledge).toHaveLength(1);
    expect(result.material.knowledge[0]?.title).toContain("Vitest");
    await runtime.dispose();
  });

  it("keeps agent-authored events out of Zone 2 while preserving current blocks", async () => {
    const runtime = createKnowledgeContextRuntime({ getStore: async () => store });
    runtime.bindSession("session-a", "workspace-1");
    await store.upsertBlock({
      sessionId: "session-a",
      label: "plan",
      content: "- [ ] keep working",
      updatedBy: "agent",
    });
    runtime.observeDocumentMutation({
      workspaceId: "workspace-1",
      resourceId: "src/agent.ts",
      kind: "created",
      owner: { kind: "pi-worker", id: "worker-1" },
    });
    await runtime.drain();

    const result = await runtime.zone2Material({
      sessionId: "session-a",
      sinceTurn: 0,
      contextUsage: null,
    });
    expect(result.material.userEdits).toEqual([]);
    expect(result.material.blocks).toEqual([{ label: "plan", content: "- [ ] keep working" }]);
    expect(result.eventCursor).toBeGreaterThan(0);
    await runtime.dispose();
  });

  it("records diagnostics only when they follow a user-authored change", async () => {
    const runtime = createKnowledgeContextRuntime({ getStore: async () => store });
    runtime.bindSession("session-a", "workspace-1");
    runtime.observeDocumentMutation({
      workspaceId: "workspace-1",
      resourceId: "src/user.ts",
      kind: "modified",
      owner: { kind: "web-route", id: "editor" },
    });
    runtime.observeDiagnostics({
      workspaceId: "workspace-1",
      sessionId: "lsp",
      path: "src/user.ts",
      count: 2,
      worst: "error",
    });
    runtime.observeDocumentMutation({
      workspaceId: "workspace-1",
      resourceId: "src/agent.ts",
      kind: "modified",
      owner: { kind: "pi-worker", id: "worker" },
    });
    runtime.observeDiagnostics({
      workspaceId: "workspace-1",
      sessionId: "lsp",
      path: "src/agent.ts",
      count: 1,
      worst: "error",
    });
    await runtime.drain();

    const result = await runtime.zone2Material({
      sessionId: "session-a",
      sinceTurn: 0,
      contextUsage: null,
    });
    expect(result.material.newDiagnostics).toEqual([{ path: "src/user.ts", count: 2, worst: "error" }]);
    await runtime.dispose();
  });

  it("records Git state changes once per session instead of repeating status polls", async () => {
    const runtime = createKnowledgeContextRuntime({ getStore: async () => store });
    runtime.bindSession("session-a", "workspace-1");
    runtime.observeGitStatus({ workspaceId: "workspace-1", branch: "main", changed: 0 });
    await runtime.drain();
    const first = await runtime.zone2Material({ sessionId: "session-a", sinceTurn: 0, contextUsage: null });
    expect(first.material.git).toEqual({ branch: "main", changed: 0 });

    runtime.observeGitStatus({ workspaceId: "workspace-1", branch: "main", changed: 0 });
    await runtime.drain();
    const duplicate = await runtime.zone2Material({
      sessionId: "session-a",
      sinceTurn: 0,
      afterEventId: first.eventCursor,
      contextUsage: null,
    });
    expect(duplicate.material.git).toBeNull();
    expect(duplicate.eventCursor).toBe(first.eventCursor);

    runtime.resetSessionObservationBaselines("session-a");
    runtime.observeGitStatus({ workspaceId: "workspace-1", branch: "main", changed: 0 });
    await runtime.drain();
    const reset = await runtime.zone2Material({
      sessionId: "session-a",
      sinceTurn: 0,
      afterEventId: first.eventCursor,
      contextUsage: null,
    });
    expect(reset.material.git).toEqual({ branch: "main", changed: 0 });

    runtime.observeGitStatus({ workspaceId: "workspace-1", branch: "feature", changed: 2, note: "1 ahead" });
    await runtime.drain();
    const changed = await runtime.zone2Material({
      sessionId: "session-a",
      sinceTurn: 0,
      afterEventId: reset.eventCursor,
      contextUsage: null,
    });
    expect(changed.material.git).toEqual({ branch: "feature", changed: 2, note: "1 ahead" });
    await runtime.dispose();
  });

  it("carries a raw Git route snapshot through workspace resolution into Zone 2", async () => {
    const runtime = createKnowledgeContextRuntime({ getStore: async () => store });
    runtime.bindSession("session-a", "workspace-1");
    const observer = createGitStatusObserver({
      resolveWorkspaceId: async (scope) => scope === "/workspace/repo" ? "workspace-1" : null,
      observe: (event) => runtime.observeGitStatus(event),
    });
    observer("/workspace/repo", {
      current: "feature/git-observation",
      files: [{ path: "a.ts" }, { path: "b.ts" }],
      ahead: 1,
      behind: 0,
    });
    await Promise.resolve();
    await runtime.drain();
    const result = await runtime.zone2Material({ sessionId: "session-a", sinceTurn: 0, contextUsage: null });
    expect(result.material.git).toEqual({ branch: "feature/git-observation", changed: 2, note: "1 ahead" });
    await runtime.dispose();
  });
});
