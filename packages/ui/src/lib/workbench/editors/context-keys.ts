import { evaluatePiariumContextExpression, type PiariumContextExpressionV1 } from '@piarium/extension-contract';

const keys = new Map<string, string | boolean | number>();
const listenersByKey = new Map<string, Set<() => void>>();

export const setWorkbenchContextKey = (key: string, value: string | boolean | number): void => {
  if (keys.get(key) === value) return;
  keys.set(key, value);
  for (const listener of listenersByKey.get(key) ?? []) listener();
};

export const getWorkbenchContextKey = (key: string): string | boolean | number | undefined => keys.get(key);

/**
 * Return a read-only view of the entire context key store.
 * Used by the Surface runtime to evaluate `when` expressions.
 */
export const getWorkbenchContextKeyStore = (): ReadonlyMap<string, string | boolean | number> => keys;

export const clearWorkbenchContextKeys = (prefix?: string): void => {
  const removed: string[] = [];
  if (!prefix) {
    removed.push(...keys.keys());
    keys.clear();
  } else {
    for (const key of [...keys.keys()]) {
      if (key.startsWith(prefix)) {
        keys.delete(key);
        removed.push(key);
      }
    }
  }
  for (const key of removed) {
    for (const listener of listenersByKey.get(key) ?? []) listener();
  }
};

export const subscribeWorkbenchContextKey = (key: string, listener: () => void): (() => void) => {
  let listeners = listenersByKey.get(key);
  if (!listeners) {
    listeners = new Set();
    listenersByKey.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
  };
};

export const whenWorkbenchContext = (expression: Record<string, string | boolean | number>): boolean => (
  Object.entries(expression).every(([key, value]) => keys.get(key) === value)
);

/**
 * Evaluate a structured PiariumContextExpressionV1 against the workbench
 * context key store. This is the structured-expression counterpart to
 * whenWorkbenchContext, used by extension contribution visibility projection.
 */
export const evaluateWorkbenchContextExpression = (expression: PiariumContextExpressionV1): boolean => (
  evaluatePiariumContextExpression(expression, keys as ReadonlyMap<string, string | number | boolean>)
);

// --- Owner-scoped context key writers ---

interface OwnerScopeState {
  prefix: string;
  generation: number;
  disposed: boolean;
}

const ownerScopes = new Map<string, OwnerScopeState>();

/**
 * Create an owner-scoped context key writer. Keys written through the
 * returned writer are namespaced with the owner's prefix and fenced by
 * generation — writes from a stale generation are silently rejected.
 * All owner-scoped keys are cleaned up when the returned dispose function
 * is called.
 */
export const createOwnerScopedContextWriter = (
  owner: { extensionId: string; entrypointId: string; generation: number; realmId: string },
): { writer: { set: (key: string, value: string | boolean | number) => boolean; delete: (key: string) => boolean }; dispose: () => void } => {
  const scopeKey = `${owner.extensionId}\0${owner.realmId}\0${owner.entrypointId}`;
  const prefix = `${owner.extensionId}.`;
  const state: OwnerScopeState = { prefix, generation: owner.generation, disposed: false };
  ownerScopes.set(scopeKey, state);

  const namespacedKey = (key: string): string => `${prefix}${key}`;

  const writer = {
    set: (key: string, value: string | boolean | number): boolean => {
      if (state.disposed) return false;
      // Generation fencing: reject writes from a stale generation.
      if (owner.generation !== state.generation) return false;
      setWorkbenchContextKey(namespacedKey(key), value);
      return true;
    },
    delete: (key: string): boolean => {
      if (state.disposed) return false;
      const fullKey = namespacedKey(key);
      if (!keys.has(fullKey)) return false;
      keys.delete(fullKey);
      for (const listener of listenersByKey.get(fullKey) ?? []) listener();
      return true;
    },
  };

  const dispose = (): void => {
    if (state.disposed) return;
    state.disposed = true;
    ownerScopes.delete(scopeKey);
    // Clean up all keys with this owner's prefix.
    const removed: string[] = [];
    for (const key of [...keys.keys()]) {
      if (key.startsWith(prefix)) {
        keys.delete(key);
        removed.push(key);
      }
    }
    for (const key of removed) {
      for (const listener of listenersByKey.get(key) ?? []) listener();
    }
  };

  return { writer, dispose };
};
