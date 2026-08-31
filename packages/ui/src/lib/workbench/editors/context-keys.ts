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
