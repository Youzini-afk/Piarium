import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createScheduledTaskTool } from "../../src/harness/scheduled-task-tools.js";
import { selectHarnessTools } from "../../src/harness/select-tools.js";
import { DEFAULT_HARNESS_SETTINGS, type HarnessRequestData } from "@piarium/protocol";

const SESSION = "session-1";
const isError = (result: unknown) => (result as { isError?: boolean }).isError;

function scriptedBridge(handlers: Record<string, (params: never) => unknown>) {
  const requests: HarnessRequestData[] = [];
  const bridge = new HostServicesBridge({
    emit: (_event, data) => {
      const request = data as HarnessRequestData;
      requests.push(request);
      queueMicrotask(() => {
        const handler = handlers[request.method];
        if (!handler) {
          bridge.respond(SESSION, request.requestId, {
            ok: false,
            error: { code: "unavailable", message: `no handler for ${request.method}` },
          });
          return;
        }
        try {
          bridge.respond(SESSION, request.requestId, { ok: true, result: handler(request.params as never) });
        } catch (error) {
          bridge.respond(SESSION, request.requestId, {
            ok: false,
            error: { code: "failed", message: error instanceof Error ? error.message : String(error) },
          });
        }
      });
    },
    sessionId: SESSION,
    defaultTimeoutMs: 5_000,
  });
  return { bridge, requests };
}

const taskView = (over: Record<string, unknown> = {}) => ({
  id: "task-1",
  name: "Nightly digest",
  enabled: true,
  schedule: { kind: "daily", times: ["09:30"], timezone: "UTC" },
  execution: { prompt: "Summarize", providerID: "openai", modelID: "gpt-4.1" },
  state: { createdAt: 1, updatedAt: 1, lastStatus: "idle" },
  ...over,
});

const execute = (tool: ReturnType<typeof createScheduledTaskTool>, params: Record<string, unknown>) =>
  tool.execute("call-1", params as never, undefined, undefined, undefined as never);

describe("scheduled_task tool", () => {
  it("lists and creates tasks through the schedule service", async () => {
    const { bridge, requests } = scriptedBridge({
      "schedule.list": () => ({ projectId: "project-1", tasks: [taskView()] }),
      "schedule.upsert": (params: { task: { name: string } }) => ({
        created: true,
        task: taskView({ name: params.task.name }),
        tasks: [taskView()],
      }),
    });
    const tool = createScheduledTaskTool(bridge);

    const listed = await execute(tool, { action: "list" });
    assert.equal(isError(listed), undefined);
    assert.match(JSON.stringify(listed.content), /task-1/);
    assert.match(JSON.stringify(listed.content), /daily/);

    const created = await execute(tool, {
      action: "upsert",
      task: {
        name: "Morning check",
        schedule: { kind: "once", date: "2026-10-01", time: "08:00", timezone: "UTC" },
        execution: { prompt: "check", providerID: "openai", modelID: "gpt-4.1" },
      },
    });
    assert.equal(isError(created), undefined);
    assert.match(JSON.stringify(created.content), /Morning check/);
    assert.deepEqual(requests.map((request) => request.method), ["schedule.list", "schedule.upsert"]);
  });

  it("maps point actions to host methods with the task id", async () => {
    const { bridge, requests } = scriptedBridge({
      "schedule.get": () => ({ task: taskView() }),
      "schedule.remove": () => ({ tasks: [] }),
      "schedule.run": () => ({ task: taskView({ state: { createdAt: 1, updatedAt: 1, lastStatus: "success", lastSessionId: "sess-9" } }), sessionId: "sess-9" }),
      "schedule.setEnabled": (params: { enabled: boolean }) => ({ task: taskView({ enabled: params.enabled }) }),
    });
    const tool = createScheduledTaskTool(bridge);
    for (const action of ["get", "run", "set_enabled", "remove"] as const) {
      const result = await execute(tool, { action, taskId: "task-1", enabled: false });
      assert.equal(isError(result), undefined, `action ${action}`);
    }
    assert.deepEqual(
      requests.map((request) => request.method),
      ["schedule.get", "schedule.run", "schedule.setEnabled", "schedule.remove"],
    );
    const runResult = requests[1]!.params as { taskId: string };
    assert.equal(runResult.taskId, "task-1");
  });

  it("passes the loop revision through for CAS writes", async () => {
    const { bridge, requests } = scriptedBridge({
      "schedule.loop.read": () => ({
        document: { content: "---\nname: x\n---\nbody", path: "/p/.agents/loops/x.md", revision: "rev-1", scope: "project" },
      }),
      "schedule.loop.update": (params: { content: string; expectedRevision: string }) => ({
        document: { content: params.content, path: "/p/.agents/loops/x.md", revision: "rev-2", scope: "project" },
        task: taskView({ loopFile: "/p/.agents/loops/x.md" }),
      }),
      "schedule.loop.remove": (params: { expectedRevision?: string }) => {
        assert.equal(params.expectedRevision, "rev-2");
        return { tasks: [] };
      },
    });
    const tool = createScheduledTaskTool(bridge);
    const read = await execute(tool, { action: "read_loop", taskId: "task-1" });
    assert.equal(isError(read), undefined);
    assert.match(JSON.stringify(read.content), /rev-1/);
    const written = await execute(tool, {
      action: "write_loop",
      taskId: "task-1",
      content: "---\nname: x\n---\nnew body",
      expectedRevision: "rev-1",
    });
    assert.equal(isError(written), undefined);
    const updateParams = requests[1]!.params as { expectedRevision: string };
    assert.equal(updateParams.expectedRevision, "rev-1");
    const removed = await execute(tool, {
      action: "remove_loop",
      taskId: "task-1",
      expectedRevision: "rev-2",
    });
    assert.equal(isError(removed), undefined);
    assert.deepEqual(requests.map((request) => request.method), [
      "schedule.loop.read",
      "schedule.loop.update",
      "schedule.loop.remove",
    ]);
  });

  it("requires taskId and CAS revision where the action needs them", async () => {
    const { bridge, requests } = scriptedBridge({});
    const tool = createScheduledTaskTool(bridge);
    for (const action of ["get", "remove", "run", "set_enabled", "read_loop", "write_loop", "remove_loop"] as const) {
      const result = await execute(tool, {
        action,
        ...(action === "set_enabled" ? { enabled: true } : {}),
        ...(action === "write_loop" ? { content: "x", expectedRevision: "r" } : {}),
      });
      assert.equal(isError(result), true, `action ${action}`);
    }
    const noRevision = await execute(tool, { action: "write_loop", taskId: "task-1", content: "x" });
    assert.equal(isError(noRevision), true);
    assert.match(JSON.stringify(noRevision.content), /expectedRevision/);
    assert.equal(requests.length, 0);
  });

  it("surfaces host errors with their code", async () => {
    const { bridge } = scriptedBridge({});
    const tool = createScheduledTaskTool(bridge);
    const result = await execute(tool, { action: "list" });
    assert.equal(isError(result), true);
    assert.match(JSON.stringify(result.content), /unavailable/);
  });
});

describe("scheduled_task tool selection", () => {
  const deps = {
    bridge: undefined as never,
    cwd: "C:/workspace",
    isOpenAIFamily: true,
    sessionId: SESSION,
    workspaceMutationJournal: undefined,
  };

  it("is gated on the host scheduled-task capability", () => {
    const without = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, { ...deps, scheduledTasksAvailable: false });
    const withIt = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, { ...deps, scheduledTasksAvailable: true });
    assert.equal(without.some((tool) => tool.name === "scheduled_task"), false);
    assert.equal(withIt.some((tool) => tool.name === "scheduled_task"), true);
  });

  it("respects tools.scheduled_task = false", () => {
    const tools = selectHarnessTools(
      { ...DEFAULT_HARNESS_SETTINGS, tools: { scheduled_task: false } },
      { ...deps, scheduledTasksAvailable: true },
    );
    assert.equal(tools.some((tool) => tool.name === "scheduled_task"), false);
  });
});
