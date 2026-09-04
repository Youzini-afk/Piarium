import type {
  PiFleetEntry,
  PiFleetActionDescriptor,
  ThreadListItem,
} from "@piarium/protocol";
import type { HostServicesBridge } from "../harness/host-services-bridge.js";
import { HostError } from "../errors.js";
import type {
  ExtensionEventBus,
  FleetProviderAdapter,
  PiFleetProviderActionRequest,
  PiFleetProviderActionResult,
  PiFleetProviderResult,
} from "./types.js";

export const PIARIUM_HARNESS_FLEET_PROVIDER_ID = "piarium-harness";

const LOGS_ACTION: PiFleetActionDescriptor = { action: "logs", scope: "entry" };
const KILL_ACTION: PiFleetActionDescriptor = { action: "kill", destructive: true, scope: "entry" };

const entryState = (thread: ThreadListItem): PiFleetEntry["state"] => {
  if (thread.activeRun?.outcome === "success") return "completed";
  if (thread.activeRun?.outcome === "cancelled") return "stopped";
  if (thread.activeRun?.outcome === "failure" || thread.activeRun?.outcome === "lost") return "failed";
  return "running";
};

const projectEntry = (thread: ThreadListItem): PiFleetEntry => {
  const state = entryState(thread);
  const tokens = thread.activeRun?.tokens;
  return {
    actions: [LOGS_ACTION, ...(state === "running" ? [KILL_ACTION] : [])],
    description: thread.brief,
    ...(thread.activeRun?.endedAt ? { endedAt: Date.parse(thread.activeRun.endedAt) } : {}),
    ...(thread.activeRun?.exitReason ? { error: thread.activeRun.exitReason } : {}),
    key: thread.id,
    kind: "delegated-agent",
    name: thread.role ?? thread.id,
    providerId: PIARIUM_HARNESS_FLEET_PROVIDER_ID,
    ...(thread.role ? { role: thread.role } : {}),
    startedAt: Date.parse(thread.activeRun?.startedAt ?? thread.createdAt),
    state,
    ...(tokens ? { tokens: { input: tokens.input, output: tokens.output, total: tokens.input + tokens.output } } : {}),
  };
};

export class PiariumHarnessFleetAdapter implements FleetProviderAdapter {
  readonly id = PIARIUM_HARNESS_FLEET_PROVIDER_ID;
  readonly #bridge: HostServicesBridge;
  #sessionId: string | undefined;

  constructor(bridge: HostServicesBridge) {
    this.#bridge = bridge;
  }

  attach(_events: ExtensionEventBus): () => void {
    return () => {};
  }

  startSession(sessionId: string): void {
    this.#sessionId = sessionId;
  }

  endSession(): void {
    this.#sessionId = undefined;
  }

  async status(sessionId: string): Promise<PiFleetProviderResult> {
    if (this.#sessionId !== sessionId) {
      return {
        entries: [],
        omitted: 0,
        provider: {
          id: this.id,
          issue: "Open the owning Pi session to inspect its threads",
          label: "Piarium threads",
          source: "builtin",
          state: "unavailable",
        },
        totalActive: 0,
      };
    }
    const result = await this.#bridge.request<"thread.list">("thread.list", { full: true });
    const entries = result.threads.map(projectEntry);
    return {
      entries,
      omitted: 0,
      provider: {
        id: this.id,
        label: "Piarium threads",
        source: "builtin",
        state: "active",
      },
      totalActive: entries.filter((entry) => entry.state === "running").length,
    };
  }

  async action(request: PiFleetProviderActionRequest): Promise<PiFleetProviderActionResult> {
    if (this.#sessionId !== request.sessionId || !request.entryKey) {
      throw new HostError("invalid_params", "Harness thread actions require a live owning session and thread id");
    }
    if (request.action === "kill") {
      const result = await this.#bridge.request<"thread.kill">("thread.kill", {
        threadId: request.entryKey,
        keepWorktree: true,
      });
      return { message: result.text, success: true };
    }
    if (request.action === "logs") {
      const result = await this.#bridge.request<"thread.read">("thread.read", {
        threadId: request.entryKey,
        what: "steps",
      });
      return {
        logs: {
          bytesRead: Buffer.byteLength(result.text, "utf8"),
          tail: false,
          text: result.text,
          truncated: false,
        },
        message: "Loaded thread transcript",
        success: true,
      };
    }
    throw new HostError("invalid_params", `Unknown Piarium thread action ${request.action}`);
  }
}
