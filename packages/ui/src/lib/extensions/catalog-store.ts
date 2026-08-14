import React, { useSyncExternalStore } from 'react';
import type {
  PiariumExtensionCandidateCapabilityReviewRequest,
  PiariumExtensionCapabilityReviewRequest,
  PiariumExtensionCatalogSnapshot,
  PiariumExtensionHostStateSnapshot,
  PiariumExtensionPackageSource,
  PiariumExtensionServiceRoutingContext,
} from '@piarium/extension-contract';
import { serviceRoutingRuleKey } from '@piarium/extension-contract';
import { refreshSurfaceExtensions, surfaceExtensionLoader } from './managed-runtime';

export interface PiariumExtensionCatalogStoreState {
  busyExtensionId: string | null;
  error: string | null;
  loading: boolean;
  snapshot: PiariumExtensionHostStateSnapshot | null;
}

const initialState = (): PiariumExtensionCatalogStoreState => ({
  busyExtensionId: null,
  error: null,
  loading: false,
  snapshot: null,
});

let state = initialState();
let generation = 0;
let startPromise: Promise<void> | null = null;
let watchController: AbortController | null = null;
let mutationQueue: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

const extensionsApi = () => {
  const api = typeof window === 'undefined' ? undefined : window.__PIARIUM_RUNTIME_APIS__?.extensions;
  if (!api) throw new Error('Piarium application-host extension API is unavailable');
  return api;
};

const publish = (next: PiariumExtensionCatalogStoreState): void => {
  state = next;
  for (const listener of listeners) listener();
};

const acceptSnapshot = (snapshot: PiariumExtensionHostStateSnapshot, requestGeneration: number): boolean => {
  if (requestGeneration !== generation) return false;
  const current = state.snapshot;
  if (
    current
    && current.catalog.hostId === snapshot.catalog.hostId
    && (snapshot.revision < current.revision || snapshot.catalog.revision < current.catalog.revision)
  ) return false;
  publish({ ...state, error: null, loading: false, snapshot });
  return true;
};

const watch = async (requestGeneration: number, controller: AbortController): Promise<void> => {
  while (!controller.signal.aborted && requestGeneration === generation) {
    const current = state.snapshot;
    if (!current) return;
    const next = await extensionsApi().waitForHostState({
      hostId: current.catalog.hostId,
      revision: current.revision,
    }, controller.signal);
    if (!acceptSnapshot(next, requestGeneration)) return;
  }
};

export const startPiariumExtensionCatalog = (): Promise<void> => {
  if (startPromise) return startPromise;
  const requestGeneration = ++generation;
  watchController?.abort('Piarium extension catalog restarted');
  const controller = new AbortController();
  watchController = controller;
  publish({ ...state, error: null, loading: true });
  const operation = extensionsApi().hostState().then((snapshot) => {
    if (!acceptSnapshot(snapshot, requestGeneration)) return;
    void watch(requestGeneration, controller).catch((error) => {
      if (controller.signal.aborted || requestGeneration !== generation) return;
      publish({ ...state, error: error instanceof Error ? error.message : String(error), loading: false });
      startPromise = null;
    });
  }).catch((error) => {
    if (requestGeneration === generation) {
      publish({ ...state, error: error instanceof Error ? error.message : String(error), loading: false });
    }
    startPromise = null;
    throw error;
  });
  startPromise = operation;
  return operation;
};

export const refreshPiariumExtensionCatalog = async (): Promise<void> => {
  const requestGeneration = generation;
  try {
    const snapshot = await extensionsApi().hostState();
    acceptSnapshot(snapshot, requestGeneration);
  } catch (error) {
    if (requestGeneration === generation) {
      publish({ ...state, error: error instanceof Error ? error.message : String(error), loading: false });
    }
    throw error;
  }
};

const runMutation = (
  extensionId: string,
  mutate: (snapshot: PiariumExtensionCatalogSnapshot) => Promise<PiariumExtensionCatalogSnapshot>,
): Promise<void> => {
  const operation = mutationQueue.then(async () => {
    await startPiariumExtensionCatalog();
    const current = state.snapshot;
    if (!current) throw new Error('Piarium extension catalog is unavailable');
    const requestGeneration = generation;
    publish({ ...state, busyExtensionId: extensionId, error: null });
    try {
      const catalog = await mutate(current.catalog);
      if (requestGeneration !== generation || state.snapshot?.catalog.hostId !== catalog.hostId) return;
      if (!state.snapshot || catalog.revision >= state.snapshot.catalog.revision) {
        publish({
          ...state,
          snapshot: state.snapshot ? { ...state.snapshot, catalog } : state.snapshot,
        });
      }
      const refreshed = await extensionsApi().hostState();
      acceptSnapshot(refreshed, requestGeneration);
    } catch (error) {
      if (requestGeneration === generation) {
        const message = error instanceof Error ? error.message : String(error);
        await refreshPiariumExtensionCatalog().catch(() => undefined);
        if (requestGeneration === generation) publish({ ...state, error: message });
      }
      throw error;
    } finally {
      if (requestGeneration === generation && state.busyExtensionId === extensionId) {
        publish({ ...state, busyExtensionId: null });
      }
    }
  });
  mutationQueue = operation.catch(() => undefined);
  return operation;
};

export const setPiariumExtensionEnabled = (
  extensionId: string,
  enabled: boolean,
): Promise<void> => runMutation(extensionId, (catalog) => (
  extensionsApi().setEnabled(extensionId, enabled, catalog.revision)
));

export const installPiariumExtension = (
  source: PiariumExtensionPackageSource,
): Promise<void> => runMutation('__install__', (catalog) => (
  extensionsApi().install({ expectedRevision: catalog.revision, source })
));

export const selectPiariumExtensionCandidate = (
  extensionId: string,
  candidateIntegrity: string,
): Promise<void> => runMutation(extensionId, (catalog) => (
  surfaceExtensionLoader.applyCandidate(extensionId, candidateIntegrity, catalog.revision)
));

export const discardPiariumExtensionCandidate = (
  extensionId: string,
  candidateIntegrity: string,
): Promise<void> => runMutation(extensionId, (catalog) => (
  extensionsApi().discardCandidate({ candidateIntegrity, expectedRevision: catalog.revision, extensionId })
));

export const removePiariumExtension = (
  extensionId: string,
): Promise<void> => runMutation(extensionId, async (catalog) => {
  const entry = catalog.extensions.find((candidate) => candidate.manifest.id === extensionId);
  const disabled = entry?.desired.enabled
    ? await extensionsApi().setEnabled(extensionId, false, catalog.revision)
    : catalog;
  await refreshSurfaceExtensions();
  return extensionsApi().removeExtension({ expectedRevision: disabled.revision, extensionId });
});

export const reviewPiariumExtensionCandidateCapabilities = (
  request: Omit<PiariumExtensionCandidateCapabilityReviewRequest, 'expectedRevision'>,
): Promise<void> => runMutation(request.extensionId, (catalog) => (
  extensionsApi().reviewCandidateCapabilities({ ...request, expectedRevision: catalog.revision })
));

export const reviewPiariumExtensionCapabilities = (
  request: Omit<PiariumExtensionCapabilityReviewRequest, 'expectedRevision'>,
): Promise<void> => runMutation(request.extensionId, (catalog) => (
  extensionsApi().reviewCapabilities({ ...request, expectedRevision: catalog.revision })
));

export const setPiariumExtensionServiceRoute = (
  serviceId: string,
  version: number,
  scope: PiariumExtensionServiceRoutingContext,
  providerKey: string | null,
): Promise<void> => {
  const operation = mutationQueue.then(async () => {
    await startPiariumExtensionCatalog();
    const current = state.snapshot;
    if (!current) throw new Error('Piarium extension routing is unavailable');
    const requestGeneration = generation;
    const identity = serviceRoutingRuleKey({ scope, serviceId, version });
    const existing = current.routing.document.rules.find((rule) => serviceRoutingRuleKey(rule) === identity);
    if (providerKey === null) {
      if (!existing) return;
      await extensionsApi().removeServiceRoutingRule({
        expectedRevision: current.routing.document.revision,
        scope,
        serviceId,
        version,
      });
    } else {
      await extensionsApi().upsertServiceRoutingRule({
        expectedRevision: current.routing.document.revision,
        rule: { allowFallback: false, providerKey, scope, serviceId, version },
      });
    }
    if (requestGeneration === generation) await refreshPiariumExtensionCatalog();
  });
  mutationQueue = operation.catch(() => undefined);
  return operation;
};

export const usePiariumExtensionCatalog = (): PiariumExtensionCatalogStoreState => {
  React.useEffect(() => {
    void startPiariumExtensionCatalog().catch(() => undefined);
  }, []);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
};

export const subscribePiariumExtensionCatalog = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getPiariumExtensionCatalogState = (): PiariumExtensionCatalogStoreState => state;

export const resetPiariumExtensionCatalogForTests = (): void => {
  generation += 1;
  watchController?.abort('Piarium extension catalog reset');
  watchController = null;
  startPromise = null;
  mutationQueue = Promise.resolve();
  state = initialState();
  listeners.clear();
};
