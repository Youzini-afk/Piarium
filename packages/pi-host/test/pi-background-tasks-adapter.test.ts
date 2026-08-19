import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  BG_REQUEST_CHANNEL,
  BG_RESPONSE_CHANNEL,
  BG_RESPONSE_SCHEMA,
  BG_TERMINAL_CHANNEL,
  BG_TERMINAL_SCHEMA,
} from "../src/fleet/background-tasks-eventbus.js";
import { PiBackgroundTasksFleetAdapter } from "../src/fleet/pi-background-tasks-adapter.js";

interface FakeBus {
  emit: (event: string, value: unknown) => void;
  on: (event: string, handler: (value: unknown) => void) => () => void;
}

const CAPABILITIES = {
  api_version: 1 as const,
  kill: true,
  logs: true,
  logs_bounded: true,
  run: true,
  run_completion_trigger: true,
  run_is_agent: true,
  status: true,
};

const privateTask = (overrides: Record<string, unknown> = {}) => ({
  bytesWritten: 4,
  command: "must-not-cross-command",
  cwd: "/secret/cwd",
  id: "task-1",
  isAgent: false,
  name: "Build",
  notified: false,
  notifyOnCompletion: true,
  outputPath: "/secret/out.log",
  pid: 99,
  startTime: 1_000,
  status: "running",
  triggerOnCompletion: true,
  ...overrides,
});

function createBus(): FakeBus {
  const eventHandlers = new Map<string, Set<(value: unknown) => void>>();
  return {
    emit: (event, value) => {
      for (const handler of [...(eventHandlers.get(event) ?? [])]) handler(value);
    },
    on: (event, handler) => {
      const handlers = eventHandlers.get(event) ?? new Set();
      handlers.add(handler);
      eventHandlers.set(event, handlers);
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) eventHandlers.delete(event);
      };
    },
  };
}

function replyOk(bus: FakeBus, request: { operation: string; request_id: string }, result: unknown): void {
  bus.emit(BG_RESPONSE_CHANNEL, {
    ok: true,
    operation: request.operation,
    request_id: request.request_id,
    result,
    schema_version: BG_RESPONSE_SCHEMA,
  });
}

function attachAdapter(bus: FakeBus): PiBackgroundTasksFleetAdapter {
  const adapter = new PiBackgroundTasksFleetAdapter({
    killDeadlineMs: 40,
    readDeadlineMs: 40,
  });
  adapter.attach(bus as unknown as ExtensionAPI["events"]);
  return adapter;
}

describe("pi-background-tasks Fleet adapter", () => {
  it("returns capabilities and mixed running/recent tasks through status", async () => {
    const bus = createBus();
    const adapter = attachAdapter(bus);
    bus.on(BG_REQUEST_CHANNEL, (value) => {
      const request = value as { operation: string; request_id: string };
      if (request.operation === "capabilities") {
        replyOk(bus, request, CAPABILITIES);
        return;
      }
      if (request.operation === "status") {
        replyOk(bus, request, {
          tasks: [
            privateTask({ id: "agent-1", isAgent: true, name: "Reviewer" }),
            privateTask({ id: "shell-1", name: "printf", status: "completed" }),
          ],
        });
      }
    });
    adapter.startSession("session-a");
    const snapshot = await adapter.status("session-a");
    assert.equal(snapshot.provider.state, "active");
    assert.equal(snapshot.provider.actions?.[0]?.action, "run");
    assert.equal(snapshot.entries.length, 2);
    assert.equal(snapshot.entries[0]?.kind, "background-agent");
    assert.equal(snapshot.entries[1]?.kind, "background-task");
    assert.equal(snapshot.totalActive, 1);
    assert.equal(JSON.stringify(snapshot).includes("/secret/"), false);
  });

  it("exposes an immediate-exit run response before its terminal update", async () => {
    const bus = createBus();
    const adapter = attachAdapter(bus);
    bus.on(BG_REQUEST_CHANNEL, (value) => {
      const request = value as { operation: string; request_id: string };
      if (request.operation === "capabilities") {
        replyOk(bus, request, CAPABILITIES);
        return;
      }
      if (request.operation === "run") {
        const running = privateTask({ id: "run-1", name: "printf" });
        replyOk(bus, request, running);
        queueMicrotask(() => {
          bus.emit(BG_TERMINAL_CHANNEL, {
            schema_version: BG_TERMINAL_SCHEMA,
            task: { ...running, endTime: 1_500, status: "completed" },
          });
        });
        return;
      }
      if (request.operation === "status") {
        replyOk(bus, request, { tasks: [privateTask({ id: "run-1", name: "printf", status: "completed" })] });
      }
    });
    adapter.startSession("session-a");
    const started = await adapter.action({
      action: "run",
      input: {
        command: "printf ok",
        isAgent: false,
        name: "printf",
        notifyOnCompletion: true,
        triggerOnCompletion: true,
      },
      sessionId: "session-a",
    });
    assert.equal(started.entry?.state, "running");
    assert.equal(started.entry?.key, "run-1");
    await Promise.resolve();
    const afterTerminal = await adapter.status("session-a");
    const entry = afterTerminal.entries.find((item) => item.key === "run-1");
    assert.equal(entry?.state, "completed");
    assert.equal(afterTerminal.entries.filter((item) => item.key === "run-1").length, 1);
  });

  it("deduplicates repeated terminal frames for one task", async () => {
    const bus = createBus();
    const adapter = attachAdapter(bus);
    bus.on(BG_REQUEST_CHANNEL, (value) => {
      const request = value as { operation: string; request_id: string };
      if (request.operation === "capabilities") replyOk(bus, request, CAPABILITIES);
      if (request.operation === "status") {
        replyOk(bus, request, { tasks: [privateTask({ id: "dup-1" })] });
      }
    });
    adapter.startSession("session-a");
    await adapter.status("session-a");
    const terminal = {
      schema_version: BG_TERMINAL_SCHEMA,
      task: privateTask({ id: "dup-1", status: "completed" }),
    };
    bus.emit(BG_TERMINAL_CHANNEL, terminal);
    bus.emit(BG_TERMINAL_CHANNEL, terminal);
    const snapshot = await adapter.status("session-a");
    assert.equal(snapshot.entries.filter((entry) => entry.key === "dup-1").length, 1);
  });

  it("rejects stale requests after session replacement and ignores a late response", async () => {
    const bus = createBus();
    const adapter = attachAdapter(bus);
    let session = "a";
    let held: { operation: string; request_id: string } | undefined;
    bus.on(BG_REQUEST_CHANNEL, (value) => {
      const request = value as { operation: string; request_id: string };
      if (request.operation === "capabilities") {
        replyOk(bus, request, CAPABILITIES);
        return;
      }
      if (request.operation !== "status") return;
      if (session === "hold") {
        held = request;
        return;
      }
      replyOk(bus, request, {
        tasks: session === "a" ? [privateTask({ id: "live-a", name: "live-a" })] : [],
      });
    });
    adapter.startSession("session-a");
    const first = await adapter.status("session-a");
    assert.equal(first.entries[0]?.key, "live-a");
    session = "hold";
    const pending = adapter.status("session-a");
    session = "b";
    adapter.startSession("session-b");
    await assert.rejects(pending, /session changed/i);
    const next = await adapter.status("session-b");
    assert.equal(next.entries.some((entry) => entry.key === "live-a"), false);
    if (held) {
      replyOk(bus, held, { tasks: [privateTask({ id: "stale-1", name: "stale" })] });
    }
    bus.emit(BG_TERMINAL_CHANNEL, {
      schema_version: BG_TERMINAL_SCHEMA,
      task: privateTask({ id: "live-a", status: "completed" }),
    });
    const afterLate = await adapter.status("session-b");
    assert.equal(afterLate.entries.some((entry) => entry.key === "stale-1" || entry.key === "live-a"), false);
  });

  it("reports unavailable when EventBus v1 is never observed", async () => {
    const bus = createBus();
    const adapter = attachAdapter(bus);
    adapter.startSession("session-a");
    const snapshot = await adapter.status("session-a");
    assert.equal(snapshot.provider.state, "unavailable");
    assert.match(snapshot.provider.issue ?? "", /EventBus v1 was not observed/);
  });

  it("reports incompatible when capabilities cannot be parsed", async () => {
    const bus = createBus();
    const adapter = attachAdapter(bus);
    bus.on(BG_REQUEST_CHANNEL, (value) => {
      const request = value as { operation: string; request_id: string };
      if (request.operation === "capabilities") {
        replyOk(bus, request, { api_version: 2 });
      }
    });
    adapter.startSession("session-a");
    const snapshot = await adapter.status("session-a");
    assert.equal(snapshot.provider.state, "incompatible");
    assert.match(snapshot.provider.issue ?? "", /api_version|unknown key|capabilities/);
  });

  it("degrades after a malformed EventBus frame", async () => {
    const bus = createBus();
    const adapter = attachAdapter(bus);
    bus.on(BG_REQUEST_CHANNEL, (value) => {
      const request = value as { operation: string; request_id: string };
      if (request.operation === "capabilities") {
        replyOk(bus, request, CAPABILITIES);
        return;
      }
      if (request.operation === "status") {
        bus.emit(BG_RESPONSE_CHANNEL, {
          extra: true,
          ok: true,
          operation: request.operation,
          request_id: request.request_id,
          result: { tasks: [] },
          schema_version: BG_RESPONSE_SCHEMA,
        });
      }
    });
    adapter.startSession("session-a");
    const degraded = await adapter.status("session-a");
    assert.equal(degraded.provider.state, "degraded");
    assert.match(degraded.provider.issue ?? "", /unknown key extra/);
  });

  it("returns Host-owned kill text and bounded logs without the output path", async () => {
    const bus = createBus();
    const adapter = attachAdapter(bus);
    bus.on(BG_REQUEST_CHANNEL, (value) => {
      const request = value as { operation: string; payload?: { taskId?: string }; request_id: string };
      if (request.operation === "capabilities") {
        replyOk(bus, request, CAPABILITIES);
        return;
      }
      if (request.operation === "status") {
        replyOk(bus, request, { tasks: [privateTask()] });
        return;
      }
      if (request.operation === "logs") {
        replyOk(bus, request, {
          bytesRead: 8,
          path: "/secret/out.log",
          tail: true,
          task: privateTask(),
          text: "bounded",
          truncated: true,
        });
        return;
      }
      if (request.operation === "kill") {
        replyOk(bus, request, {
          message: "Killed background task Build (task-1). Output: /secret/out.log",
          task: privateTask({ status: "killed" }),
        });
      }
    });
    adapter.startSession("session-a");
    await adapter.status("session-a");
    const logs = await adapter.action({
      action: "logs",
      entryKey: "task-1",
      sessionId: "session-a",
    });
    assert.equal(logs.logs?.text, "bounded");
    assert.equal(JSON.stringify(logs).includes("/secret/"), false);
    const killed = await adapter.action({
      action: "kill",
      entryKey: "task-1",
      sessionId: "session-a",
    });
    assert.equal(killed.success, true);
    assert.equal(killed.message, "Stopped Build");
    assert.equal(killed.entry?.state, "stopped");
    assert.equal(JSON.stringify(killed).includes("/secret/"), false);
  });

  it("rejects an EventBus reply whose operation does not match the pending request", async () => {
    const bus = createBus();
    const adapter = attachAdapter(bus);
    bus.on(BG_REQUEST_CHANNEL, (value) => {
      const request = value as { operation: string; request_id: string };
      if (request.operation === "capabilities") {
        replyOk(bus, request, CAPABILITIES);
        return;
      }
      if (request.operation === "status") {
        bus.emit(BG_RESPONSE_CHANNEL, {
          ok: true,
          operation: "logs",
          request_id: request.request_id,
          result: { tasks: [privateTask()] },
          schema_version: BG_RESPONSE_SCHEMA,
        });
      }
    });
    adapter.startSession("session-a");
    const snapshot = await adapter.status("session-a");
    assert.equal(snapshot.provider.state, "degraded");
    assert.equal(
      snapshot.provider.issue,
      "pi-background-tasks EventBus reply operation did not match the pending request",
    );
    assert.equal(JSON.stringify(snapshot).includes("/secret/"), false);
  });

  it("ignores a late terminal whose startedAt does not match the live task", async () => {
    const bus = createBus();
    const adapter = attachAdapter(bus);
    bus.on(BG_REQUEST_CHANNEL, (value) => {
      const request = value as { operation: string; request_id: string };
      if (request.operation === "capabilities") {
        replyOk(bus, request, CAPABILITIES);
        return;
      }
      if (request.operation === "status") {
        replyOk(bus, request, { tasks: [privateTask({ id: "task-1", startTime: 2_000 })] });
      }
    });
    adapter.startSession("session-a");
    await adapter.status("session-a");
    bus.emit(BG_TERMINAL_CHANNEL, {
      schema_version: BG_TERMINAL_SCHEMA,
      task: privateTask({ id: "task-1", endTime: 1_500, startTime: 1_000, status: "completed" }),
    });
    const snapshot = await adapter.status("session-a");
    const entry = snapshot.entries.find((item) => item.key === "task-1");
    assert.equal(entry?.startedAt, 2_000);
    assert.equal(entry?.state, "running");
  });

  it("maps logs output-file failures without leaking the output path", async () => {
    const bus = createBus();
    const adapter = attachAdapter(bus);
    bus.on(BG_REQUEST_CHANNEL, (value) => {
      const request = value as { operation: string; request_id: string };
      if (request.operation === "capabilities") {
        replyOk(bus, request, CAPABILITIES);
        return;
      }
      if (request.operation === "status") {
        replyOk(bus, request, { tasks: [privateTask()] });
        return;
      }
      if (request.operation === "logs") {
        bus.emit(BG_RESPONSE_CHANNEL, {
          error: "Output file does not exist for task-1: /secret/out.log",
          ok: false,
          operation: request.operation,
          request_id: request.request_id,
          schema_version: BG_RESPONSE_SCHEMA,
        });
      }
    });
    adapter.startSession("session-a");
    await adapter.status("session-a");
    await assert.rejects(
      adapter.action({ action: "logs", entryKey: "task-1", sessionId: "session-a" }),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        const message = error instanceof Error ? error.message : String(error);
        assert.equal(message, "Background task output is not available");
        assert.equal(message.includes("/secret/"), false);
        return true;
      },
    );
  });

  it("covers run, status, logs, terminal, and kill for one task lifetime", async () => {
    const bus = createBus();
    const adapter = attachAdapter(bus);
    const tasks = new Map<string, ReturnType<typeof privateTask>>();
    bus.on(BG_REQUEST_CHANNEL, (value) => {
      const request = value as { operation: string; payload?: { taskId?: string }; request_id: string };
      if (request.operation === "capabilities") {
        replyOk(bus, request, CAPABILITIES);
        return;
      }
      if (request.operation === "run") {
        const task = privateTask({ id: "life-1", name: "printf-ok", startTime: 1_000 });
        tasks.set(task.id, task);
        replyOk(bus, request, task);
        return;
      }
      if (request.operation === "status") {
        replyOk(bus, request, { tasks: [...tasks.values()] });
        return;
      }
      if (request.operation === "logs") {
        const task = tasks.get(request.payload?.taskId ?? "") ?? privateTask({ id: "life-1" });
        replyOk(bus, request, {
          bytesRead: 2,
          path: "/secret/out.log",
          tail: true,
          task,
          text: "ok",
          truncated: false,
        });
        return;
      }
      if (request.operation === "kill") {
        const current = tasks.get(request.payload?.taskId ?? "");
        const task = { ...(current ?? privateTask({ id: "life-1" })), status: "killed" };
        tasks.set(task.id, task);
        replyOk(bus, request, {
          message: "Killed background task printf-ok (life-1). Output: /secret/out.log",
          task,
        });
      }
    });
    adapter.startSession("session-a");
    const started = await adapter.action({
      action: "run",
      input: {
        command: "printf ok",
        isAgent: false,
        name: "printf-ok",
        notifyOnCompletion: true,
        triggerOnCompletion: true,
      },
      sessionId: "session-a",
    });
    assert.equal(started.entry?.key, "life-1");
    assert.equal(started.entry?.state, "running");
    const listed = await adapter.status("session-a");
    assert.equal(listed.entries[0]?.key, "life-1");
    const logs = await adapter.action({
      action: "logs",
      entryKey: "life-1",
      sessionId: "session-a",
    });
    assert.equal(logs.logs?.text, "ok");
    assert.equal(JSON.stringify(logs).includes("/secret/"), false);
    const killed = await adapter.action({
      action: "kill",
      entryKey: "life-1",
      sessionId: "session-a",
    });
    assert.equal(killed.success, true);
    assert.equal(killed.message, "Stopped printf-ok");
    assert.equal(killed.entry?.state, "stopped");
    bus.emit(BG_TERMINAL_CHANNEL, {
      schema_version: BG_TERMINAL_SCHEMA,
      task: privateTask({
        id: "life-1",
        endTime: 1_500,
        name: "printf-ok",
        startTime: 1_000,
        status: "killed",
      }),
    });
    const afterTerminal = await adapter.status("session-a");
    assert.equal(afterTerminal.entries[0]?.state, "stopped");
    assert.equal(JSON.stringify(killed).includes("/secret/"), false);
    assert.equal(JSON.stringify(afterTerminal).includes("/secret/"), false);
  });
});
