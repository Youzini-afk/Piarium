/**
 * Foreground query embeddings run after the current native/HTTP batch, before
 * the next background scan batch. Work is not pre-queued for the whole repo.
 */

export type EmbedPriority = "foreground" | "background";

export function createEmbedScheduler() {
  let current: Promise<void> | null = null;
  const foreground: Array<() => void> = [];
  const background: Array<() => void> = [];

  const pump = (): void => {
    if (current) return;
    const next = foreground.shift() ?? background.shift();
    if (!next) return;
    current = Promise.resolve()
      .then(next)
      .catch(() => undefined)
      .finally(() => {
        current = null;
        pump();
      });
  };

  const enqueue = <T>(priority: EmbedPriority, work: () => Promise<T>): Promise<T> => (
    new Promise<T>((resolve, reject) => {
      const run = (): Promise<void> => work().then(resolve, reject);
      (priority === "foreground" ? foreground : background).push(run);
      pump();
    })
  );

  return {
    enqueue,
    get foregroundQueued() { return foreground.length; },
    get backgroundQueued() { return background.length; },
    get busy() { return current !== null; },
  };
}

export type EmbedScheduler = ReturnType<typeof createEmbedScheduler>;
