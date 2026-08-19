import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type {
  PiFleetEntry,
  PiFleetProviderSnapshot,
} from "@piarium/protocol";
import { BG_READ_DEADLINE_MS } from "./fleet/background-tasks-eventbus.js";
import type { FleetProviderAdapter, PiFleetProviderResult } from "./fleet/types.js";

const PI_SUBAGENTS_RPC_VERSION = 1;
export const PI_SUBAGENTS_RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const PI_SUBAGENTS_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const PI_SUBAGENTS_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";

const PROVIDER_ID = "pi-subagents";
const PROVIDER_LABEL = "pi-subagents";
const PROVIDER_SOURCE = "npm:pi-subagents";

type ExtensionEventBus = ExtensionAPI["events"];

interface CompatibleReadyState {
  compatible: true;
  version: number;
}

interface IncompatibleReadyState {
  compatible: false;
  issue: string;
  version?: number;
}

type ReadyState = CompatibleReadyState | IncompatibleReadyState;

interface PendingRequest {
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  unsubscribe?: () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === "object" && !Array.isArray(value)
);

const readNonEmptyString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
};

const readOptionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  return readNonEmptyString(value, field);
};

const readCount = (value: unknown, field: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value as number;
};

const providerSnapshot = (
  state: PiFleetProviderSnapshot["state"],
  options: { bridgeVersion?: number; issue?: string } = {},
): PiFleetProviderSnapshot => ({
  ...(options.bridgeVersion === undefined ? {} : { bridgeVersion: options.bridgeVersion }),
  id: PROVIDER_ID,
  ...(options.issue === undefined ? {} : { issue: options.issue }),
  label: PROVIDER_LABEL,
  source: PROVIDER_SOURCE,
  state,
});

const emptyResult = (provider: PiFleetProviderSnapshot): PiFleetProviderResult => ({
  entries: [],
  omitted: 0,
  provider,
  totalActive: 0,
});

const parseReady = (value: unknown, expectedSessionId: string): ReadyState => {
  if (!isRecord(value)) {
    return { compatible: false, issue: "pi-subagents returned an invalid RPC ready payload" };
  }
  const version = typeof value.version === "number" ? value.version : undefined;
  if (version !== PI_SUBAGENTS_RPC_VERSION) {
    return {
      compatible: false,
      ...(version === undefined ? {} : { version }),
      issue: version === undefined
        ? "pi-subagents did not report an RPC version"
        : `pi-subagents RPC v${version} is not supported`,
    };
  }
  if (!Array.isArray(value.methods) || !value.methods.includes("status")) {
    return { compatible: false, issue: "pi-subagents RPC does not advertise status", version };
  }
  const capabilities = isRecord(value.capabilities) ? value.capabilities : undefined;
  const fleetStatus = capabilities && isRecord(capabilities.fleetStatus)
    ? capabilities.fleetStatus
    : undefined;
  if (fleetStatus?.version !== 1) {
    return { compatible: false, issue: "pi-subagents does not advertise fleetStatus v1", version };
  }
  const session = isRecord(value.session) ? value.session : undefined;
  if (session?.sessionId !== expectedSessionId) {
    return {
      compatible: false,
      issue: "pi-subagents RPC ready state belongs to a different session",
      version,
    };
  }
  return { compatible: true, version };
};

const parseFleetEntry = (value: unknown, index: number): PiFleetEntry => {
  if (!isRecord(value)) throw new Error(`fleet.entries[${index}] must be an object`);
  if (!isRecord(value.tokens)) throw new Error(`fleet.entries[${index}].tokens must be an object`);
  const effort = readOptionalString(value.effort, `fleet.entries[${index}].effort`);
  const goal = readOptionalString(value.goal, `fleet.entries[${index}].goal`);
  const model = readOptionalString(value.model, `fleet.entries[${index}].model`);
  const role = readOptionalString(value.role, `fleet.entries[${index}].role`);
  return {
    actions: [],
    agent: readNonEmptyString(value.agent, `fleet.entries[${index}].agent`),
    ...(effort === undefined ? {} : { effort }),
    ...(goal === undefined ? {} : { description: goal }),
    key: readNonEmptyString(value.key, `fleet.entries[${index}].key`),
    kind: "delegated-agent",
    ...(model === undefined ? {} : { model }),
    name: readNonEmptyString(value.agent, `fleet.entries[${index}].agent`),
    providerId: PROVIDER_ID,
    ...(role === undefined ? {} : { role }),
    startedAt: readCount(value.startedAt, `fleet.entries[${index}].startedAt`),
    state: "running",
    tokens: {
      input: readCount(value.tokens.input, `fleet.entries[${index}].tokens.input`),
      output: readCount(value.tokens.output, `fleet.entries[${index}].tokens.output`),
      total: readCount(value.tokens.total, `fleet.entries[${index}].tokens.total`),
    },
  };
};

const parseStatusReply = (value: unknown, bridgeVersion: number): PiFleetProviderResult => {
  if (!isRecord(value) || value.version !== PI_SUBAGENTS_RPC_VERSION || value.success !== true) {
    if (isRecord(value) && value.success === false && isRecord(value.error)) {
      const code = typeof value.error.code === "string" ? value.error.code : "rpc_failed";
      const message = typeof value.error.message === "string"
        ? value.error.message
        : "pi-subagents RPC status failed";
      throw new Error(`${code}: ${message}`);
    }
    throw new Error("pi-subagents returned an invalid RPC status reply");
  }
  if (!isRecord(value.data) || !isRecord(value.data.fleet) || value.data.fleet.version !== 1) {
    throw new Error("pi-subagents status did not return fleetStatus v1");
  }
  const fleet = value.data.fleet;
  if (!Array.isArray(fleet.entries)) throw new Error("pi-subagents fleet entries must be an array");
  const entries = fleet.entries.map(parseFleetEntry);
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length) {
    throw new Error("pi-subagents fleet entries contain duplicate keys");
  }
  const totalActive = readCount(fleet.totalActive, "fleet.totalActive");
  const omitted = readCount(fleet.omitted, "fleet.omitted");
  if (totalActive < entries.length) {
    throw new Error("pi-subagents fleet totalActive is smaller than its entry list");
  }
  return {
    entries,
    omitted,
    provider: providerSnapshot("active", { bridgeVersion }),
    totalActive,
  };
};

export class PiSubagentsFleetBridge implements FleetProviderAdapter {
  readonly id = PROVIDER_ID;
  readonly #readDeadlineMs: number;
  #events: ExtensionEventBus | undefined;
  #generation = 0;
  #nextRequestId = 0;
  #pendingReady: unknown;
  #pending = new Map<string, PendingRequest>();
  #ready: ReadyState | undefined;
  #sessionId: string | undefined;

  constructor(options: { readDeadlineMs?: number } = {}) {
    this.#readDeadlineMs = options.readDeadlineMs ?? BG_READ_DEADLINE_MS;
  }

  attach(events: ExtensionEventBus): () => void {
    this.#events = events;
    const unsubscribe = events.on(PI_SUBAGENTS_RPC_READY_EVENT, (value) => {
      if (!this.#sessionId) {
        this.#pendingReady = value;
        return;
      }
      this.#ready = parseReady(value, this.#sessionId);
    });
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
      this.#endSession("Pi subagents Fleet bridge was disposed");
      this.#events = undefined;
    };
  }

  startSession(sessionId: string): void {
    const pendingReady = this.#pendingReady;
    this.#endSession("Pi session changed while reading subagent Fleet status");
    this.#sessionId = sessionId;
    if (pendingReady !== undefined) {
      this.#ready = parseReady(pendingReady, sessionId);
    }
  }

  endSession(): void {
    this.#endSession("Pi session closed while reading subagent Fleet status");
  }

  async status(sessionId: string): Promise<PiFleetProviderResult> {
    if (this.#sessionId !== sessionId || !this.#events) {
      return emptyResult(providerSnapshot("unavailable", {
        issue: "Open a live Pi session to inspect delegated work",
      }));
    }
    if (!this.#ready) {
      return emptyResult(providerSnapshot("unavailable", {
        issue: "pi-subagents is not active in this session",
      }));
    }
    if (!this.#ready.compatible) {
      return emptyResult(providerSnapshot("incompatible", {
        ...(this.#ready.version === undefined ? {} : { bridgeVersion: this.#ready.version }),
        issue: this.#ready.issue,
      }));
    }

    try {
      const reply = await this.#requestStatus(sessionId);
      return parseStatusReply(reply, this.#ready.version);
    } catch (error) {
      return emptyResult(providerSnapshot("degraded", {
        bridgeVersion: this.#ready.version,
        issue: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  async #requestStatus(sessionId: string): Promise<unknown> {
    const events = this.#events;
    if (!events || this.#sessionId !== sessionId) throw new Error("Pi subagents Fleet bridge is unavailable");
    const generation = this.#generation;
    const requestId = `piarium-fleet-${generation}-${++this.#nextRequestId}`;
    const replyEvent = `${PI_SUBAGENTS_RPC_REPLY_PREFIX}${requestId}`;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        const pending = this.#pending.get(requestId);
        this.#pending.delete(requestId);
        if (pending?.timer !== undefined) clearTimeout(pending.timer);
        pending?.unsubscribe?.();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("pi-subagents Fleet status timed out"));
      }, this.#readDeadlineMs);
      const unsubscribe = events.on(replyEvent, (reply) => {
        cleanup();
        if (generation !== this.#generation || this.#sessionId !== sessionId) {
          reject(new Error("Pi session changed while reading subagent Fleet status"));
          return;
        }
        if (!isRecord(reply) || reply.requestId !== requestId) {
          reject(new Error("pi-subagents returned a Fleet reply with the wrong request ID"));
          return;
        }
        resolve(reply);
      });
      this.#pending.set(requestId, {
        reject,
        timer,
        ...(typeof unsubscribe === "function" ? { unsubscribe } : {}),
      });
      events.emit(PI_SUBAGENTS_RPC_REQUEST_EVENT, {
        method: "status",
        params: {},
        requestId,
        source: { extension: "piarium" },
        version: PI_SUBAGENTS_RPC_VERSION,
      });
    });
  }

  #endSession(message: string): void {
    this.#generation += 1;
    this.#ready = undefined;
    this.#pendingReady = undefined;
    this.#sessionId = undefined;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const request of pending) {
      if (request.timer !== undefined) clearTimeout(request.timer);
      request.unsubscribe?.();
      request.reject(new Error(message));
    }
  }
}

export function createPiSubagentsFleetBridgeExtension(
  bridge: PiSubagentsFleetBridge,
): ExtensionFactory {
  return (pi) => {
    const detach = bridge.attach(pi.events);
    pi.on("session_start", (_event, context: ExtensionContext) => {
      const sessionId = context.sessionManager.getSessionId();
      if (sessionId) bridge.startSession(sessionId);
    });
    pi.on("session_shutdown", () => {
      bridge.endSession();
      detach();
    });
  };
}
