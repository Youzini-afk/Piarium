import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PiFleetActionResult, PiFleetSnapshot } from "@piarium/protocol";
import { HostError } from "../errors.js";
import type {
  ExtensionEventBus,
  FleetProviderAdapter,
  PiFleetProviderActionRequest,
} from "./types.js";

export class FleetProviderRegistry {
  readonly #adapters: readonly FleetProviderAdapter[];

  constructor(adapters: readonly FleetProviderAdapter[]) {
    this.#adapters = adapters;
  }

  attach(events: ExtensionEventBus): () => void {
    const detachers = this.#adapters.map((adapter) => adapter.attach(events));
    return () => {
      for (const detach of detachers) detach();
    };
  }

  startSession(sessionId: string): void {
    for (const adapter of this.#adapters) adapter.startSession(sessionId);
  }

  endSession(): void {
    for (const adapter of this.#adapters) adapter.endSession();
  }

  async status(sessionId: string): Promise<PiFleetSnapshot> {
    const settled = await Promise.allSettled(
      this.#adapters.map((adapter) => adapter.status(sessionId)),
    );
    const entries = [];
    const providers = [];
    let omitted = 0;
    let totalActive = 0;
    for (const [index, result] of settled.entries()) {
      const adapter = this.#adapters[index]!;
      if (result.status === "fulfilled") {
        providers.push(result.value.provider);
        entries.push(...result.value.entries);
        omitted += result.value.omitted;
        totalActive += result.value.totalActive;
        continue;
      }
      providers.push({
        id: adapter.id,
        issue: result.reason instanceof Error ? result.reason.message : String(result.reason),
        label: adapter.id,
        state: "degraded" as const,
      });
    }
    return { entries, omitted, providers, totalActive };
  }

  async action(request: PiFleetProviderActionRequest & { providerId: string }): Promise<PiFleetActionResult> {
    const adapter = this.#adapters.find((candidate) => candidate.id === request.providerId);
    if (!adapter) throw new HostError("invalid_params", "Unknown Fleet provider");
    if (!adapter.action) {
      throw new HostError("invalid_params", "Fleet provider does not support this action");
    }
    const result = await adapter.action({
      action: request.action,
      ...(request.entryKey === undefined ? {} : { entryKey: request.entryKey }),
      ...(request.input === undefined ? {} : { input: request.input }),
      sessionId: request.sessionId,
    });
    return {
      ...(result.entry === undefined ? {} : { entry: result.entry }),
      ...(result.logs === undefined ? {} : { logs: result.logs }),
      message: result.message,
      providerId: adapter.id,
      snapshot: await this.status(request.sessionId),
      success: result.success,
    };
  }
}

export function createFleetRegistryExtension(registry: FleetProviderRegistry): ExtensionFactory {
  return (pi) => {
    const detach = registry.attach(pi.events);
    pi.on("session_start", (_event, context: ExtensionContext) => {
      const sessionId = context.sessionManager.getSessionId();
      if (sessionId) registry.startSession(sessionId);
    });
    pi.on("session_shutdown", () => {
      registry.endSession();
      detach();
    });
  };
}
