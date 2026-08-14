import { ManagedSurfaceExtensionLoader } from '@piarium/extension-loader';
import { piariumSurfaceRuntime } from './surface-runtime';

const runtimeExtensions = () => {
  const extensions = typeof window !== 'undefined' ? window.__PIARIUM_RUNTIME_APIS__?.extensions : undefined;
  if (!extensions) throw new Error('Piarium application-host extension API is unavailable');
  return extensions;
};

export const managedSurfaceExtensionLoader = new ManagedSurfaceExtensionLoader({
  host: {
    activateExtension: (extensionId) => runtimeExtensions().activateExtension(extensionId),
    catalog: () => runtimeExtensions().catalog(),
    discardPreparedCandidate: (extensionId, candidateIntegrity) => runtimeExtensions().discardPreparedCandidate(extensionId, candidateIntegrity),
    hostState: () => runtimeExtensions().hostState(),
    invokeService: (request) => runtimeExtensions().invokeService(request),
    prepareCandidate: (extensionId, candidateIntegrity) => runtimeExtensions().prepareCandidate(extensionId, candidateIntegrity),
    readAsset: (request) => runtimeExtensions().readAsset(request),
    readManagedEntrypoint: (request) => runtimeExtensions().readManagedEntrypoint(request),
    reportActualState: (extensionId, state) => runtimeExtensions().reportActualState(extensionId, state),
    selectCandidate: (request) => runtimeExtensions().selectCandidate(request),
    waitForHostState: (request, signal) => runtimeExtensions().waitForHostState(request, signal),
  },
  surface: piariumSurfaceRuntime.surface,
  surfaceRuntime: piariumSurfaceRuntime,
});

let initialReconcile: Promise<void> | null = null;

export const startManagedSurfaceExtensions = (): Promise<void> => {
  initialReconcile ??= managedSurfaceExtensionLoader.start().catch((error) => {
    initialReconcile = null;
    throw error;
  });
  return initialReconcile;
};

export const refreshManagedSurfaceExtensions = (): Promise<void> => (
  managedSurfaceExtensionLoader.reconcile()
);
