import { SurfaceExtensionLoader } from '@piarium/extension-loader';
import type { RuntimeContextTarget } from '@piarium/protocol';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { getPiSettings } from '@/lib/pi-runtime/settings';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { piariumSurfaceRuntime } from './surface-runtime';
import { startBuiltinPiariumExtensions } from './builtin-surface-manager';
import { surfaceCapabilityRegistry } from './surface-capabilities';

const runtimeExtensions = () => {
  const extensions = getRegisteredRuntimeAPIs()?.extensions;
  if (!extensions) throw new Error('Piarium application-host extension API is unavailable');
  return extensions;
};

let activeProjectTrusted = false;

export const setPiariumExtensionProjectTrust = (trusted: boolean): void => {
  if (activeProjectTrusted === trusted) return;
  activeProjectTrusted = trusted;
  void surfaceExtensionLoader.reconcile();
};

export const surfaceExtensionLoader = new SurfaceExtensionLoader({
  accessContext: () => ({
    access: piariumSurfaceRuntime.surface === 'desktop'
      || piariumSurfaceRuntime.surface === 'vscode'
      || (typeof window !== 'undefined' && typeof window.__PIARIUM_LOCAL_ORIGIN__ === 'string')
      ? 'local'
      : 'remote',
    projectTrusted: activeProjectTrusted,
  }),
  host: {
    activateExtension: (extensionId) => runtimeExtensions().activateExtension(extensionId),
    catalog: () => runtimeExtensions().catalog(),
    discardPreparedCandidate: (extensionId, candidateIntegrity) => runtimeExtensions().discardPreparedCandidate(extensionId, candidateIntegrity),
    hostState: () => runtimeExtensions().hostState(),
    invokeService: (request) => runtimeExtensions().invokeService(request),
    prepareCandidate: (extensionId, candidateIntegrity) => runtimeExtensions().prepareCandidate(extensionId, candidateIntegrity),
    requestCandidateApplication: (request) => runtimeExtensions().requestCandidateApplication(request),
    readAsset: (request) => runtimeExtensions().readAsset(request),
    readManagedEntrypoint: (request) => runtimeExtensions().readManagedEntrypoint(request),
    reportActualState: (extensionId, state) => runtimeExtensions().reportActualState(extensionId, state),
    selectCandidate: (request) => runtimeExtensions().selectCandidate(request),
    waitForHostState: (request, signal) => runtimeExtensions().waitForHostState(request, signal),
  },
  capabilities: surfaceCapabilityRegistry,
  surface: piariumSurfaceRuntime.surface,
  surfaceRuntime: piariumSurfaceRuntime,
});

let trustOwnerKey = '';
let trustGeneration = 0;

const trustTarget = (): RuntimeContextTarget | null => {
  const state = usePiSessionStore.getState();
  if (state.currentSessionId) return { sessionId: state.currentSessionId };
  if (state.catalogCwd) return { cwd: state.catalogCwd };
  return null;
};

const refreshProjectTrustOwner = (): void => {
  const target = trustTarget();
  const runtimeKey = getRuntimeKey();
  const nextOwnerKey = JSON.stringify([runtimeKey, target]);
  if (nextOwnerKey === trustOwnerKey) return;
  trustOwnerKey = nextOwnerKey;
  const generation = ++trustGeneration;
  setPiariumExtensionProjectTrust(false);
  if (!target) return;
  void surfaceExtensionLoader.triggerActivation('workspace-match').catch((error) => {
    console.error('[Piarium Extensions] Workspace Surface activation failed:', error);
  });
  void getPiSettings(target).then((settings) => {
    if (generation !== trustGeneration || nextOwnerKey !== trustOwnerKey || runtimeKey !== getRuntimeKey()) return;
    setPiariumExtensionProjectTrust(settings.projectTrusted);
  }).catch(() => {
    // A failed read is not evidence of either trusted or untrusted state. The new owner stays untrusted
    // until a complete authoritative catalog is observed.
  });
};

usePiSessionStore.subscribe((state, previous) => {
  if (state.currentSessionId !== previous.currentSessionId || state.catalogCwd !== previous.catalogCwd) {
    refreshProjectTrustOwner();
  }
});
subscribeRuntimeEndpointChanged(refreshProjectTrustOwner);
refreshProjectTrustOwner();

let initialReconcile: Promise<void> | null = null;

export const startSurfaceExtensions = (): Promise<void> => {
  initialReconcile ??= Promise.all([
    surfaceExtensionLoader.start(),
    startBuiltinPiariumExtensions(),
  ]).then(() => undefined).catch((error) => {
    initialReconcile = null;
    throw error;
  });
  return initialReconcile;
};

export const refreshSurfaceExtensions = (): Promise<void> => (
  surfaceExtensionLoader.reconcile()
);
