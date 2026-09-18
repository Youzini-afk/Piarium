import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { PIARIUM_PROTOCOL_VERSION } from "@piarium/protocol";
import { PiHostClient, PiRuntimeBroker, PiRuntimeLifecycle } from "../dist/index.js";

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

test("the production worker reports missing application files before launching Pi", async () => {
  const client = new PiHostClient({
    hostEntry: join(tmpdir(), 'piarium-no-such-install', 'missing-bootstrap.js'),
    handshake: { clientName: 'missing-host-test', clientVersion: '0.1.0', mode: 'test' },
  });
  try {
    await assert.rejects(client.start(), { code: 'host-entry-unavailable' });
  } finally {
    await client.dispose();
  }
});

test("bundled lifecycle starts one compiled worker without external discovery and reuses it for the catalog", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "piarium-runtime-broker-dist-"));
  const events = [];
  const brokers = [];
  const lifecycle = new PiRuntimeLifecycle({
    dataDir: agentDir,
    hostEntry: HOST_ENTRY,
    discovery: {
      commandRunner: async () => { throw new Error("bundled startup must not inspect system Pi or package managers"); },
    },
    createBroker: options => {
      const broker = new PiRuntimeBroker({
        ...options,
        agentDir,
        client: { clientName: "runtime-broker-dist-test", clientVersion: "0.1.0", mode: "test" },
        emit: event => events.push(event),
      });
      brokers.push(broker);
      return broker;
    },
  });

  try {
    const handshake = await lifecycle.start();
    assert.ok(handshake);
    assert.equal(handshake.protocolVersion, PIARIUM_PROTOCOL_VERSION);
    assert.equal(handshake.runtime.piVersion, pinnedPiVersion());
    assert.equal(handshake.runtime.source, "bundled");
    assert.equal(lifecycle.snapshot.status, "ready");
    assert.deepEqual(await lifecycle.listSessions(agentDir), []);
    await lifecycle.ensureActiveBroker();
    assert.equal(brokers.length, 1);
    assert.equal(brokers[0].workerCount, 1);
  } finally {
    await lifecycle.dispose();
    assert.ok(brokers.every(broker => broker.workerCount === 0));
    assert.ok(events.some((event) => event.kind === "worker.exit" && event.expected));
    await rm(agentDir, { force: true, recursive: true });
  }
});
