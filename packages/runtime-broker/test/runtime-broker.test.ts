import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { PiRuntimeBrokerEvent } from "../src/index.js";
import { PiRuntimeBroker } from "../src/index.js";

const HOST_ENTRY = resolve(import.meta.dirname, "../../pi-host/src/main.ts");

test("broker owns catalog and per-session Pi workers", async () => {
  const root = await mkdtemp(join(tmpdir(), "piarium-runtime-broker-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(workspace, ".pi", "extensions", "broker-smoke.ts"),
    `export default function extension(pi: any) {
      pi.registerCommand("broker-seed", {
        description: "Create a deterministic broker integration entry",
        handler: async () => pi.appendEntry("piarium.broker.smoke", { ready: true }),
      });
    }\n`,
  );
  const events: PiRuntimeBrokerEvent[] = [];
  const broker = new PiRuntimeBroker({
    agentDir,
    client: {
      clientName: "runtime-broker-test",
      clientVersion: "0.1.0",
      mode: "test",
    },
    emit: (event) => {
      events.push(event);
      if (event.kind === "host" && event.envelope.event === "project.trust.request") {
        throw new Error("observer failure must not block trust resolution");
      }
    },
    execArgv: ["--import", "tsx"],
    hostEntry: HOST_ENTRY,
    promptForProjectTrust: async () => ({ remember: false, trusted: true }),
  });

  try {
    const handshake = await broker.warmup();
    assert.equal(handshake.protocolVersion, 1);
    assert.equal(broker.catalogStarted, true);
    assert.deepEqual(await broker.listSessions(workspace), []);

    const created = await broker.createSession(workspace, "Broker smoke");
    assert.deepEqual(broker.activeSessionIds, [created.sessionId]);
    const commands = await broker.requestForSession(created.sessionId, "command.list", {
      sessionId: created.sessionId,
    });
    assert.ok(commands.some((command) => command.name === "broker-seed"));
    await broker.requestForSession(created.sessionId, "command.execute", {
      command: "/broker-seed",
      sessionId: created.sessionId,
    });
    const entries = await broker.requestForSession(created.sessionId, "session.entries", {
      branchOnly: true,
      sessionId: created.sessionId,
    });
    assert.ok(Array.isArray(entries));
    assert.ok(
      entries.some(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          !Array.isArray(entry) &&
          entry.type === "custom" &&
          entry.customType === "piarium.broker.smoke",
      ),
    );
    assert.equal((await broker.closeSession(created.sessionId)).closed, true);
    assert.deepEqual(broker.activeSessionIds, []);
    assert.ok(events.some((event) => event.kind === "host"));
  } finally {
    await broker.dispose();
    assert.equal(broker.workerCount, 0);
    await rm(root, { force: true, recursive: true });
  }
});
