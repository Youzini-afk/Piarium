import type { SurfaceDisposer } from "./types.js";

export class SurfaceOwnerScope {
  readonly abortController = new AbortController();
  readonly #disposers: SurfaceDisposer[] = [];
  #disposed = false;

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  onDispose(disposer: SurfaceDisposer): void {
    if (this.#disposed) throw new Error("Cannot attach an effect to a disposed Surface owner scope");
    this.#disposers.push(disposer);
  }

  async dispose(reason?: unknown): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.abortController.abort(reason);
    const errors: unknown[] = [];
    for (let index = this.#disposers.length - 1; index >= 0; index -= 1) {
      try {
        await this.#disposers[index]?.();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#disposers.length = 0;
    if (errors.length > 0) throw new AggregateError(errors, "Surface owner cleanup failed");
  }
}
