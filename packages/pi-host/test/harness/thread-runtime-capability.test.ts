import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createRequest,
  PIARIUM_PROTOCOL_VERSION,
  type ResponseEnvelope,
  type SessionSnapshot,
  type WireEnvelope,
} from "@piarium/protocol";
import { HostController } from "../../src/host-controller.js";
import { MemoryHostTransport } from "../../src/transport.js";

const responseFor = (id: string) => (entry: WireEnvelope): entry is ResponseEnvelope => (
  entry.kind === "response" && entry.id === id
);

async function createSession(capabilities: { harnessThreads?: boolean; harnessWebRead?: boolean; harnessWebSearch?: boolean }): Promise<SessionSnapshot> {
  const root = await mkdtemp(join(tmpdir(), "piarium-thread-capability-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const transport = new MemoryHostTransport();
  const controller = new HostController({ agentDir, projectTrustOverride: true, transport });
  controller.start();
  try {
    transport.receive(createRequest("handshake", "host.handshake", {
      capabilities,
      clientName: "thread-capability-test",
      clientVersion: "0.0.0",
      mode: "test",
      protocolVersions: [PIARIUM_PROTOCOL_VERSION],
    }));
    const handshake = await transport.waitFor(responseFor("handshake"));
    assert.ok(handshake.kind === "response" && handshake.ok);

    transport.receive(createRequest("create", "session.create", { cwd }));
    const created = await transport.waitFor(responseFor("create"));
    assert.ok(created.kind === "response" && created.ok);
    return created.result as SessionSnapshot;
  } finally {
    await controller.dispose();
    await rm(root, { force: true, recursive: true });
  }
}

describe("Host-provided thread runtime capability", () => {
  it("registers thread tools only when the application Host advertises a real runtime", async () => {
    const available = await createSession({ harnessThreads: true });
    assert.ok(available.activeTools.includes("dispatch"));
    assert.ok(available.activeTools.includes("wait"));

    const unavailable = await createSession({ harnessThreads: false });
    assert.equal(unavailable.activeTools.includes("dispatch"), false);
    assert.equal(unavailable.activeTools.includes("wait"), false);
  });

  it("does not advertise websearch when the application Host has no real provider", async () => {
    const unavailable = await createSession({ harnessWebSearch: false });
    assert.equal(unavailable.activeTools.includes("websearch"), false);

    const available = await createSession({ harnessWebSearch: true });
    assert.ok(available.activeTools.includes("websearch"));
  });
});
