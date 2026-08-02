import { randomUUID } from "node:crypto";
import type { HostEvent, HostEventData } from "@piarium/protocol";
import { createDeferred, type Deferred } from "./deferred.js";

type EventEmitter = <E extends HostEvent>(event: E, data: HostEventData<E>) => void;

export interface ProjectTrustDecision {
  remember: boolean;
  trusted: boolean;
}

interface PendingTrustRequest {
  deferred: Deferred<ProjectTrustDecision>;
  timeout: NodeJS.Timeout | undefined;
}

export class ProjectTrustController {
  readonly #emit: EventEmitter;
  readonly #pending = new Map<string, PendingTrustRequest>();

  constructor(emit: EventEmitter) {
    this.#emit = emit;
  }

  request(cwd: string, timeoutMs?: number | null): Promise<ProjectTrustDecision> {
    if (
      timeoutMs !== undefined &&
      timeoutMs !== null &&
      (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    ) {
      throw new RangeError("timeoutMs must be non-negative");
    }
    const id = randomUUID();
    const deferred = createDeferred<ProjectTrustDecision>();
    const timeout = timeoutMs === undefined || timeoutMs === null || timeoutMs === 0
      ? undefined
      : setTimeout(() => {
          this.#pending.delete(id);
          deferred.resolve({ remember: false, trusted: false });
        }, timeoutMs);
    this.#pending.set(id, { deferred, timeout });
    this.#emit("project.trust.request", { cwd, id, reason: "project-resources" });
    return deferred.promise;
  }

  respond(input: { remember: boolean; requestId: string; trusted: boolean }): boolean {
    const pending = this.#pending.get(input.requestId);
    if (!pending) return false;
    if (pending.timeout) clearTimeout(pending.timeout);
    this.#pending.delete(input.requestId);
    pending.deferred.resolve({ remember: input.remember, trusted: input.trusted });
    return true;
  }

  cancelAll(): void {
    for (const pending of this.#pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.deferred.resolve({ remember: false, trusted: false });
    }
    this.#pending.clear();
  }
}
