import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { RuntimeBroker } from "../dist/main/runtime-broker.js";

const HOST_ENTRY = resolve(import.meta.dirname, "../../../packages/pi-host/dist/main.js");

test("desktop broker creates, commands, navigates, and disposes an isolated Pi worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "piarium-desktop-broker-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(workspace, ".pi", "extensions", "desktop-smoke.ts"),
    `export default function extension(pi: any) {
      pi.registerCommand("desktop-seed", {
        description: "Create a deterministic desktop integration entry",
        handler: async () => pi.appendEntry("piarium.desktop.smoke", { ready: true }),
      });
    }\n`,
  );
  const events = [];
  const broker = new RuntimeBroker({
    agentDir,
    emit: (event) => events.push(event),
    hostEntry: HOST_ENTRY,
    promptForProjectTrust: async () => ({ remember: false, trusted: true }),
  });

  try {
    assert.deepEqual(await broker.listSessions(workspace), []);
    const created = await broker.createSession(workspace, "Desktop smoke");
    const commands = await broker.requestForSession(created.sessionId, "command.list", {
      sessionId: created.sessionId,
    });
    assert.ok(commands.some((command) => command.name === "desktop-seed"));
    await broker.requestForSession(created.sessionId, "command.execute", {
      command: "/desktop-seed",
      sessionId: created.sessionId,
    });
    const entries = await broker.requestForSession(created.sessionId, "session.entries", {
      branchOnly: true,
      sessionId: created.sessionId,
    });
    assert.ok(Array.isArray(entries));
    const custom = entries.find(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        entry.type === "custom" &&
        entry.customType === "piarium.desktop.smoke",
    );
    assert.ok(custom && typeof custom.id === "string");
    const navigated = await broker.requestForSession(created.sessionId, "session.navigate", {
      sessionId: created.sessionId,
      summarize: false,
      targetId: custom.id,
    });
    assert.equal(navigated.cancelled, false);
    const settings = await broker.requestForSession(created.sessionId, "settings.get", {});
    assert.equal(typeof settings, "object");
    const checkpoint = await broker.requestForSession(
      created.sessionId,
      "recovery.checkpoint.create",
      { name: "Desktop broker checkpoint", sessionId: created.sessionId },
    );
    await writeFile(join(workspace, "temporary-change.txt"), "remove me", "utf8");
    const recoveryPreview = await broker.requestForSession(created.sessionId, "recovery.preview", {
      mode: "files",
      point: "after",
      sessionId: created.sessionId,
      targetId: checkpoint.id,
      targetKind: "checkpoint",
    });
    assert.equal(recoveryPreview.totalChanges, 1);
    const recovered = await broker.requestForSession(created.sessionId, "recovery.apply", {
      planId: recoveryPreview.planId,
      sessionId: created.sessionId,
    });
    assert.equal(recovered.cancelled, false);
    await assert.rejects(readFile(join(workspace, "temporary-change.txt"), "utf8"), /ENOENT/);
    assert.ok(events.some((event) => event.kind === "host"));
    assert.ok(
      events.some((event) => event.kind === "host" && event.envelope.event === "recovery.changed"),
    );
  } finally {
    await broker.dispose();
    await rm(root, { force: true, recursive: true });
  }
});
