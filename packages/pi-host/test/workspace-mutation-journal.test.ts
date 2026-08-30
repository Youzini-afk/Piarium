import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createRequest,
  type EventEnvelope,
  type HostEvent,
  type HostEventData,
  PIARIUM_PROTOCOL_VERSION,
  type ResponseEnvelope,
  type WireEnvelope,
} from "@piarium/protocol";
import { HostController } from "../src/host-controller.js";
import { SessionHost } from "../src/session-host.js";
import { MemoryHostTransport } from "../src/transport.js";
import {
  createWorkspaceMutationJournalTools,
  WorkspaceMutationJournalBridge,
} from "../src/workspace-mutation-journal.js";

type MutationRequest = HostEventData<"workspace.mutation.request">;

class MutationEventCollector {
  readonly seen: MutationRequest[] = [];
  readonly #waiting: Array<(event: MutationRequest) => void> = [];

  emit<E extends HostEvent>(event: E, data: HostEventData<E>): void {
    if (event !== "workspace.mutation.request") return;
    const mutation = data as MutationRequest;
    const waiting = this.#waiting.shift();
    if (waiting) waiting(mutation);
    else this.seen.push(mutation);
  }

  next(): Promise<MutationRequest> {
    const existing = this.seen.shift();
    if (existing) return Promise.resolve(existing);
    return new Promise<MutationRequest>((resolveEvent, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for workspace mutation event")),
        5_000,
      );
      this.#waiting.push((event) => {
        clearTimeout(timeout);
        resolveEvent(event);
      });
    });
  }
}

function isResponse(envelope: WireEnvelope, id: string): envelope is ResponseEnvelope {
  return envelope.kind === "response" && envelope.id === id;
}

function isMutationEvent(envelope: WireEnvelope): envelope is EventEnvelope<"workspace.mutation.request"> {
  return envelope.kind === "event" && envelope.event === "workspace.mutation.request";
}

describe("workspace mutation journal", () => {
  it("blocks write and edit around the original Pi tools when explicitly enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-mutation-tools-"));
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const events = new MutationEventCollector();
    const host = new SessionHost({
      agentDir: join(root, "agent"),
      emit: (event, data) => events.emit(event, data),
      projectTrustOverride: true,
    });
    host.setWorkspaceMutationJournalEnabled(true);
    await host.openCatalogContext(cwd);
    try {
      const sessionId = host.sessionId;
      assert.ok(sessionId);
      assert.equal(
        host.session.getAllTools().find((tool) => tool.name === "write")?.sourceInfo.source,
        "sdk",
      );
      const write = host.session.getToolDefinition("write") as ReturnType<
        typeof createWriteToolDefinition
      >;
      const writePath = join(cwd, "created.txt");
      let writeSettled = false;
      const writeRun = write.execute(
        "write-call",
        { content: "created", path: "created.txt" },
        undefined,
        undefined,
        undefined as never,
      ).finally(() => {
        writeSettled = true;
      });

      const writeBefore = await events.next();
      assert.deepEqual(writeBefore, {
        path: resolve(cwd, "created.txt"),
        phase: "before",
        requestId: writeBefore.requestId,
        sessionId,
        toolCallId: "write-call",
        toolName: "write",
      });
      await assert.rejects(readFile(writePath), { code: "ENOENT" });
      assert.equal(writeSettled, false);
      assert.equal(host.respondWorkspaceMutation(sessionId, writeBefore.requestId, false), true);

      const writeAfter = await events.next();
      assert.equal(await readFile(writePath, "utf8"), "created");
      assert.equal(writeAfter.phase, "after");
      assert.equal(writeAfter.succeeded, true);
      assert.equal(writeAfter.toolCallId, "write-call");
      assert.equal(writeSettled, false);
      assert.equal(host.respondWorkspaceMutation("wrong-session", writeAfter.requestId, true), false);
      assert.equal(host.respondWorkspaceMutation(sessionId, writeAfter.requestId, false), true);
      await writeRun;

      const edit = host.session.getToolDefinition("edit") as ReturnType<
        typeof createEditToolDefinition
      >;
      let editSettled = false;
      const editRun = edit.execute(
        "edit-call",
        { edits: [{ newText: "updated", oldText: "created" }], path: "created.txt" },
        undefined,
        undefined,
        undefined as never,
      ).finally(() => {
        editSettled = true;
      });

      const editBefore = await events.next();
      assert.equal(editBefore.phase, "before");
      assert.equal(editBefore.toolName, "edit");
      assert.equal(await readFile(writePath, "utf8"), "created");
      assert.equal(host.respondWorkspaceMutation(sessionId, editBefore.requestId, true), true);

      const editAfter = await events.next();
      assert.equal(await readFile(writePath, "utf8"), "updated");
      assert.equal(editAfter.phase, "after");
      assert.equal(editAfter.succeeded, true);
      assert.equal(editSettled, false);
      assert.equal(host.respondWorkspaceMutation(sessionId, editAfter.requestId, true), true);
      await editRun;

      let failedEditSettled = false;
      const failedEditRun = edit.execute(
        "failed-edit-call",
        { edits: [{ newText: "unused", oldText: "missing text" }], path: "created.txt" },
        undefined,
        undefined,
        undefined as never,
      ).finally(() => {
        failedEditSettled = true;
      });
      const failedEditBefore = await events.next();
      assert.equal(host.respondWorkspaceMutation(sessionId, failedEditBefore.requestId, true), true);
      const failedEditAfter = await events.next();
      assert.equal(failedEditAfter.phase, "after");
      assert.equal(failedEditAfter.succeeded, false);
      assert.equal(failedEditSettled, false);
      assert.equal(
        host.respondWorkspaceMutation(sessionId, failedEditAfter.requestId, true),
        true,
      );
      await assert.rejects(failedEditRun, /Could not find the exact text/);
    } finally {
      await host.dispose();
    }
  });

  it("does not override Pi's built-ins when the capability is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-mutation-disabled-"));
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const events = new MutationEventCollector();
    const host = new SessionHost({
      agentDir: join(root, "agent"),
      emit: (event, data) => events.emit(event, data),
      projectTrustOverride: true,
    });
    await host.openCatalogContext(cwd);
    try {
      assert.equal(
        host.session.getAllTools().find((tool) => tool.name === "write")?.sourceInfo.source,
        "builtin",
      );
      const write = host.session.getToolDefinition("write") as ReturnType<
        typeof createWriteToolDefinition
      >;
      await write.execute(
        "write-call",
        { content: "unblocked", path: "plain.txt" },
        undefined,
        undefined,
        undefined as never,
      );
      assert.equal(await readFile(join(cwd, "plain.txt"), "utf8"), "unblocked");
      assert.equal(events.seen.length, 0);
    } finally {
      await host.dispose();
    }
  });

  it("isolates concurrent request ids and preserves the original tool result", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-mutation-concurrent-"));
    const events = new MutationEventCollector();
    const bridge = new WorkspaceMutationJournalBridge({
      emit: (event, data) => events.emit(event, data),
      sessionId: "session-concurrent",
    });
    const write = createWorkspaceMutationJournalTools(root, bridge).find(
      (tool) => tool.name === "write",
    ) as ReturnType<typeof createWriteToolDefinition>;
    const firstRun = write.execute(
      "first-call",
      { content: "first", path: "first.txt" },
      undefined,
      undefined,
      undefined as never,
    );
    const secondRun = write.execute(
      "second-call",
      { content: "second", path: "second.txt" },
      undefined,
      undefined,
      undefined as never,
    );

    const firstBefore = await events.next();
    const secondBefore = await events.next();
    assert.notEqual(firstBefore.requestId, secondBefore.requestId);
    assert.equal(bridge.respond("session-concurrent", secondBefore.requestId, true), true);
    const secondAfter = await events.next();
    assert.equal(secondAfter.toolCallId, "second-call");
    assert.equal(await readFile(join(root, "second.txt"), "utf8"), "second");
    await assert.rejects(readFile(join(root, "first.txt")), { code: "ENOENT" });
    assert.equal(bridge.respond("session-concurrent", secondAfter.requestId, true), true);
    await secondRun;

    assert.equal(bridge.respond("session-concurrent", firstBefore.requestId, true), true);
    const firstAfter = await events.next();
    assert.equal(firstAfter.toolCallId, "first-call");
    assert.equal(bridge.respond("session-concurrent", firstAfter.requestId, true), true);
    await firstRun;
    bridge.dispose();
  });

  it("continues without journaling when event emission throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-mutation-emit-error-"));
    const bridge = new WorkspaceMutationJournalBridge({
      emit: () => {
        throw new Error("transport unavailable");
      },
      sessionId: "session-emit-error",
    });
    const write = createWorkspaceMutationJournalTools(root, bridge).find(
      (tool) => tool.name === "write",
    ) as ReturnType<typeof createWriteToolDefinition>;
    await write.execute(
      "write-call",
      { content: "written", path: "written.txt" },
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(await readFile(join(root, "written.txt"), "utf8"), "written");
    bridge.dispose();
  });

  it("releases pending waits on session replacement and disposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-mutation-dispose-"));
    const firstCwd = join(root, "first");
    const secondCwd = join(root, "second");
    await mkdir(firstCwd, { recursive: true });
    await mkdir(secondCwd, { recursive: true });
    const events = new MutationEventCollector();
    const host = new SessionHost({
      agentDir: join(root, "agent"),
      emit: (event, data) => events.emit(event, data),
      projectTrustOverride: true,
    });
    host.setWorkspaceMutationJournalEnabled(true);
    await host.openCatalogContext(firstCwd);

    const firstWrite = host.session.getToolDefinition("write") as ReturnType<
      typeof createWriteToolDefinition
    >;
    const replacementRun = firstWrite.execute(
      "replacement-call",
      { content: "replacement", path: "replacement.txt" },
      undefined,
      undefined,
      undefined as never,
    );
    await events.next();
    await Promise.all([replacementRun, host.openCatalogContext(secondCwd)]);
    assert.equal(await readFile(join(firstCwd, "replacement.txt"), "utf8"), "replacement");

    const secondWrite = host.session.getToolDefinition("write") as ReturnType<
      typeof createWriteToolDefinition
    >;
    const disposalRun = secondWrite.execute(
      "disposal-call",
      { content: "disposal", path: "disposal.txt" },
      undefined,
      undefined,
      undefined as never,
    );
    await events.next();
    await Promise.all([disposalRun, host.dispose()]);
    assert.equal(await readFile(join(secondCwd, "disposal.txt"), "utf8"), "disposal");
  });

  it("negotiates the capability and accepts worker-only responses in HostController", async () => {
    const transport = new MemoryHostTransport();
    const controller = new HostController({ transport });
    controller.start();
    try {
      transport.receive(createRequest("handshake", "host.handshake", {
        capabilities: { workspaceMutationJournal: true },
        clientName: "web-host",
        clientVersion: "0.1.0",
        mode: "web",
        protocolVersions: [PIARIUM_PROTOCOL_VERSION],
      }));
      const handshake = await transport.waitFor((envelope) => isResponse(envelope, "handshake"));
      assert.equal(handshake.kind, "response");
      assert.equal(handshake.ok, true);

      transport.receive(createRequest("respond", "workspace.mutation.respond", {
        accepted: true,
        requestId: "unknown-request",
        sessionId: "unknown-session",
      }));
      const response = await transport.waitFor((envelope) => isResponse(envelope, "respond"));
      assert.deepEqual(response, {
        id: "respond",
        kind: "response",
        ok: true,
        result: { accepted: false },
        v: PIARIUM_PROTOCOL_VERSION,
      });
      assert.equal(transport.sent.some(isMutationEvent), false);
    } finally {
      await controller.dispose();
    }
  });
});
