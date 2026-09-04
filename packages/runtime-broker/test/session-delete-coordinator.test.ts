import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { PiRuntimeBroker } from "../src/runtime-broker.js";

const HOST_ENTRY = resolve(import.meta.dirname, "../../pi-host/src/main.ts");

describe("session ownership coordination", () => {
  it("waits for the application-owned cleanup before removing the Pi session file", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-delete-coordinate-"));
    const workspace = join(root, "workspace");
    const agentDir = join(root, "agent");
    await Promise.all([mkdir(workspace), mkdir(agentDir)]);
    const broker = new PiRuntimeBroker({
      agentDir,
      client: { clientName: "delete-test", clientVersion: "0.0.0", mode: "test" },
      execArgv: ["--import", import.meta.resolve("tsx")],
      hostEntry: HOST_ENTRY,
      projectTrustOverride: true,
    });
    try {
      const created = await broker.createSession(
        workspace,
        "Parent with children",
        undefined,
        { kind: "workspace", id: "workspace-1" },
      );
      assert.ok(created.sessionFile);
      await mkdir(dirname(created.sessionFile), { recursive: true });
      await writeFile(created.sessionFile, "deletion-order-sentinel\n", "utf8");
      await access(created.sessionFile);
      let coordinated = false;
      broker.setSessionDeleteCoordinator(async ({ sessionId, summary }) => {
        assert.equal(sessionId, created.sessionId);
        assert.equal(summary.workspace?.kind, "workspace");
        await access(created.sessionFile!);
        coordinated = true;
      });

      await broker.deleteSession(created.sessionId);
      assert.equal(coordinated, true);
      await assert.rejects(access(created.sessionFile));
    } finally {
      await broker.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("attaches the broker-pinned child workspace scope to Host events", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-session-scope-"));
    const workspace = join(root, "workspace");
    const agentDir = join(root, "agent");
    await Promise.all([mkdir(workspace), mkdir(agentDir)]);
    const events: Array<Parameters<Parameters<PiRuntimeBroker["subscribe"]>[0]>[0]> = [];
    const broker = new PiRuntimeBroker({
      agentDir,
      client: { clientName: "scope-test", clientVersion: "0.0.0", mode: "test" },
      execArgv: ["--import", import.meta.resolve("tsx")],
      hostEntry: HOST_ENTRY,
      projectTrustOverride: true,
    });
    broker.subscribe((event) => events.push(event));
    try {
      const created = await broker.createSession(
        workspace,
        "Scoped child",
        undefined,
        { kind: "workspace", id: "runtime-workspace-1" },
        { scope: ["packages/web"], tools: ["read"] },
      );
      const snapshot = events.find((event) => (
        event.kind === "host"
        && event.sessionId === created.sessionId
        && event.envelope.event === "session.snapshot"
      ));
      assert.deepEqual(snapshot && "actor" in snapshot ? snapshot.actor?.workspaceScope : undefined, ["packages/web"]);
    } finally {
      await broker.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });
});
