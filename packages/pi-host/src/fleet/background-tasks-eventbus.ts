import type {
  PiFleetActionDescriptor,
  PiFleetEntry,
  PiFleetLogsData,
} from "@piarium/protocol";
import {
  assertClosed,
  isRecord,
  requireBoolean,
  requireNonEmptyString,
  requireNonNegativeInteger,
} from "./json.js";

export const BG_REQUEST_CHANNEL = "pi-background-tasks:request:v1";
export const BG_RESPONSE_CHANNEL = "pi-background-tasks:response:v1";
export const BG_TERMINAL_CHANNEL = "pi-background-tasks:terminal:v1";
const BG_REQUEST_SCHEMA = "pi-background-tasks.extension-request.v1";
export const BG_RESPONSE_SCHEMA = "pi-background-tasks.extension-response.v1";
export const BG_TERMINAL_SCHEMA = "pi-background-tasks.extension-terminal.v1";
export const BG_PROVIDER_ID = "pi-background-tasks";
export const BG_PROVIDER_LABEL = "pi-background-tasks";
export const BG_PROVIDER_SOURCE = "npm:pi-background-tasks";

export const BG_READ_DEADLINE_MS = 5_000;
export const BG_KILL_DEADLINE_MS = 10_000;

const TASK_STATUSES = new Set(["running", "completed", "failed", "killed"]);
const MAX_REQUEST_ID_CHARS = 200;

export type BackgroundTaskOperation = "capabilities" | "kill" | "logs" | "run" | "status";

export interface BackgroundTaskCapabilities {
  api_version: 1;
  kill: boolean;
  logs: boolean;
  logs_bounded: boolean;
  run: boolean;
  run_completion_trigger: boolean;
  run_is_agent: boolean;
  status: boolean;
}

export interface BackgroundTaskRunPayload {
  command: string;
  isAgent: boolean;
  name: string;
  notifyOnCompletion: boolean;
  timeoutSeconds?: number;
  triggerOnCompletion: boolean;
}

interface ProjectedTask {
  bytesWritten?: number;
  description?: string;
  endTime?: number;
  error?: string;
  id: string;
  isAgent: boolean;
  model?: string;
  name?: string;
  startTime: number;
  status: "completed" | "failed" | "killed" | "running";
  tokens?: { input: number; output: number; total: number };
}

type BackgroundTaskParsedResponse =
  | { ok: true; operation: string; requestId: string; result: unknown }
  | { error: string; ok: false; operation: string; requestId: string };

const CAPABILITY_KEYS = [
  "api_version",
  "kill",
  "logs",
  "logs_bounded",
  "run",
  "run_completion_trigger",
  "run_is_agent",
  "status",
] as const;

export const createBackgroundTaskRequest = (
  requestId: string,
  operation: BackgroundTaskOperation,
  payload: Record<string, unknown>,
): Record<string, unknown> => {
  if (requestId.length === 0 || requestId.length > MAX_REQUEST_ID_CHARS) {
    throw new Error("request.request_id must be 1 to 200 characters");
  }
  return {
    operation,
    payload,
    request_id: requestId,
    schema_version: BG_REQUEST_SCHEMA,
  };
};

export const parseBackgroundTaskResponse = (value: unknown): BackgroundTaskParsedResponse => {
  if (!isRecord(value)) throw new Error("response frame must be an object");
  const requestId = typeof value.request_id === "string" && value.request_id.length > 0
    ? value.request_id
    : "malformed";
  const operation = typeof value.operation === "string" && value.operation.length > 0
    ? value.operation
    : "malformed";
  if (value.schema_version !== BG_RESPONSE_SCHEMA) {
    throw new Error("response schema_version mismatch");
  }
  if (value.ok === true) {
    assertClosed(value, ["ok", "operation", "request_id", "result", "schema_version"], "response");
    return { ok: true, operation, requestId, result: value.result };
  }
  if (value.ok === false) {
    assertClosed(value, ["error", "ok", "operation", "request_id", "schema_version"], "response");
    return {
      error: requireNonEmptyString(value.error, "response.error"),
      ok: false,
      operation,
      requestId,
    };
  }
  throw new Error("response.ok must be boolean");
};

export const parseBackgroundTaskCapabilities = (value: unknown): BackgroundTaskCapabilities => {
  if (!isRecord(value)) throw new Error("capabilities result must be an object");
  assertClosed(value, CAPABILITY_KEYS, "capabilities");
  if (value.api_version !== 1) throw new Error("capabilities.api_version must be 1");
  return {
    api_version: 1,
    kill: requireBoolean(value.kill, "capabilities.kill"),
    logs: requireBoolean(value.logs, "capabilities.logs"),
    logs_bounded: requireBoolean(value.logs_bounded, "capabilities.logs_bounded"),
    run: requireBoolean(value.run, "capabilities.run"),
    run_completion_trigger: requireBoolean(
      value.run_completion_trigger,
      "capabilities.run_completion_trigger",
    ),
    run_is_agent: requireBoolean(value.run_is_agent, "capabilities.run_is_agent"),
    status: requireBoolean(value.status, "capabilities.status"),
  };
};

export const parseBackgroundTaskStatusResult = (value: unknown): ProjectedTask[] => {
  if (!isRecord(value)) throw new Error("status result must be an object");
  assertClosed(value, ["tasks"], "status.result");
  if (!Array.isArray(value.tasks)) throw new Error("status.result.tasks must be an array");
  return value.tasks.map((task, index) => parseProjectedTask(task, `status.result.tasks[${index}]`));
};

export const parseBackgroundTaskRunResult = (value: unknown): ProjectedTask => (
  parseProjectedTask(value, "run.result")
);

export const parseBackgroundTaskKillResult = (value: unknown): { task: ProjectedTask } => {
  if (!isRecord(value)) throw new Error("kill result must be an object");
  assertClosed(value, ["message", "task"], "kill.result");
  return { task: parseProjectedTask(value.task, "kill.result.task") };
};

export const parseBackgroundTaskLogsResult = (
  value: unknown,
): { entry: PiFleetEntry; logs: PiFleetLogsData } => {
  if (!isRecord(value)) throw new Error("logs result must be an object");
  assertClosed(value, ["bytesRead", "path", "tail", "task", "text", "truncated"], "logs.result");
  if (typeof value.text !== "string") throw new Error("logs.result.text must be a string");
  return {
    entry: projectBackgroundTaskEntry(parseProjectedTask(value.task, "logs.result.task")),
    logs: {
      bytesRead: requireNonNegativeInteger(value.bytesRead, "logs.result.bytesRead"),
      tail: requireBoolean(value.tail, "logs.result.tail"),
      text: value.text,
      truncated: requireBoolean(value.truncated, "logs.result.truncated"),
    },
  };
};

export const parseBackgroundTaskTerminal = (value: unknown): ProjectedTask => {
  if (!isRecord(value)) throw new Error("terminal frame must be an object");
  assertClosed(value, ["schema_version", "task"], "terminal");
  if (value.schema_version !== BG_TERMINAL_SCHEMA) {
    throw new Error("terminal schema_version mismatch");
  }
  return parseProjectedTask(value.task, "terminal.task");
};

const parseProjectedTask = (value: unknown, label: string): ProjectedTask => {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const status = value.status;
  if (typeof status !== "string" || !TASK_STATUSES.has(status)) {
    throw new Error(`${label}.status must be running, completed, failed, or killed`);
  }
  const description = optionalString(value.description, `${label}.description`);
  const error = optionalString(value.error, `${label}.error`);
  const model = optionalString(value.model, `${label}.model`);
  const name = optionalString(value.name, `${label}.name`);
  const bytesWritten = optionalNonNegativeInteger(value.bytesWritten, `${label}.bytesWritten`);
  const endTime = optionalNonNegativeInteger(value.endTime, `${label}.endTime`);
  return {
    ...(bytesWritten === undefined ? {} : { bytesWritten }),
    ...(description === undefined ? {} : { description }),
    ...(endTime === undefined ? {} : { endTime }),
    ...(error === undefined ? {} : { error }),
    id: requireNonEmptyString(value.id, `${label}.id`),
    isAgent: requireBoolean(value.isAgent, `${label}.isAgent`),
    ...(model === undefined ? {} : { model }),
    ...(name === undefined ? {} : { name }),
    startTime: requireNonNegativeInteger(value.startTime, `${label}.startTime`),
    status: status as ProjectedTask["status"],
    ...(parseTokens(value.tokenUsage, `${label}.tokenUsage`)),
  };
};

const optionalString = (value: unknown, label: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  return requireNonEmptyString(value, label);
};

const optionalNonNegativeInteger = (value: unknown, label: string): number | undefined => {
  if (value === undefined || value === null) return undefined;
  return requireNonNegativeInteger(value, label);
};

const parseTokens = (
  value: unknown,
  label: string,
): { tokens: { input: number; output: number; total: number } } | Record<string, never> => {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const input = optionalNonNegativeInteger(value.input, `${label}.input`);
  const output = optionalNonNegativeInteger(value.output, `${label}.output`);
  const total = optionalNonNegativeInteger(value.totalTokens, `${label}.totalTokens`);
  if (input === undefined || output === undefined || total === undefined) return {};
  return { tokens: { input, output, total } };
};

export const mapBackgroundTaskPublicError = (error: string): string => {
  if (error.startsWith("Output file does not exist for ") || error.startsWith("Output file not found:")) {
    return "Background task output is not available";
  }
  if (error.startsWith("Output file write failed:")) {
    return "Background task output could not be written";
  }
  return error;
};

export const projectBackgroundTaskEntry = (task: ProjectedTask): PiFleetEntry => {
  const state = task.status === "killed" ? "stopped" : task.status;
  const actions: PiFleetActionDescriptor[] = [{ action: "logs", scope: "entry" }];
  if (state === "running") actions.push({ action: "kill", destructive: true, scope: "entry" });
  return {
    actions,
    ...(task.bytesWritten === undefined ? {} : { bytesWritten: task.bytesWritten }),
    ...(task.description === undefined ? {} : { description: task.description }),
    ...(task.endTime === undefined ? {} : { endedAt: task.endTime }),
    ...(task.error === undefined ? {} : { error: mapBackgroundTaskPublicError(task.error) }),
    key: task.id,
    kind: task.isAgent ? "background-agent" : "background-task",
    ...(task.model === undefined ? {} : { model: task.model }),
    name: task.name && task.name.trim().length > 0 ? task.name : task.id,
    providerId: BG_PROVIDER_ID,
    startedAt: task.startTime,
    state,
    ...(task.tokens === undefined ? {} : { tokens: task.tokens }),
  };
};
