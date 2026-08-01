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
  timeout: NodeJS.Timeout;
}

export class ProjectTrustController {
  readonly #emit: EventEmitter;
  readonly #pending = new Map<string, PendingTrustRequest>();

  constructor(emit: EventEmitter) {
    this.#emit = emit;
  }

  request(cwd: string, timeoutMs: number = 120_000): Promise<ProjectTrustDecision> {
    const id = randomUUID();
    const deferred = createDeferred<ProjectTrustDecision>();
    const timeout = setTimeout(() => {
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
    clearTimeout(pending.timeout);
    this.#pending.delete(input.requestId);
    pending.deferred.resolve({ remember: input.remember, trusted: input.trusted });
    return true;
  }

  cancelAll(): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.deferred.resolve({ remember: false, trusted: false });
    }
    this.#pending.clear();
  }
}
