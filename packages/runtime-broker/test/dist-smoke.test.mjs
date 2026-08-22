import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { PIARIUM_PROTOCOL_VERSION } from "@piarium/protocol";
import { PiRuntimeBroker } from "../dist/index.js";

const HOST_ENTRY = resolve(import.meta.dirname, "../../pi-host/dist/host-bootstrap.js");

// The bundled Pi version is declared once, in the host package. Read it here instead of repeating
// the literal, so upgrading the runtime does not mean hunting for copies of the number in tests.
const pinnedPiVersion = () => {
  const manifest = JSON.parse(readFileSync(
    resolve(import.meta.dirname, "../../pi-host/package.json"),
    "utf8",
  ));
  const version = manifest.devDependencies?.["@earendil-works/pi-coding-agent"];
  assert.match(version ?? "", /^\d+\.\d+\.\d+$/, "pi-host must pin an exact Pi version");
  return version;
};

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
    assert.equal(handshake.protocolVersion, PIARIUM_PROTOCOL_VERSION);
    assert.equal(handshake.runtime.piVersion, pinnedPiVersion());
    assert.deepEqual(await broker.listSessions(agentDir), []);
  } finally {
    await broker.dispose();
    assert.equal(broker.workerCount, 0);
    assert.ok(events.some((event) => event.kind === "worker.exit" && event.expected));
    await rm(agentDir, { force: true, recursive: true });
  }
});
