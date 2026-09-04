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
  });

  it("accepts only the registered broker principal and preserves the current run", async () => {
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => "D:/workspace",
    });
    try {
      host.registerSession({
        actor: ACTOR,
        grantedCapabilities: ["read.output"],
        workspaceId: "workspace-1",
        workspaceRoot: "D:/workspace",
      });
      await expect(host.resolveActor({ ...ACTOR, runId: "run-2" })).resolves.toEqual({
        ...ACTOR,
        runId: "run-2",
        workspaceId: "workspace-1",
        grantedCapabilities: ["read.output"],
      });
      await expect(host.resolveActor({ ...ACTOR, workerId: "stale-worker" })).resolves.toBeNull();
      await expect(host.resolveActor({ ...ACTOR, workerGeneration: 2 })).resolves.toBeNull();
      await expect(host.resolveActor({ ...ACTOR, authorityInstanceId: "stale-authority" })).resolves.toBeNull();
      host.dropSession(ACTOR.sessionId);
      await expect(host.resolveActor(ACTOR)).resolves.toBeNull();
    } finally {
      await host.dispose();
    }
  });
});
