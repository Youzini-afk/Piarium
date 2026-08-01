import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { PiRuntimeBroker } from "../dist/index.js";

const HOST_ENTRY = resolve(import.meta.dirname, "../../pi-host/dist/main.js");

test("compiled broker handshakes with and disposes the compiled Pi host", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "piarium-runtime-broker-dist-"));
  const events = [];
  const broker = new PiRuntimeBroker({
    agentDir,
    client: {
      clientName: "runtime-broker-dist-test",
      clientVersion: "0.1.0",
      mode: "test",
    },
    emit: (event) => events.push(event),
    hostEntry: HOST_ENTRY,
  });

  try {
    const handshake = await broker.warmup();
    assert.equal(handshake.protocolVersion, 1);
    assert.equal(handshake.runtime.piVersion, "0.83.0");
    assert.deepEqual(await broker.listSessions(agentDir), []);
  } finally {
    await broker.dispose();
    assert.equal(broker.workerCount, 0);
    assert.ok(events.some((event) => event.kind === "worker.exit" && event.expected));
    await rm(agentDir, { force: true, recursive: true });
  }
});
