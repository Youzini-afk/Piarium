import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createRequest,
  type EventEnvelope,
  ProtocolDecodeError,
  type ResponseEnvelope,
  type SessionSnapshot,
  type WireEnvelope,
} from "@piarium/protocol";
import { HostController } from "../src/host-controller.js";
import { MemoryHostTransport } from "../src/transport.js";

function isResponse(envelope: WireEnvelope, id: string): envelope is ResponseEnvelope {
  return envelope.kind === "response" && envelope.id === id;
}

function isEvent(envelope: WireEnvelope, event: string): envelope is EventEnvelope {
  return envelope.kind === "event" && envelope.event === event;
}

describe("HostController", () => {
  it("handshakes, trusts a project, loads an extension, and bridges its UI", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-host-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "extensions", "ui-test.ts"),
      `export default function extension(pi: any) {
        pi.registerCommand("ui-test", {
          description: "Exercise the Piarium extension UI bridge",
          handler: async (_args: string, ctx: any) => {
            const confirmed = await ctx.ui.confirm("Proceed?", "Confirm from test");
            ctx.ui.notify(confirmed ? "confirmed" : "cancelled", "info");
            ctx.ui.setEditorText("restored by extension");
            pi.appendEntry("piarium.test", { confirmed });
          },
        });
      }\n`,
    );

    const transport = new MemoryHostTransport();
    const controller = new HostController({ agentDir, transport });
    controller.start();
    try {
      transport.receive(
        createRequest("handshake", "host.handshake", {
          clientName: "host-test",
          clientVersion: "0.0.0",
          mode: "test",
          protocolVersions: [1],
        }),
      );
      const handshake = await transport.waitFor((entry) => isResponse(entry, "handshake"));
      assert.ok(handshake.kind === "response" && handshake.ok);

      transport.receive(createRequest("create", "session.create", { cwd }));
      const trustEvent = await transport.waitFor((entry) =>
        isEvent(entry, "project.trust.request"),
      );
      assert.ok(trustEvent.kind === "event" && trustEvent.event === "project.trust.request");
      transport.receive(
        createRequest("trust", "project.trust.respond", {
          remember: false,
          requestId: trustEvent.data.id,
          trusted: true,
        }),
      );
      const created = await transport.waitFor((entry) => isResponse(entry, "create"), 15_000);
      assert.ok(created.kind === "response" && created.ok);
      const snapshot = created.result as SessionSnapshot;
      assert.equal(snapshot.cwd, cwd);

      transport.receive(
        createRequest("commands", "command.list", { sessionId: snapshot.sessionId }),
      );
      const commands = await transport.waitFor((entry) => isResponse(entry, "commands"));
      assert.ok(commands.kind === "response" && commands.ok);
      assert.ok(
        (commands.result as Array<{ name: string }>).some((command) => command.name === "ui-test"),
      );

      transport.receive(
        createRequest("execute", "command.execute", {
          command: "/ui-test",
          sessionId: snapshot.sessionId,
        }),
      );
      const confirm = await transport.waitFor(
        (entry) =>
          isEvent(entry, "extension.ui.request") &&
          entry.event === "extension.ui.request" &&
          entry.data.method === "confirm",
      );
      assert.ok(confirm.kind === "event" && confirm.event === "extension.ui.request");
      assert.ok(confirm.data.id);
      transport.receive(
        createRequest("confirm", "extension.ui.respond", {
          requestId: confirm.data.id,
          value: true,
        }),
      );
      const executed = await transport.waitFor((entry) => isResponse(entry, "execute"));
      assert.ok(executed.kind === "response" && executed.ok);
      assert.ok(
        transport.sent.some(
          (entry) =>
            isEvent(entry, "extension.ui.request") &&
            entry.event === "extension.ui.request" &&
            entry.data.method === "setEditorText",
        ),
      );

      transport.receive(
        createRequest("entries", "session.entries", {
          branchOnly: false,
          sessionId: snapshot.sessionId,
        }),
      );
      const entries = await transport.waitFor((entry) => isResponse(entry, "entries"));
      assert.ok(entries.kind === "response" && entries.ok);
      assert.match(JSON.stringify(entries.result), /piarium\.test/);

      transport.receive(
        createRequest("bad-settings", "settings.update", {
          patch: { unsupportedSetting: true },
        }),
      );
      const badSettings = await transport.waitFor((entry) => isResponse(entry, "bad-settings"));
      assert.ok(badSettings.kind === "response" && !badSettings.ok);
      assert.equal(badSettings.error.code, "invalid_settings");
    } finally {
      await controller.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("returns structured errors for invalid client input", async () => {
    const transport = new MemoryHostTransport();
    const controller = new HostController({ transport });
    controller.start();
    try {
      transport.receive({
        id: "invalid",
        kind: "request",
        method: "session.create",
        params: {},
        v: 1,
      } as WireEnvelope);
      const response = await transport.waitFor((entry) => isResponse(entry, "invalid"));
      assert.ok(response.kind === "response" && !response.ok);
      assert.equal(response.error.code, "invalid_params");
    } finally {
      await controller.dispose();
    }
  });

  it("reports a bounded protocol error and closes a malformed connection", async () => {
    const transport = new MemoryHostTransport();
    const controller = new HostController({ transport });
    controller.start();
    transport.fail(new ProtocolDecodeError("frame_too_large", "Protocol frame is too large"));
    const failure = await transport.waitFor((entry) => isEvent(entry, "host.error"));
    assert.ok(failure.kind === "event" && failure.event === "host.error");
    assert.equal(failure.data.code, "frame_too_large");
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(
      () => transport.receive(createRequest("after-close", "host.shutdown", {})),
      /not started/i,
    );
  });

  it("serializes session lifecycle requests while allowing trust responses", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-host-queue-"));
    const agentDir = join(root, "agent");
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    const workspaces = [workspaceA, workspaceB];
    for (const workspace of workspaces) {
      await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
      await writeFile(
        join(workspace, ".pi", "extensions", "noop.ts"),
        "export default function noop() {}\n",
      );
    }
    const transport = new MemoryHostTransport();
    const controller = new HostController({ agentDir, transport });
    controller.start();
    try {
      transport.receive(createRequest("create-a", "session.create", { cwd: workspaceA }));
      transport.receive(createRequest("create-b", "session.create", { cwd: workspaceB }));
      const firstTrust = await transport.waitFor((entry) =>
        isEvent(entry, "project.trust.request"),
      );
      assert.ok(firstTrust.kind === "event" && firstTrust.event === "project.trust.request");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        transport.sent.filter((entry) => isEvent(entry, "project.trust.request")).length,
        1,
      );
      transport.receive(
        createRequest("trust-a", "project.trust.respond", {
          remember: false,
          requestId: firstTrust.data.id,
          trusted: true,
        }),
      );
      const createdA = await transport.waitFor((entry) => isResponse(entry, "create-a"));
      assert.ok(createdA.kind === "response" && createdA.ok);

      const secondTrust = await transport.waitFor(
        (entry) =>
          isEvent(entry, "project.trust.request") &&
          entry.event === "project.trust.request" &&
          entry.data.id !== firstTrust.data.id,
      );
      assert.ok(secondTrust.kind === "event" && secondTrust.event === "project.trust.request");
      transport.receive(
        createRequest("trust-b", "project.trust.respond", {
          remember: false,
          requestId: secondTrust.data.id,
          trusted: true,
        }),
      );
      const createdB = await transport.waitFor((entry) => isResponse(entry, "create-b"));
      assert.ok(createdB.kind === "response" && createdB.ok);
      assert.equal((createdB.result as SessionSnapshot).cwd, workspaceB);
    } finally {
      await controller.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });
});
