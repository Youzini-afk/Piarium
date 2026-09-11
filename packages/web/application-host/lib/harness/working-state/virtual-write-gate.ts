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

  async waitSwitch(sessionId: string): Promise<void> {
    await this.#switchWait.get(sessionId);
  }
}
