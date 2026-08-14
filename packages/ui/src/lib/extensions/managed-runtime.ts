import { ManagedSurfaceExtensionLoader } from '@piarium/extension-loader';
import { piariumSurfaceRuntime } from './surface-runtime';

const runtimeExtensions = () => {
  const extensions = typeof window !== 'undefined' ? window.__PIARIUM_RUNTIME_APIS__?.extensions : undefined;
  if (!extensions) throw new Error('Piarium application-host extension API is unavailable');
  return extensions;
};

export const managedSurfaceExtensionLoader = new ManagedSurfaceExtensionLoader({
  host: {
    catalog: () => runtimeExtensions().catalog(),
    readAsset: (request) => runtimeExtensions().readAsset(request),
    readManagedEntrypoint: (request) => runtimeExtensions().readManagedEntrypoint(request),
    reportActualState: (extensionId, state) => runtimeExtensions().reportActualState(extensionId, state),
    selectCandidate: (request) => runtimeExtensions().selectCandidate(request),
  },
  surface: piariumSurfaceRuntime.surface,
  surfaceRuntime: piariumSurfaceRuntime,
});

let initialReconcile: Promise<void> | null = null;

export const startManagedSurfaceExtensions = (): Promise<void> => {
  initialReconcile ??= managedSurfaceExtensionLoader.reconcile().catch((error) => {
    initialReconcile = null;
    throw error;
  });
  return initialReconcile;
};

export const refreshManagedSurfaceExtensions = (): Promise<void> => (
  managedSurfaceExtensionLoader.reconcile()
);
