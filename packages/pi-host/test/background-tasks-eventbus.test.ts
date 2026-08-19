import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BG_RESPONSE_SCHEMA,
  BG_TERMINAL_SCHEMA,
  createBackgroundTaskRequest,
  parseBackgroundTaskCapabilities,
  parseBackgroundTaskKillResult,
  parseBackgroundTaskLogsResult,
  parseBackgroundTaskResponse,
  parseBackgroundTaskRunResult,
  parseBackgroundTaskStatusResult,
  parseBackgroundTaskTerminal,
  projectBackgroundTaskEntry,
} from "../src/fleet/background-tasks-eventbus.js";

const privateTask = (overrides: Record<string, unknown> = {}) => ({
  bytesWritten: 12,
  command: "must-not-cross-command",
  cwd: "/secret/cwd",
  id: "task-1",
  isAgent: false,
  name: "Build",
  notified: false,
  notifyOnCompletion: true,
  outputPath: "/secret/out.log",
  pid: 4321,
  startTime: 1_700_000_000_000,
  status: "running",
  triggerOnCompletion: true,
  ...overrides,
});

describe("pi-background-tasks EventBus parser", () => {
  it("projects public Fleet fields and drops private snapshot paths", () => {
    const entry = projectBackgroundTaskEntry(parseBackgroundTaskRunResult(privateTask({
      description: "Compile the package",
      isAgent: true,
      status: "killed",
      tokenUsage: { cacheRead: 1, cacheWrite: 2, input: 10, output: 4, totalTokens: 14 },
    })));
    assert.deepEqual(entry, {
      actions: [{ action: "logs", scope: "entry" }],
      bytesWritten: 12,
      description: "Compile the package",
      key: "task-1",
      kind: "background-agent",
      name: "Build",
      providerId: "pi-background-tasks",
      startedAt: 1_700_000_000_000,
      state: "stopped",
      tokens: { input: 10, output: 4, total: 14 },
    });
    const serialized = JSON.stringify(entry);
    assert.equal(serialized.includes("must-not-cross-command"), false);
    assert.equal(serialized.includes("/secret/"), false);
    assert.equal(serialized.includes("4321"), false);
  });

  it("accepts mixed status tasks without inventing missing telemetry", () => {
    const tasks = parseBackgroundTaskStatusResult({
      tasks: [
        privateTask({ id: "agent-1", isAgent: true, name: "Reviewer" }),
        privateTask({
          bytesWritten: 0,
          endTime: 1_700_000_000_500,
          id: "shell-1",
          name: "printf",
          status: "completed",
        }),
      ],
    });
    assert.equal(tasks[0]?.isAgent, true);
    assert.equal(projectBackgroundTaskEntry(tasks[1]!).kind, "background-task");
    assert.equal(projectBackgroundTaskEntry(tasks[1]!).bytesWritten, 0);
    assert.equal(projectBackgroundTaskEntry(tasks[0]!).tokens, undefined);
  });

  it("rejects unknown keys on EventBus frames but not on inner task snapshots", () => {
    assert.throws(
      () => parseBackgroundTaskResponse({
        extra: true,
        ok: true,
        operation: "status",
        request_id: "r1",
        result: { tasks: [] },
        schema_version: BG_RESPONSE_SCHEMA,
      }),
      /unknown key extra/,
    );
    assert.doesNotThrow(() => parseBackgroundTaskRunResult(privateTask({
      attestationPath: "/secret/attest.json",
      delegate: { artifactDir: "/secret/delegate" },
    })));
    assert.throws(
      () => parseBackgroundTaskCapabilities({
        api_version: 1,
        extra: true,
        kill: true,
        logs: true,
        logs_bounded: true,
        run: true,
        run_completion_trigger: true,
        run_is_agent: true,
        status: true,
      }),
      /unknown key extra/,
    );
  });

  it("omits private log paths while preserving bounded text metadata", () => {
    const parsed = parseBackgroundTaskLogsResult({
      bytesRead: 24,
      path: "/secret/out.log",
      tail: true,
      task: privateTask({ status: "completed" }),
      text: "hello from logs",
      truncated: true,
    });
    assert.deepEqual(parsed.logs, {
      bytesRead: 24,
      tail: true,
      text: "hello from logs",
      truncated: true,
    });
    assert.equal(JSON.stringify(parsed).includes("/secret/"), false);
    assert.equal(parsed.entry.state, "completed");
  });

  it("parses kill and terminal frames without forwarding the plugin kill message", () => {
    const killed = parseBackgroundTaskKillResult({
      message: "Killed background task Build (task-1). Output: /secret/out.log",
      task: privateTask({ status: "killed" }),
    });
    assert.equal(killed.task.status, "killed");
    const terminal = parseBackgroundTaskTerminal({
      schema_version: BG_TERMINAL_SCHEMA,
      task: privateTask({ status: "failed", error: "exit 1" }),
    });
    assert.equal(projectBackgroundTaskEntry(terminal).error, "exit 1");
    assert.equal(createBackgroundTaskRequest("id-1", "logs", { taskId: "task-1" }).operation, "logs");
  });
});
