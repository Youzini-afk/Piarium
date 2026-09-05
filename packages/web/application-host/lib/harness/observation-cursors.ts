export type ObservationObjectKind = "diagnostics" | "shell" | "zone2-threads";

export interface ObservationCursorEntry<T> {
  observedAt: number;
  /** Store-local monotonic revision used for compare-and-swap. */
  revision: number;
  value: T;
}

/**
 * A pending observation that has been prepared but not yet committed.
 * The cursor is NOT advanced until `commit()` is called, so if the
 * response delivery fails, the next observation will include the
 * undelivered changes.
 *
 * `commit()` uses compare-and-swap: it only advances the cursor if the
 * current cursor's monotonic revision still matches the baseline captured
 * during `prepare()`. If another observation has committed in the
 * meantime, the stale commit is a no-op, preventing cursor regression.
 */
export interface PendingObservation<TResult> {
  result: TResult;
  /**
   * Commit the cursor advancement after successful response delivery.
   * Returns true if the cursor was advanced, false if a newer observation
   * has already committed (stale commit, no-op).
   */
  commit: () => boolean;
  /** Abort the observation — the cursor is not advanced. */
  abort: () => void;
}

export interface ObservationCursorStore {
  now(): number;
  get<T>(observerSessionId: string, objectKind: ObservationObjectKind, objectId: string): ObservationCursorEntry<T> | null;
  set<T>(observerSessionId: string, objectKind: ObservationObjectKind, objectId: string, value: T): ObservationCursorEntry<T>;
  observe<TCursor, TResult>(
    observerSessionId: string,
    objectKind: ObservationObjectKind,
    objectId: string,
    task: (previous: ObservationCursorEntry<TCursor> | null) => Promise<{ cursor: TCursor; result: TResult }>,
  ): Promise<TResult>;
  /**
   * Prepare an observation without advancing the cursor. The caller must
   * call `commit()` on the returned pending observation after the response
   * is successfully delivered. If `commit()` is never called, the cursor
   * stays at its previous position and the next observation includes the
   * undelivered changes.
   */
  prepare<TCursor, TResult>(
    observerSessionId: string,
    objectKind: ObservationObjectKind,
    objectId: string,
    task: (previous: ObservationCursorEntry<TCursor> | null) => Promise<{ cursor: TCursor; result: TResult }>,
  ): Promise<PendingObservation<TResult>>;
  clearKind(observerSessionId: string, objectKind: ObservationObjectKind): void;
  clearObserver(observerSessionId: string): void;
  dispose(): void;
}

export interface ObservationCursorStoreOptions {
  now?: () => number;
}

/**
 * Host-owned cursors for repeat observations. They intentionally live only for
 * the Host generation: a restart or compaction makes the next read a full
 * baseline again instead of pretending an unavailable baseline still exists.
 */
export function createObservationCursorStore(
  options: ObservationCursorStoreOptions = {},
): ObservationCursorStore {
  const now = options.now ?? Date.now;
  const observers = new Map<string, Map<ObservationObjectKind, Map<string, ObservationCursorEntry<unknown>>>>();
  const tails = new Map<string, Promise<void>>();
  const epochs = new Map<string, number>();
  const activeNamespaces = new Map<string, number>();
  let nextRevision = 0;
  let disposed = false;

  const namespaceKey = (observerSessionId: string, objectKind: ObservationObjectKind): string => (
    `${observerSessionId}\0${objectKind}`
  );
  const cursorKey = (observerSessionId: string, objectKind: ObservationObjectKind, objectId: string): string => (
    `${namespaceKey(observerSessionId, objectKind)}\0${objectId}`
  );
  const invalidate = (observerSessionId: string, objectKind: ObservationObjectKind): void => {
    const key = namespaceKey(observerSessionId, objectKind);
    if ((activeNamespaces.get(key) ?? 0) > 0) epochs.set(key, (epochs.get(key) ?? 0) + 1);
    else epochs.delete(key);
  };

  const objectsFor = (
    observerSessionId: string,
    objectKind: ObservationObjectKind,
    create: boolean,
  ): Map<string, ObservationCursorEntry<unknown>> | null => {
    let kinds = observers.get(observerSessionId);
    if (!kinds && create) {
      kinds = new Map();
      observers.set(observerSessionId, kinds);
    }
    if (!kinds) return null;
    let objects = kinds.get(objectKind);
    if (!objects && create) {
      objects = new Map();
      kinds.set(objectKind, objects);
    }
    return objects ?? null;
  };

  const readCursor = <T>(
    observerSessionId: string,
    objectKind: ObservationObjectKind,
    objectId: string,
  ): ObservationCursorEntry<T> | null => {
    const entry = objectsFor(observerSessionId, objectKind, false)?.get(objectId);
    return entry ? structuredClone(entry) as ObservationCursorEntry<T> : null;
  };

  const writeCursor = <T>(
    observerSessionId: string,
    objectKind: ObservationObjectKind,
    objectId: string,
    value: T,
  ): ObservationCursorEntry<T> => {
    const entry: ObservationCursorEntry<T> = {
      observedAt: now(),
      revision: ++nextRevision,
      value: structuredClone(value),
    };
    objectsFor(observerSessionId, objectKind, true)!.set(objectId, entry);
    return structuredClone(entry);
  };

  return {
    now,

    get<T>(observerSessionId: string, objectKind: ObservationObjectKind, objectId: string) {
      return readCursor<T>(observerSessionId, objectKind, objectId);
    },

    set<T>(observerSessionId: string, objectKind: ObservationObjectKind, objectId: string, value: T) {
      return writeCursor(observerSessionId, objectKind, objectId, value);
    },

    async observe<TCursor, TResult>(
      observerSessionId: string,
      objectKind: ObservationObjectKind,
      objectId: string,
      task: (previous: ObservationCursorEntry<TCursor> | null) => Promise<{ cursor: TCursor; result: TResult }>,
    ): Promise<TResult> {
      if (disposed) throw new Error("Observation cursor store is disposed");
      const key = cursorKey(observerSessionId, objectKind, objectId);
      const namespace = namespaceKey(observerSessionId, objectKind);
      activeNamespaces.set(namespace, (activeNamespaces.get(namespace) ?? 0) + 1);
      const requestedEpoch = epochs.get(namespace) ?? 0;
      const previousTail = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const currentTail = new Promise<void>((resolve) => { release = resolve; });
      tails.set(key, currentTail);
      await previousTail;
      try {
        const previous = readCursor<TCursor>(observerSessionId, objectKind, objectId);
        const outcome = await task(previous);
        if (!disposed && (epochs.get(namespace) ?? 0) === requestedEpoch) {
          writeCursor(observerSessionId, objectKind, objectId, outcome.cursor);
        }
        return outcome.result;
      } finally {
        release();
        if (tails.get(key) === currentTail) tails.delete(key);
        const active = (activeNamespaces.get(namespace) ?? 1) - 1;
        if (active === 0) {
          activeNamespaces.delete(namespace);
          epochs.delete(namespace);
        } else {
          activeNamespaces.set(namespace, active);
        }
      }
    },

    async prepare<TCursor, TResult>(
      observerSessionId: string,
      objectKind: ObservationObjectKind,
      objectId: string,
      task: (previous: ObservationCursorEntry<TCursor> | null) => Promise<{ cursor: TCursor; result: TResult }>,
    ): Promise<PendingObservation<TResult>> {
      if (disposed) throw new Error("Observation cursor store is disposed");
      const key = cursorKey(observerSessionId, objectKind, objectId);
      const namespace = namespaceKey(observerSessionId, objectKind);
      activeNamespaces.set(namespace, (activeNamespaces.get(namespace) ?? 0) + 1);
      const requestedEpoch = epochs.get(namespace) ?? 0;
      const previousTail = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const currentTail = new Promise<void>((resolve) => { release = resolve; });
      tails.set(key, currentTail);
      await previousTail;
      let outcome: { cursor: TCursor; result: TResult };
      try {
        const previous = readCursor<TCursor>(observerSessionId, objectKind, objectId);
        outcome = await task(previous);
        const baselineRevision = previous?.revision ?? null;
        release();
        if (tails.get(key) === currentTail) tails.delete(key);
        let settled = false;
        const finishPending = (): void => {
          if (settled) return;
          settled = true;
          const active = (activeNamespaces.get(namespace) ?? 1) - 1;
          if (active === 0) {
            activeNamespaces.delete(namespace);
            epochs.delete(namespace);
          } else {
            activeNamespaces.set(namespace, active);
          }
        };
        return {
          result: outcome.result,
          commit: (): boolean => {
            if (settled) return false;
            let advanced = false;
            if (!disposed && (epochs.get(namespace) ?? 0) === requestedEpoch) {
              const current = readCursor<TCursor>(observerSessionId, objectKind, objectId);
              const currentRevision = current?.revision ?? null;
              if (currentRevision === baselineRevision) {
                writeCursor(observerSessionId, objectKind, objectId, outcome.cursor);
                advanced = true;
              }
            }
            finishPending();
            return advanced;
          },
          abort: () => {
            finishPending();
          },
        };
      } catch (error) {
        release();
        if (tails.get(key) === currentTail) tails.delete(key);
        const active = (activeNamespaces.get(namespace) ?? 1) - 1;
        if (active === 0) {
          activeNamespaces.delete(namespace);
          epochs.delete(namespace);
        } else {
          activeNamespaces.set(namespace, active);
        }
        throw error;
      }
    },

    clearKind(observerSessionId: string, objectKind: ObservationObjectKind): void {
      invalidate(observerSessionId, objectKind);
      const kinds = observers.get(observerSessionId);
      if (!kinds) return;
      kinds.delete(objectKind);
      if (kinds.size === 0) observers.delete(observerSessionId);
    },

    clearObserver(observerSessionId: string): void {
      invalidate(observerSessionId, "diagnostics");
      invalidate(observerSessionId, "shell");
      invalidate(observerSessionId, "zone2-threads");
      observers.delete(observerSessionId);
    },

    dispose(): void {
      disposed = true;
      observers.clear();
      epochs.clear();
      activeNamespaces.clear();
    },
  };
}
