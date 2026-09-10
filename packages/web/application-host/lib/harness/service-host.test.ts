import { describe, expect, it } from "vitest";
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
});
