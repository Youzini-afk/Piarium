import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { HostEvent, HostEventData } from "@piarium/protocol";
import { SessionHost } from "../src/session-host.js";

describe("SessionHost recovery", () => {
  it("creates and applies a files-only named checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-host-recovery-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "tracked.txt"), "checkpoint", "utf8");
    const events: string[] = [];
    const host = new SessionHost({
      agentDir,
      emit: <E extends HostEvent>(event: E, _data: HostEventData<E>) => events.push(event),
      projectTrustOverride: true,
    });

    try {
      const snapshot = await host.create(cwd);
      const checkpoint = await host.createRecoveryCheckpoint(snapshot.sessionId, "Known good");
      await writeFile(join(cwd, "tracked.txt"), "changed", "utf8");
      const preview = await host.previewRecovery(
        snapshot.sessionId,
        "checkpoint",
        checkpoint.id,
        "after",
        "files",
      );
      assert.deepEqual(preview.changes, [{ kind: "modified", path: "tracked.txt" }]);
      const applied = await host.applyRecovery(snapshot.sessionId, preview.planId);
      assert.equal(applied.cancelled, false);
      assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "checkpoint");
      assert.equal((await host.listRecovery(snapshot.sessionId)).canUndo, true);
      assert.ok(events.includes("recovery.changed"));
    } finally {
      await host.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });
});
