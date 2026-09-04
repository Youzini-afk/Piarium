export type ObservationObjectKind = "diagnostics" | "shell";

export interface ObservationCursorEntry<T> {
  observedAt: number;
  value: T;
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
    const entry: ObservationCursorEntry<T> = { observedAt: now(), value: structuredClone(value) };
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
