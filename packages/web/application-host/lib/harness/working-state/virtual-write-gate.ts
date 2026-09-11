/** Serializes unpublished virtual writes so materialize can wait for in-flight tools. */
export class VirtualWriteGate {
  readonly #pending = new Map<string, Set<Promise<void>>>();
  readonly #switching = new Set<string>();
  readonly #switchWait = new Map<string, Promise<void>>();
  readonly #switchResolve = new Map<string, () => void>();

  begin(sessionId: string): { finish(): void } | "switching" {
    if (this.#switching.has(sessionId)) return "switching";
    let resolve = (): void => undefined;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const group = this.#pending.get(sessionId) ?? new Set<Promise<void>>();
    group.add(pending);
    this.#pending.set(sessionId, group);
    return {
      finish: () => {
        resolve();
        group.delete(pending);
        if (group.size === 0) this.#pending.delete(sessionId);
      },
    };
  }

  async wait(sessionId: string): Promise<void> {
    const group = this.#pending.get(sessionId);
    if (!group || group.size === 0) return;
    await Promise.all([...group]);
  }

  async beginSwitch(sessionId: string): Promise<"owner" | "already"> {
    const existing = this.#switchWait.get(sessionId);
    if (existing) {
      await existing;
      return "already";
    }
    this.#switching.add(sessionId);
    this.#switchWait.set(sessionId, new Promise<void>((done) => {
      this.#switchResolve.set(sessionId, done);
    }));
    await this.wait(sessionId);
    return "owner";
  }

  endSwitch(sessionId: string): void {
    this.#switching.delete(sessionId);
    this.#switchResolve.get(sessionId)?.();
    this.#switchWait.delete(sessionId);
    this.#switchResolve.delete(sessionId);
  }

  switching(sessionId: string): boolean {
    return this.#switching.has(sessionId);
  }

  async waitSwitch(sessionId: string, signal?: AbortSignal): Promise<void> {
    const pending = this.#switchWait.get(sessionId);
    if (!pending) return;
    if (!signal) {
      await pending;
      return;
    }
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason instanceof Error ? signal.reason : new DOMException("This operation was aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort);
      pending.then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
    });
  }
}

export const acquireVirtualWriteTicket = async (
  gate: VirtualWriteGate,
  sessionId: string,
  stillVirtual: () => boolean,
  signal?: AbortSignal,
): Promise<{ finish(): void } | "disk"> => {
  for (;;) {
    signal?.throwIfAborted();
    if (!stillVirtual()) return "disk";
    const ticket = gate.begin(sessionId);
    if (ticket === "switching") {
      await gate.waitSwitch(sessionId, signal);
      continue;
    }
    if (!stillVirtual()) {
      ticket.finish();
      return "disk";
    }
    return ticket;
  }
};
