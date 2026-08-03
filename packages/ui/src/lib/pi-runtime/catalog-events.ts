type PiRuntimeCatalogChangeReason = 'package' | 'reload' | 'skill';

type PiRuntimeCatalogChangeListener = (reason: PiRuntimeCatalogChangeReason) => void;

const listeners = new Set<PiRuntimeCatalogChangeListener>();

export const subscribePiRuntimeCatalogChanged = (
  listener: PiRuntimeCatalogChangeListener,
): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Notify catalog consumers only after a host mutation has succeeded. */
export const notifyPiRuntimeCatalogChanged = (
  reason: PiRuntimeCatalogChangeReason,
): void => {
  for (const listener of listeners) listener(reason);
};
