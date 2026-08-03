import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { HostEvent, HostEventData } from "@piarium/protocol";
import { SessionHost } from "../src/session-host.js";

const createHost = (agentDir: string): SessionHost => new SessionHost({
  agentDir,
  emit: <E extends HostEvent>(_event: E, _data: HostEventData<E>) => undefined,
  projectTrustOverride: true,
});

describe("SessionHost Fleet", () => {
  it("reads pi-subagents public fleetStatus v1 through the in-process RPC", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-fleet-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "pi-subagents-rpc-test.ts"),
      `export default function (pi: any) {
  pi.events.on("subagents:rpc:v1:request", (request: any) => {
    if (request?.version !== 1 || request?.method !== "status") return;
    pi.events.emit("subagents:rpc:v1:reply:" + request.requestId, {
      version: 1,
      requestId: request.requestId,
      success: true,
      data: {
        text: "private status text",
        details: { runId: "private-run-id" },
        fleet: {
          version: 1,
          entries: [{
            key: "fleet-1",
            agent: "worker",
            model: "test/model",
            effort: "high",
            goal: "Implement the current slice",
            startedAt: 1700000000000,
            tokens: { input: 10, output: 20, total: 30 }
          }],
          totalActive: 1,
          omitted: 0
        }
      }
    });
  });
  pi.on("session_start", (_event: any, context: any) => {
    pi.events.emit("subagents:rpc:v1:ready", {
      version: 1,
      methods: ["ping", "status"],
      capabilities: { fleetStatus: { version: 1 } },
      session: { sessionId: context.sessionManager.getSessionId() }
    });
  });
}
`,
      "utf8",
    );

    const host = createHost(agentDir);
    try {
      const session = await host.openCatalogContext(cwd);
      const fleet = await host.fleetStatus(session.sessionId);
      assert.deepEqual(fleet, {
        entries: [{
          agent: "worker",
          effort: "high",
          goal: "Implement the current slice",
          key: "fleet-1",
          model: "test/model",
          providerId: "pi-subagents",
          startedAt: 1_700_000_000_000,
          tokens: { input: 10, output: 20, total: 30 },
        }],
        omitted: 0,
        providers: [{
          bridgeVersion: 1,
          id: "pi-subagents",
          label: "pi-subagents",
          source: "npm:pi-subagents",
          state: "active",
        }],
        totalActive: 1,
      });
    } finally {
      await host.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a loaded older pi-subagents surface as incompatible instead of inactive", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-fleet-incompatible-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "pi-subagents-without-rpc.ts"),
      `import { Type } from "@earendil-works/pi-ai";
export default function (pi: any) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Legacy-compatible test tool without public Fleet RPC",
    parameters: Type.Object({}, { additionalProperties: true }),
    async execute() { return { content: [{ type: "text", text: "ok" }] }; }
  });
}
`,
      "utf8",
    );

    const host = createHost(agentDir);
    try {
      const session = await host.openCatalogContext(cwd);
      const fleet = await host.fleetStatus(session.sessionId);
      assert.equal(fleet.providers[0]?.state, "incompatible");
      assert.match(fleet.providers[0]?.issue ?? "", /fleetStatus v1/);
    } finally {
      await host.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
