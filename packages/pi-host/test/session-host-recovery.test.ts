import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { HostEvent, HostEventData } from "@piarium/protocol";
import { HostError } from "../src/errors.js";
import { SessionHost } from "../src/session-host.js";

describe("SessionHost recovery", () => {
  it("keeps conversation recovery Pi-native and never delegates workspace recovery to Pi packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-host-recovery-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    const extensionDir = join(cwd, ".pi", "extensions");
    const treeMarker = join(root, "workspace-history-tree.txt");
    const bridgeMarker = join(root, "recovery-bridge.txt");
    await mkdir(extensionDir, { recursive: true });
    await writeFile(
      join(extensionDir, "optional-recovery-packages.ts"),
      `import { writeFile } from "node:fs/promises";
export default function optionalRecovery(pi: any) {
  pi.on("session_before_tree", async () => writeFile(${JSON.stringify(treeMarker)}, "tree", "utf8"));
  pi.events.on("piarium.recovery.discover/v1", (request: any) => request.register({
    actions: ["navigate"], bridgeVersion: 1,
    execute: async () => { await writeFile(${JSON.stringify(bridgeMarker)}, "files", "utf8"); return { outcome: "applied" }; },
    id: "legacy-files-history", modes: ["files", "both"], name: "Legacy files history",
  }));
}
`,
      "utf8",
    );
    const events: string[] = [];
    const host = new SessionHost({
      agentDir,
      emit: <E extends HostEvent>(event: E, _data: HostEventData<E>) => events.push(event),
      projectTrustOverride: true,
    });

    try {
      const snapshot = await host.create(cwd);
      const manager = host.session.sessionManager;
      const userEntryId = manager.appendMessage({
        content: [
          { text: "restore this", type: "text" },
          { data: "aW1hZ2U=", mimeType: "image/png", type: "image" },
        ],
        role: "user",
        timestamp: Date.now(),
      });
      manager.appendCustomEntry("test.tail", {});

      assert.deepEqual(host.recoveryStatus(snapshot.sessionId), {
        actions: ["navigate", "undo"],
        available: true,
        issues: [],
        modes: ["conversation"],
        providers: [{
          actions: ["navigate", "undo"],
          active: true,
          id: "pi-native",
          modes: ["conversation"],
          name: "Pi session tree",
        }],
      });

      const conversation = await host.navigateRecovery(
        snapshot.sessionId,
        userEntryId,
        "conversation",
      );
      assert.equal(conversation.handledBy, "pi-native");
      assert.equal(conversation.editorText, "restore this");
      assert.deepEqual(conversation.editorImages, [
        { data: "aW1hZ2U=", mimeType: "image/png" },
      ]);
      await assert.rejects(access(treeMarker), { code: "ENOENT" });
      await assert.rejects(access(bridgeMarker), { code: "ENOENT" });

      for (const mode of ["files", "both"] as const) {
        await assert.rejects(
          host.navigateRecovery(snapshot.sessionId, userEntryId, mode),
          (error: unknown) => error instanceof HostError && error.code === "recovery_mode_unavailable",
        );
      }
      await assert.rejects(
        host.createRecoveryCheckpoint(snapshot.sessionId, "Known good"),
        (error: unknown) => error instanceof HostError && error.code === "recovery_action_unavailable",
      );
      await assert.rejects(
        host.repairRecovery(snapshot.sessionId, "recover"),
        (error: unknown) => error instanceof HostError && error.code === "recovery_action_unavailable",
      );
      assert.ok(events.includes("recovery.changed"));
    } finally {
      await host.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });
});
