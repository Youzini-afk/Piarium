import type { JsonValue, PiFleetActionDescriptor } from "@piarium/protocol";
import { HostError } from "../errors.js";
import {
  BG_KILL_DEADLINE_MS,
  BG_PROVIDER_ID,
  BG_PROVIDER_LABEL,
  BG_PROVIDER_SOURCE,
  BG_READ_DEADLINE_MS,
  BG_REQUEST_CHANNEL,
  BG_RESPONSE_CHANNEL,
  BG_TERMINAL_CHANNEL,
  createBackgroundTaskRequest,
  parseBackgroundTaskCapabilities,
  parseBackgroundTaskKillResult,
  parseBackgroundTaskLogsResult,
  parseBackgroundTaskResponse,
  parseBackgroundTaskRunResult,
  parseBackgroundTaskStatusResult,
  parseBackgroundTaskTerminal,
  projectBackgroundTaskEntry,
  type BackgroundTaskCapabilities,
  type BackgroundTaskOperation,
  type BackgroundTaskRunPayload,
} from "./background-tasks-eventbus.js";
import { assertClosed, isRecord, requireBoolean, requireNonEmptyString, requirePositiveInteger } from "./json.js";
import type {
  ExtensionEventBus,
  FleetProviderAdapter,
  PiFleetProviderActionRequest,
  PiFleetProviderActionResult,
  PiFleetProviderResult,
} from "./types.js";

interface PendingRequest {
  operation: BackgroundTaskOperation;
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const providerSnapshot = (
  state: PiFleetProviderResult["provider"]["state"],
  options: {
    actions?: PiFleetProviderResult["provider"]["actions"];
    bridgeVersion?: number;
    issue?: string;
  } = {},
): PiFleetProviderResult["provider"] => ({
  ...(options.actions === undefined || options.actions.length === 0 ? {} : { actions: options.actions }),
  ...(options.bridgeVersion === undefined ? {} : { bridgeVersion: options.bridgeVersion }),
  id: BG_PROVIDER_ID,
  ...(options.issue === undefined ? {} : { issue: options.issue }),
  label: BG_PROVIDER_LABEL,
  source: BG_PROVIDER_SOURCE,
  state,
});

const emptyResult = (
  state: PiFleetProviderResult["provider"]["state"],
  options?: Parameters<typeof providerSnapshot>[1],
): PiFleetProviderResult => ({
  entries: [],
  omitted: 0,
  provider: providerSnapshot(state, options),
  totalActive: 0,
});

const parseRunPayload = (value: JsonValue | undefined): BackgroundTaskRunPayload => {
  if (!isRecord(value)) throw new HostError("invalid_params", "run.payload must be an object");
  try {
    assertClosed(
      value,
      ["command", "isAgent", "name", "notifyOnCompletion", "timeoutSeconds", "triggerOnCompletion"],
      "run.payload",
    );
    const payload: BackgroundTaskRunPayload = {
      command: requireNonEmptyString(value.command, "run.payload.command"),
      isAgent: requireBoolean(value.isAgent, "run.payload.isAgent"),
      name: requireNonEmptyString(value.name, "run.payload.name"),
      notifyOnCompletion: requireBoolean(value.notifyOnCompletion, "run.payload.notifyOnCompletion"),
      triggerOnCompletion: requireBoolean(value.triggerOnCompletion, "run.payload.triggerOnCompletion"),
    };
    if (Object.prototype.hasOwnProperty.call(value, "timeoutSeconds")) {
      payload.timeoutSeconds = requirePositiveInteger(value.timeoutSeconds, "run.payload.timeoutSeconds");
    }
    return payload;
  } catch (error) {
    throw new HostError(
      "invalid_params",
      error instanceof Error ? error.message : String(error),
    );
  }
};

export class PiBackgroundTasksFleetAdapter implements FleetProviderAdapter {
  readonly id = BG_PROVIDER_ID;
  readonly #killDeadlineMs: number;
  readonly #readDeadlineMs: number;
  #capabilities: BackgroundTaskCapabilities | undefined;
  #discovery: Promise<void> | undefined;
  #entries = new Map<string, ReturnType<typeof projectBackgroundTaskEntry>>();
  #events: ExtensionEventBus | undefined;
  #generation = 0;
  #issue: string | undefined;
  #nextRequestId = 0;
  #pending = new Map<string, PendingRequest>();
  #sessionId: string | undefined;
  #unsubscribeResponse: (() => void) | undefined;
  #unsubscribeTerminal: (() => void) | undefined;
  #unobserved = true;

  constructor(options: { killDeadlineMs?: number; readDeadlineMs?: number } = {}) {
    this.#killDeadlineMs = options.killDeadlineMs ?? BG_KILL_DEADLINE_MS;
    this.#readDeadlineMs = options.readDeadlineMs ?? BG_READ_DEADLINE_MS;
  }

  attach(events: ExtensionEventBus): () => void {
    this.#events = events;
    this.#unsubscribeResponse = events.on(BG_RESPONSE_CHANNEL, (value) => {
      this.#onResponse(value);
    });
    this.#unsubscribeTerminal = events.on(BG_TERMINAL_CHANNEL, (value) => {
      this.#onTerminal(value);
    });
    return () => {
      this.#unsubscribeResponse?.();
      this.#unsubscribeTerminal?.();
      this.#unsubscribeResponse = undefined;
      this.#unsubscribeTerminal = undefined;
      this.#endSession("pi-background-tasks Fleet adapter was disposed");
      this.#events = undefined;
    };
  }

  startSession(sessionId: string): void {
    this.#endSession("Pi session changed while talking to pi-background-tasks");
    this.#sessionId = sessionId;
    this.#discovery = this.#discover(sessionId, this.#generation);
  }

  endSession(): void {
    this.#endSession("Pi session closed while talking to pi-background-tasks");
  }

  async status(sessionId: string): Promise<PiFleetProviderResult> {
    if (this.#sessionId !== sessionId || !this.#events) {
      return emptyResult("unavailable", {
        issue: "Open a live Pi session to inspect background work",
      });
    }
    const generation = this.#generation;
    await this.#discovery;
    this.#assertSameGeneration(sessionId, generation);
    if (!this.#capabilities) {
      return emptyResult(this.#unobserved ? "unavailable" : "incompatible", {
        issue: this.#issue ?? "pi-background-tasks EventBus v1 was not observed in this session",
      });
    }
    if (!this.#capabilities.status) {
      return emptyResult("incompatible", {
        bridgeVersion: this.#capabilities.api_version,
        issue: "pi-background-tasks EventBus v1 does not advertise status",
      });
    }

    try {
      const result = await this.#request("status", {}, this.#readDeadlineMs);
      this.#assertSameGeneration(sessionId, generation);
      const tasks = parseBackgroundTaskStatusResult(result);
      this.#replaceEntries(tasks.map(projectBackgroundTaskEntry));
      return this.#snapshot("active");
    } catch (error) {
      this.#assertSameGeneration(sessionId, generation);
      this.#issue = error instanceof Error ? error.message : String(error);
      return {
        ...this.#snapshot("degraded"),
        provider: providerSnapshot("degraded", {
          actions: this.#providerActions(),
          bridgeVersion: this.#capabilities.api_version,
          issue: this.#issue,
        }),
      };
    }
  }

  async action(request: PiFleetProviderActionRequest): Promise<PiFleetProviderActionResult> {
    if (this.#sessionId !== request.sessionId || !this.#events) {
      throw new HostError("invalid_params", "Background-task Fleet actions require a live session");
    }
    const generation = this.#generation;
    await this.#discovery;
    this.#assertSameGeneration(request.sessionId, generation);
    if (!this.#capabilities) {
      throw new HostError(
        "unavailable",
        this.#issue ?? "pi-background-tasks EventBus v1 was not observed in this session",
      );
    }

    if (request.action === "run") {
      if (!this.#capabilities.run) {
        throw new HostError("invalid_params", "pi-background-tasks does not advertise run");
      }
      const payload = parseRunPayload(request.input);
      const result = await this.#request("run", { ...payload } as Record<string, unknown>, this.#readDeadlineMs);
      const entry = projectBackgroundTaskEntry(parseBackgroundTaskRunResult(result));
      this.#entries.set(entry.key, entry);
      return {
        entry,
        message: `Started ${entry.name}`,
        success: true,
      };
    }

    if (request.action === "logs") {
      if (!this.#capabilities.logs) {
        throw new HostError("invalid_params", "pi-background-tasks does not advertise logs");
      }
      const taskId = requireEntryKey(request.entryKey);
      const result = await this.#request("logs", { taskId }, this.#readDeadlineMs);
      const parsed = parseBackgroundTaskLogsResult(result);
      this.#entries.set(parsed.entry.key, parsed.entry);
      return {
        entry: parsed.entry,
        logs: parsed.logs,
        message: "Loaded bounded logs",
        success: true,
      };
    }

    if (request.action === "kill") {
      if (!this.#capabilities.kill) {
        throw new HostError("invalid_params", "pi-background-tasks does not advertise kill");
      }
      const taskId = requireEntryKey(request.entryKey);
      const current = this.#entries.get(taskId);
      if (current && current.state !== "running") {
        throw new HostError("invalid_params", "Only a running background task can be stopped");
      }
      const result = await this.#request("kill", { taskId }, this.#killDeadlineMs);
      const entry = projectBackgroundTaskEntry(parseBackgroundTaskKillResult(result).task);
      this.#entries.set(entry.key, entry);
      return {
        entry,
        message: `Stopped ${entry.name}`,
        success: true,
      };
    }

    throw new HostError("invalid_params", `Unknown pi-background-tasks action ${request.action}`);
  }

  async #discover(sessionId: string, generation: number): Promise<void> {
    try {
      const result = await this.#request("capabilities", {}, this.#readDeadlineMs);
      if (generation !== this.#generation || this.#sessionId !== sessionId) return;
      const capabilities = parseBackgroundTaskCapabilities(result);
      this.#capabilities = capabilities;
      this.#issue = undefined;
      this.#unobserved = false;
    } catch (error) {
      if (generation !== this.#generation || this.#sessionId !== sessionId) return;
      this.#capabilities = undefined;
      const message = error instanceof Error ? error.message : String(error);
      this.#unobserved = /timed out/i.test(message);
      this.#issue = this.#unobserved
        ? "pi-background-tasks EventBus v1 was not observed in this session"
        : message;
    }
  }

  #request(
    operation: BackgroundTaskOperation,
    payload: Record<string, unknown>,
    deadlineMs: number,
  ): Promise<unknown> {
    const events = this.#events;
    const sessionId = this.#sessionId;
    if (!events || !sessionId) {
      return Promise.reject(new Error("pi-background-tasks EventBus adapter is unavailable"));
    }
    const generation = this.#generation;
    const requestId = `piarium-bg-${generation}-${++this.#nextRequestId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(
          operation === "kill"
            ? "pi-background-tasks kill timed out"
            : "pi-background-tasks EventBus request timed out",
        ));
      }, deadlineMs);
      this.#pending.set(requestId, { operation, reject, resolve, timer });
      events.emit(
        BG_REQUEST_CHANNEL,
        createBackgroundTaskRequest(requestId, operation, payload),
      );
      if (generation !== this.#generation || this.#sessionId !== sessionId) {
        this.#pending.delete(requestId);
        clearTimeout(timer);
        reject(new Error("Pi session changed while talking to pi-background-tasks"));
      }
    });
  }

  #onResponse(value: unknown): void {
    let parsed;
    try {
      parsed = parseBackgroundTaskResponse(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#issue = message;
      const requestId = isRecord(value) && typeof value.request_id === "string"
        ? value.request_id
        : undefined;
      if (requestId) {
        const pending = this.#pending.get(requestId);
        if (pending) {
          this.#pending.delete(requestId);
          clearTimeout(pending.timer);
          pending.reject(new Error(message));
        }
      }
      return;
    }
    const pending = this.#pending.get(parsed.requestId);
    if (!pending) return;
    this.#pending.delete(parsed.requestId);
    clearTimeout(pending.timer);
    if (parsed.ok) pending.resolve(parsed.result);
    else pending.reject(new Error(parsed.error));
  }

  #onTerminal(value: unknown): void {
    if (!this.#sessionId) return;
    try {
      const entry = projectBackgroundTaskEntry(parseBackgroundTaskTerminal(value));
      if (!this.#entries.has(entry.key)) return;
      this.#entries.set(entry.key, entry);
    } catch (error) {
      this.#issue = error instanceof Error ? error.message : String(error);
    }
  }

  #replaceEntries(entries: ReturnType<typeof projectBackgroundTaskEntry>[]): void {
    const next = new Map<string, ReturnType<typeof projectBackgroundTaskEntry>>();
    for (const entry of entries) next.set(entry.key, entry);
    this.#entries = next;
  }

  #snapshot(state: PiFleetProviderResult["provider"]["state"]): PiFleetProviderResult {
    const entries = [...this.#entries.values()];
    const actions = this.#providerActions();
    return {
      entries,
      omitted: 0,
      provider: providerSnapshot(state, {
        ...(actions.length === 0 ? {} : { actions }),
        ...(this.#capabilities === undefined ? {} : { bridgeVersion: this.#capabilities.api_version }),
        ...(state === "active" || this.#issue === undefined ? {} : { issue: this.#issue }),
      }),
      totalActive: entries.filter((entry) => entry.state === "running").length,
    };
  }

  #providerActions(): PiFleetActionDescriptor[] {
    if (!this.#capabilities?.run) return [];
    return [{ action: "run", scope: "provider" }];
  }

  #assertSameGeneration(sessionId: string, generation: number): void {
    if (this.#sessionId !== sessionId || this.#generation !== generation) {
      throw new HostError("invalid_params", "Pi session changed while talking to pi-background-tasks");
    }
  }

  #endSession(message: string): void {
    this.#generation += 1;
    this.#capabilities = undefined;
    this.#discovery = undefined;
    this.#entries = new Map();
    this.#issue = undefined;
    this.#sessionId = undefined;
    this.#unobserved = true;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
  }
}

const requireEntryKey = (entryKey: string | undefined): string => {
  if (!entryKey || entryKey.trim().length === 0) {
    throw new HostError("invalid_params", "entryKey is required");
  }
  return entryKey;
};
