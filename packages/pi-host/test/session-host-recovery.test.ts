import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { HostEvent, HostEventData } from "@piarium/protocol";
import { SessionHost } from "../src/session-host.js";

describe("SessionHost recovery", () => {
  it("uses Pi natively for conversation recovery and delegates workspace actions to plugins", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-host-recovery-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    const extensionDir = join(cwd, ".pi", "extensions");
    const treeMarker = join(root, "workspace-history-tree.txt");
    const checkpointMarker = join(root, "workspace-history-checkpoint.txt");
    const repairMarker = join(root, "pi-wtf-repair.txt");
    const bridgeMarker = join(root, "recovery-bridge.txt");
    await mkdir(extensionDir, { recursive: true });
    await writeFile(
      join(extensionDir, "pi-workspace-history.ts"),
      `import { writeFile } from "node:fs/promises";
export default function workspaceHistory(pi: any) {
  pi.on("session_before_tree", async () => {
    await writeFile(${JSON.stringify(treeMarker)}, "tree", "utf8");
  });
  pi.registerCommand("undo", {
    description: "Description text may change upstream",
    handler: async () => undefined,
  });
  pi.registerCommand("redo", {
    description: "Localized description",
    handler: async () => undefined,
  });
  pi.registerCommand("checkpoint", {
    description: "Create a named point",
    handler: async (name: string) => writeFile(${JSON.stringify(checkpointMarker)}, name, "utf8"),
  });
}
`,
      "utf8",
    );
    await writeFile(
      join(extensionDir, "pi-wtf.ts"),
      `import { writeFile } from "node:fs/promises";
export default function piWtf(pi: any) {
  pi.registerCommand("oops", {
    description: "Localized recovery description",
    handler: async () => writeFile(${JSON.stringify(repairMarker)}, "repair", "utf8"),
  });
  pi.registerCommand("oops?", {
    description: "Localized typo description",
    handler: async () => undefined,
  });
  pi.registerCommand("oops!", {
    description: "Localized destructive description",
    handler: async () => undefined,
  });
}
`,
      "utf8",
    );
    await writeFile(
      join(extensionDir, "recovery-bridge-provider.ts"),
      `import { writeFile } from "node:fs/promises";
export default function recoveryBridge(pi: any) {
  pi.events.on("piarium.recovery.discover/v1", (request: any) => {
    request.register({
      actions: ["navigate"],
      bridgeVersion: 1,
      execute: async () => {
        await writeFile(${JSON.stringify(bridgeMarker)}, "files", "utf8");
        return { outcome: "applied" };
      },
      id: "test-files-history",
      modes: ["files"],
      name: "Test files history",
      source: "project:test-files-history",
    });
  });
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

      const status = host.recoveryStatus(snapshot.sessionId);
      assert.ok(status.modes.includes("conversation"));
      assert.ok(status.modes.includes("both"));
      assert.ok(status.modes.includes("files"));
      assert.ok(status.actions.includes("checkpoint"));
      assert.ok(status.actions.includes("repair"));
      assert.ok(status.actions.includes("repair-typo"));
      assert.ok(status.actions.includes("repair-destructive"));
      assert.ok(status.providers.some((provider) => provider.id === "pi-workspace-history"));
      assert.ok(status.providers.some((provider) => provider.id === "pi-wtf"));

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

      const nextManager = host.session.sessionManager;
      const nextUserEntryId = nextManager.appendMessage({
        content: "restore workspace too",
        role: "user",
        timestamp: Date.now(),
      });
      nextManager.appendCustomEntry("test.tail", {});
      const filesOnly = await host.navigateRecovery(
        snapshot.sessionId,
        nextUserEntryId,
        "files",
      );
      assert.equal(filesOnly.handledBy, "test-files-history");
      assert.equal(filesOnly.outcome, "applied");
      assert.equal(await readFile(bridgeMarker, "utf8"), "files");
      const combined = await host.navigateRecovery(
        snapshot.sessionId,
        nextUserEntryId,
        "both",
      );
      assert.equal(combined.handledBy, "pi-workspace-history");
      assert.equal(combined.outcome, "applied");
      assert.equal(await readFile(treeMarker, "utf8"), "tree");

      const checkpoint = await host.createRecoveryCheckpoint(snapshot.sessionId, "Known good");
      assert.equal(checkpoint.handledBy, "pi-workspace-history");
      assert.equal(checkpoint.outcome, "unknown");
      assert.equal(await readFile(checkpointMarker, "utf8"), "Known good");

      const repaired = await host.repairRecovery(snapshot.sessionId, "recover");
      assert.equal(repaired.handledBy, "pi-wtf");
      assert.equal(repaired.outcome, "unknown");
      assert.equal(await readFile(repairMarker, "utf8"), "repair");
      assert.ok(events.includes("recovery.changed"));
    } finally {
      await host.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });
});
