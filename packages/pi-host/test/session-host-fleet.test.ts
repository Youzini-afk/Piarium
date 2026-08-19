import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SessionHost } from "../src/session-host.js";

const createHost = (agentDir: string): SessionHost => new SessionHost({
  agentDir,
  emit: () => undefined,
  projectTrustOverride: true,
});

const EVENTBUS_EMPTY = `export default function (pi: any) {
  const capabilities = {
    api_version: 1,
    kill: true,
    logs: true,
    logs_bounded: true,
    run: true,
    run_completion_trigger: true,
    run_is_agent: true,
    status: true
  };
  pi.events.on("pi-background-tasks:request:v1", (request: any) => {
    pi.events.emit("pi-background-tasks:response:v1", {
      ok: true,
      operation: request.operation,
      request_id: request.request_id,
      result: request.operation === "capabilities" ? capabilities : { tasks: [] },
      schema_version: "pi-background-tasks.extension-response.v1"
    });
  });
}
`;

const EVENTBUS_MIXED = `export default function (pi: any) {
  const capabilities = {
    api_version: 1,
    kill: true,
    logs: true,
    logs_bounded: true,
    run: true,
    run_completion_trigger: true,
    run_is_agent: true,
    status: true
  };
  const snapshot = (overrides = {}) => ({
    bytesWritten: 4,
    command: "must-not-cross-command",
    cwd: "/secret/cwd",
    id: "bg-1",
    isAgent: true,
    name: "Reviewer",
    notified: false,
    notifyOnCompletion: true,
    outputPath: "/secret/out.log",
    pid: 99,
    startTime: 1700000000000,
    status: "running",
    triggerOnCompletion: true,
    ...overrides
  });
  const tasks = [
    snapshot(),
    snapshot({ id: "bg-2", isAgent: false, name: "printf", status: "completed" })
  ];
  pi.events.on("pi-background-tasks:request:v1", (request: any) => {
    const respond = (result: unknown) => pi.events.emit("pi-background-tasks:response:v1", {
      ok: true,
      operation: request.operation,
      request_id: request.request_id,
      result,
      schema_version: "pi-background-tasks.extension-response.v1"
    });
    if (request.operation === "capabilities") return respond(capabilities);
    if (request.operation === "status") return respond({ tasks });
    if (request.operation === "run") {
      const task = snapshot({
        id: "bg-run",
        isAgent: request.payload.isAgent,
        name: request.payload.name,
        status: "running"
      });
      tasks.push(task);
      respond(task);
      queueMicrotask(() => pi.events.emit("pi-background-tasks:terminal:v1", {
        schema_version: "pi-background-tasks.extension-terminal.v1",
        task: { ...task, endTime: 1700000000500, status: "completed" }
      }));
      return;
    }
    if (request.operation === "logs") {
      const task = tasks.find((entry: any) => entry.id === request.payload.taskId) ?? snapshot({ id: request.payload.taskId });
      return respond({
        bytesRead: 7,
        path: "/secret/out.log",
        tail: true,
        task,
        text: "bounded",
        truncated: true
      });
    }
    if (request.operation === "kill") {
      const current = tasks.find((entry: any) => entry.id === request.payload.taskId);
      const task = { ...(current ?? snapshot()), status: "killed" };
      return respond({
        message: "Killed background task Reviewer (" + task.id + "). Output: /secret/out.log",
        task
      });
    }
  });
}
`;

const EVENTBUS_MALFORMED_STATUS = `export default function (pi: any) {
  const capabilities = {
    api_version: 1,
    kill: true,
    logs: true,
    logs_bounded: true,
    run: true,
    run_completion_trigger: true,
    run_is_agent: true,
    status: true
  };
  pi.events.on("pi-background-tasks:request:v1", (request: any) => {
    if (request.operation === "capabilities") {
      pi.events.emit("pi-background-tasks:response:v1", {
        ok: true,
        operation: request.operation,
        request_id: request.request_id,
        result: capabilities,
        schema_version: "pi-background-tasks.extension-response.v1"
      });
      return;
    }
    pi.events.emit("pi-background-tasks:response:v1", {
      extra: true,
      ok: true,
      operation: request.operation,
      request_id: request.request_id,
      result: { tasks: [] },
      schema_version: "pi-background-tasks.extension-response.v1"
    });
  });
}
`;

const SUBAGENTS_RPC = `export default function (pi: any) {
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
`;

const SUBAGENTS_LEGACY = `import { Type } from "@earendil-works/pi-ai";
export default function (pi: any) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Legacy-compatible test tool without public Fleet RPC",
    parameters: Type.Object({}, { additionalProperties: true }),
    async execute() { return { content: [{ type: "text", text: "ok" }] }; }
  });
}
`;

async function withHost(
  prefix: string,
  files: Record<string, string>,
  run: (host: SessionHost, sessionId: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    await writeFile(join(agentDir, "extensions", name), source, "utf8");
  }
  const host = createHost(agentDir);
  try {
    const session = await host.openCatalogContext(cwd);
    await run(host, session.sessionId);
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

describe("SessionHost Fleet", () => {
  it("reads pi-subagents public fleetStatus v1 through the in-process RPC", async () => {
    await withHost("piarium-fleet-", {
      "pi-subagents-rpc-test.ts": SUBAGENTS_RPC,
      "pi-background-tasks-empty.ts": EVENTBUS_EMPTY,
    }, async (host, sessionId) => {
      const fleet = await host.fleetStatus(sessionId);
      const subagents = fleet.providers.find((provider) => provider.id === "pi-subagents");
      const background = fleet.providers.find((provider) => provider.id === "pi-background-tasks");
      assert.equal(subagents?.state, "active");
      assert.equal(background?.state, "active");
      assert.deepEqual(fleet.entries.find((entry) => entry.providerId === "pi-subagents"), {
        actions: [],
        agent: "worker",
        description: "Implement the current slice",
        effort: "high",
        key: "fleet-1",
        kind: "delegated-agent",
        model: "test/model",
        name: "worker",
        providerId: "pi-subagents",
        startedAt: 1_700_000_000_000,
        state: "running",
        tokens: { input: 10, output: 20, total: 30 },
      });
      assert.equal(fleet.totalActive, 1);
    });
  });

  it("reports a loaded older pi-subagents surface as incompatible while background tasks stay healthy", async () => {
    await withHost("piarium-fleet-incompatible-", {
      "pi-subagents-without-rpc.ts": SUBAGENTS_LEGACY,
      "pi-background-tasks-mixed.ts": EVENTBUS_MIXED,
    }, async (host, sessionId) => {
      const fleet = await host.fleetStatus(sessionId);
      const subagents = fleet.providers.find((provider) => provider.id === "pi-subagents");
      const background = fleet.providers.find((provider) => provider.id === "pi-background-tasks");
      assert.equal(subagents?.state, "incompatible");
      assert.match(subagents?.issue ?? "", /fleetStatus v1/);
      assert.equal(background?.state, "active");
      assert.equal(fleet.entries.some((entry) => entry.kind === "background-agent"), true);
      assert.equal(JSON.stringify(fleet).includes("/secret/"), false);
    });
  });

  it("runs, logs, and stops background tasks through EventBus v1", async () => {
    await withHost("piarium-fleet-eventbus-", {
      "pi-background-tasks-mixed.ts": EVENTBUS_MIXED,
    }, async (host, sessionId) => {
      const started = await host.fleetAction(sessionId, "pi-background-tasks", "run", undefined, {
        command: "printf ok",
        isAgent: false,
        name: "printf-ok",
        notifyOnCompletion: true,
        triggerOnCompletion: true,
      });
      assert.equal(started.success, true);
      assert.equal(started.entry?.state, "running");
      assert.equal(started.entry?.name, "printf-ok");
      await Promise.resolve();
      const logs = await host.fleetAction(sessionId, "pi-background-tasks", "logs", "bg-1", undefined);
      assert.equal(logs.logs?.text, "bounded");
      assert.equal(logs.logs?.truncated, true);
      assert.equal(JSON.stringify(logs).includes("/secret/"), false);
      const killed = await host.fleetAction(sessionId, "pi-background-tasks", "kill", "bg-1", undefined);
      assert.equal(killed.message, "Stopped Reviewer");
      assert.equal(killed.entry?.state, "stopped");
      assert.equal(JSON.stringify(killed).includes("/secret/"), false);
    });
  });

  it("degrades only pi-background-tasks when EventBus frames contain unknown keys", async () => {
    await withHost("piarium-fleet-malformed-", {
      "pi-subagents-rpc-test.ts": SUBAGENTS_RPC,
      "pi-background-tasks-malformed.ts": EVENTBUS_MALFORMED_STATUS,
    }, async (host, sessionId) => {
      const fleet = await host.fleetStatus(sessionId);
      const subagents = fleet.providers.find((provider) => provider.id === "pi-subagents");
      const background = fleet.providers.find((provider) => provider.id === "pi-background-tasks");
      assert.equal(subagents?.state, "active");
      assert.equal(background?.state, "degraded");
      assert.match(background?.issue ?? "", /unknown key extra/);
      assert.equal(fleet.entries.some((entry) => entry.providerId === "pi-subagents"), true);
      assert.equal(fleet.entries.some((entry) => entry.providerId === "pi-background-tasks"), false);
    });
  });
});
