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
  });

  it("accepts only the registered broker principal and preserves the current run", async () => {
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => "D:/workspace",
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
});
