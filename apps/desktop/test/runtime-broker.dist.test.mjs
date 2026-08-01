import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    assert.ok(events.some((event) => event.kind === "host"));
  } finally {
    await broker.dispose();
    await rm(root, { force: true, recursive: true });
  }
});
