import { describe, expect, it, vi } from "vitest";
import type { HarnessActorIdentity } from "@piarium/protocol";
import {
  createHarnessServiceHost,
  deriveHarnessCapabilities,
} from "./service-host.js";

const ACTOR: HarnessActorIdentity = {
  authorityInstanceId: "authority-1",
  sessionId: "session-1",
  workerId: "worker-1",
  workerGeneration: 3,
};

describe("harness service host authorization", () => {
  it("keeps a dropped session's command observable until shell shutdown finishes", async () => {
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => "D:/workspace",
      discoveredShells: { hasBash: true, gitBashPath: "bash.exe" },
    });
    host.registerSession({ actor: ACTOR, grantedCapabilities: ["process.shell"], workspaceId: "workspace-1", workspaceRoot: "D:/workspace" });
    const supervisor = host.getShellSupervisor(ACTOR.sessionId)!;
    let finish!: () => void;
    let active = true;
    const stopped = new Promise<void>((resolve) => { finish = () => { active = false; resolve(); }; });
    vi.spyOn(supervisor, "dispose").mockImplementation(() => stopped);
    vi.spyOn(supervisor, "hasActiveCommandAt").mockImplementation(() => active);
    try {
      host.dropSession(ACTOR.sessionId);
      expect(host.getShellSupervisor(ACTOR.sessionId)).toBeNull();
      expect(host.hasActiveCommandAtDirectory("D:/workspace")).toBe(true);
      let closed = false;
      const closing = host.closeSessionShell(ACTOR.sessionId).then(() => { closed = true; });
      await Promise.resolve();
      expect(closed).toBe(false);
      finish();
      await closing;
      expect(supervisor.dispose).toHaveBeenCalledTimes(1);
      expect(host.hasActiveCommandAtDirectory("D:/workspace")).toBe(false);
    } finally {
      finish();
      await host.dispose();
    }
  });

  it("preserves failed shell shutdown for observation and an explicit retry", async () => {
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => "D:/workspace",
      discoveredShells: { hasBash: true, gitBashPath: "bash.exe" },
    });
    host.registerSession({ actor: ACTOR, grantedCapabilities: ["process.shell"], workspaceId: "workspace-1", workspaceRoot: "D:/workspace" });
    const supervisor = host.getShellSupervisor(ACTOR.sessionId)!;
    let active = true;
    const shutdown = vi.spyOn(supervisor, "dispose")
      .mockRejectedValueOnce(new Error("PTY has not exited"))
      .mockImplementation(async () => { active = false; });
    vi.spyOn(supervisor, "hasActiveCommandAt").mockImplementation(() => active);
    try {
      await expect(host.closeSessionShell(ACTOR.sessionId)).rejects.toThrow("PTY has not exited");
      expect(host.hasActiveCommandAtDirectory("D:/workspace")).toBe(true);
      await host.closeSessionShell(ACTOR.sessionId);
      expect(shutdown).toHaveBeenCalledTimes(2);
      expect(host.hasActiveCommandAtDirectory("D:/workspace")).toBe(false);
    } finally {
      await host.dispose();
    }
  });

  it("derives structural authority from the tools frozen into the session", () => {
    expect(deriveHarnessCapabilities(["bash", "grep", "webfetch", "apply_patch"], {
      threadRuntime: false,
    })).toEqual([
      "context.session",
      "read.lsp",
      "read.output",
      "read.search",
      "read.web",
      "process.shell",
      "write.document",
    ]);
    expect(deriveHarnessCapabilities(["dispatch"], { threadRuntime: false })).not.toContain("control.thread");
    expect(deriveHarnessCapabilities(["dispatch"], { threadRuntime: true })).toContain("control.thread");
    expect(deriveHarnessCapabilities(["submit_facts"], { threadRuntime: true })).toContain("control.thread");
    expect(deriveHarnessCapabilities(["submit_facts"], { threadRuntime: false })).not.toContain("control.thread");
    expect(deriveHarnessCapabilities(["edit"], { threadRuntime: false })).toContain("write.document");
    expect(deriveHarnessCapabilities(["explore"], { threadRuntime: false })).toContain("read.search");
    expect(deriveHarnessCapabilities(["read"], { documentRead: true, threadRuntime: false })).toContain("read.document");
    expect(deriveHarnessCapabilities(["read"], { documentRead: false, threadRuntime: false })).not.toContain("read.document");
  });

  it("accepts only the registered broker principal and preserves the current run", async () => {
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => "D:/workspace",
      discoveredShells: {},
    });
    try {
      host.registerSession({
        actor: { ...ACTOR, workspaceScope: ["packages/web"] },
        grantedCapabilities: ["read.output"],
        workspaceId: "workspace-1",
        workspaceRoot: "D:/workspace",
      });
      host.observationCursors.set(ACTOR.sessionId, "shell", "sh_1", { offset: 10 });
      host.observationCursors.set(ACTOR.sessionId, "diagnostics", "D:/workspace/a.ts", { diagnostics: [] });
      host.registerSession({
        actor: { ...ACTOR, workspaceScope: ["packages/web"] },
        grantedCapabilities: ["read.output"],
        workspaceId: "workspace-1",
        workspaceRoot: "D:/workspace",
      });
      expect(host.observationCursors.get(ACTOR.sessionId, "shell", "sh_1")).toBeNull();
      expect(host.observationCursors.get(ACTOR.sessionId, "diagnostics", "D:/workspace/a.ts")).not.toBeNull();
      await expect(host.resolveActor({ ...ACTOR, runId: "run-2" })).resolves.toEqual({
        ...ACTOR,
        runId: "run-2",
        workspaceId: "workspace-1",
        workspaceScope: ["packages/web"],
        grantedCapabilities: ["read.output"],
      });
      await expect(host.resolveActor({ ...ACTOR, workerId: "stale-worker" })).resolves.toBeNull();
      await expect(host.resolveActor({ ...ACTOR, workerGeneration: 2 })).resolves.toBeNull();
      await expect(host.resolveActor({ ...ACTOR, authorityInstanceId: "stale-authority" })).resolves.toBeNull();
      host.observationCursors.set(ACTOR.sessionId, "shell", "sh_1", { offset: 10 });
      host.dropSession(ACTOR.sessionId);
      await expect(host.resolveActor(ACTOR)).resolves.toBeNull();
      expect(host.observationCursors.get(ACTOR.sessionId, "shell", "sh_1")).toBeNull();
    } finally {
      await host.dispose();
    }
  });

  it("drops explore queries when the same session is registered again", async () => {
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => "D:/workspace",
      discoveredShells: {},
    });
    try {
      host.registerSession({
        actor: ACTOR,
        grantedCapabilities: ["read.search"],
        workspaceId: "workspace-1",
        workspaceRoot: "D:/workspace",
      });
      const stored = host.exploreQueryStore.start({
        actor: {
          authorityInstanceId: ACTOR.authorityInstanceId,
          sessionId: ACTOR.sessionId,
          workerId: ACTOR.workerId,
          workerGeneration: ACTOR.workerGeneration,
          workspaceId: "workspace-1",
        },
        inputContext: { source: "disk" },
        input: { question: "needle" },
        deps: {
          rgSearch: async () => [],
          readFile: async () => ({ status: "ready", content: "needle", revision: "r1", source: "disk" }),
        },
        deadlineAt: Date.now() + 5_000,
        controller: new AbortController(),
      });
      expect(host.exploreQueryStore.get(ACTOR.sessionId, stored.id)).toBeDefined();
      host.registerSession({
        actor: { ...ACTOR, workerGeneration: 4 },
        grantedCapabilities: ["read.search"],
        workspaceId: "workspace-1",
        workspaceRoot: "D:/workspace",
      });
      expect(host.exploreQueryStore.get(ACTOR.sessionId, stored.id)).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });

  it("preserves the ThreadRun binding while a worker generation is re-registered", async () => {
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => "D:/workspace/thread",
      discoveredShells: {},
    });
    try {
      host.registerSession({
        actor: { ...ACTOR, runId: "run-1" }, grantedCapabilities: ["process.shell"],
        workspaceId: "workspace-1", workspaceRoot: "D:/workspace/thread",
      });
      host.verification.attachThreadSession(ACTOR.sessionId, {
        workspaceId: "workspace-1", threadId: "thread-1", runId: "run-1",
        worktreePath: "D:/workspace/thread", branchId: "thread-1",
        captureIdentity: async () => ({ treeHash: "tree" }),
      });
      host.dropSession(ACTOR.sessionId);
      expect(host.verification.sessionBinding(ACTOR.sessionId)).toMatchObject({
        scope: "child", threadId: "thread-1", runId: "run-1",
      });
      host.registerSession({
        actor: { ...ACTOR, workerGeneration: 2, runId: "run-1" }, grantedCapabilities: ["process.shell"],
        workspaceId: "workspace-1", workspaceRoot: "D:/workspace/thread",
      });
      expect(host.verification.sessionBinding(ACTOR.sessionId)).toMatchObject({
        scope: "child", threadId: "thread-1", runId: "run-1",
        actor: { workerGeneration: 2, runId: "run-1" },
      });
    } finally {
      await host.dispose();
    }
  });
});
