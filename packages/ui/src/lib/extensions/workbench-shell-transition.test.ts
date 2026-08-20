import { expect, mock, test } from 'bun:test';
import type {
  PiariumExtensionCatalogEntry,
  PiariumExtensionHostStateSnapshot,
} from '@piarium/extension-contract';
import {
  defaultPiariumWorkbenchProfileDocument,
  PIARIUM_WORKBENCH_REPLACEMENT_TARGETS,
} from '@piarium/extension-contract';
import type { SurfaceContribution, SurfaceOwnerIdentity, SurfaceRegistrySnapshot } from '@piarium/extension-surface';
import { startWorkbenchMountSession } from './workbench-mount';
import type { PiariumExtensionCatalogStoreState } from './catalog-store';

mock.module('@/hooks/useProviderLogo', () => ({
  preloadProviderLogos: () => undefined,
  useProviderLogo: () => ({ hasLogo: false, onError: () => undefined, src: null }),
}));

const {
  runSelectActiveWorkbenchProfile,
  WorkbenchShellTransitionAbortedError,
  WorkbenchShellUnavailableError,
} = await import('./workbench-shell-transition');
type WorkbenchShellTransitionDependencies = import('./workbench-shell-transition').WorkbenchShellTransitionDependencies;

const hostId = '72694a4f-093a-4f79-8763-3ca9f06b7078';
const shellContributionId = 'dev.example.shell.main';
const shellExtensionId = 'dev.example.shell';

const owner = (): SurfaceOwnerIdentity => ({
  desiredRevision: 1,
  entrypointId: 'main',
  extensionId: shellExtensionId,
  extensionVersion: '1.0.0',
  generation: 1,
  hostId,
  realmId: 'surface',
});

const shellEntry = (enabled: boolean, failed = false): PiariumExtensionCatalogEntry => ({
  actual: failed
    ? [{
      desiredRevision: 1,
      diagnostics: [],
      entrypointId: 'main',
      generation: 1,
      hostId,
      realmId: 'surface',
      realmKind: 'surface',
      status: 'failed',
      updatedAt: '2026-08-20T00:00:00.000Z',
    }]
    : [],
  capabilityGrants: [],
  desired: { enabled, revision: 1, updatedAt: '2026-08-20T00:00:00.000Z' },
  installedAt: '2026-08-20T00:00:00.000Z',
  manifest: {
    engines: { piarium: '*' },
    id: shellExtensionId,
    schemaVersion: 1,
    version: '1.0.0',
    contributions: [{
      contractVersion: 1,
      data: {},
      id: shellContributionId,
      kind: 'shell',
      replacement: { target: PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell },
      supports: ['web', 'desktop'],
    }],
  },
  resolvedVersion: '1.0.0',
  selectedVersion: '1.0.0',
  source: { display: 'Example shell', kind: 'local' },
  updatedAt: '2026-08-20T00:00:00.000Z',
});

const workbenchDocument = () => {
  const document = defaultPiariumWorkbenchProfileDocument();
  document.profiles.push({ id: 'studio', label: 'Studio' });
  document.revision = 4;
  document.layouts = [{
    profileId: 'studio',
    references: [],
    replacementSelections: { [PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell]: shellContributionId },
    scope: 'distribution',
    scopeId: 'studio',
    surface: 'web',
  }];
  return document;
};

const hostSnapshot = (entry: PiariumExtensionCatalogEntry): PiariumExtensionHostStateSnapshot => ({
  catalog: {
    authoritative: true,
    diagnostics: [],
    extensions: [entry],
    hostId,
    loadedAt: '2026-08-20T00:00:00.000Z',
    revision: 1,
    schemaVersion: 1,
    storageState: 'ready',
  },
  revision: 1,
  routing: {
    authoritative: true,
    diagnostics: [],
    document: { revision: 0, rules: [], schemaVersion: 1, updatedAt: '1970-01-01T00:00:00.000Z' },
    hostId,
    storageState: 'missing',
  },
  services: { hostId, providers: [], revision: 0, selections: {} },
  workbench: {
    authoritative: true,
    diagnostics: [],
    document: workbenchDocument(),
    hostId,
    storageState: 'ready',
  },
});

const emptySurface = (): SurfaceRegistrySnapshot => ({
  actual: [],
  contributions: [],
  layoutReferences: [],
  replacementSelections: {},
  revision: 1,
  serviceSelections: {},
  services: [],
  visibleContributions: [],
});

const contribution = (implementation: unknown): SurfaceContribution => ({
  descriptor: {
    contractVersion: 1,
    data: {},
    id: shellContributionId,
    kind: 'shell',
    replacement: { target: PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell },
    supports: ['web'],
  },
  implementation,
  owner: owner(),
});

const createDeps = (options: {
  entry: PiariumExtensionCatalogEntry;
  generation?: number;
  implementation?: unknown;
  activate?: () => Promise<void>;
}): {
  deps: WorkbenchShellTransitionDependencies;
  enabled: string[];
  persistedProfiles: string[];
  mounts: number;
  disposed: number;
} => {
  const snapshot = hostSnapshot(options.entry);
  const generation = options.generation ?? 1;
  let contributions: SurfaceContribution[] = [];
  const enabled: string[] = [];
  const persistedProfiles: string[] = [];
  let mounts = 0;
  let disposed = 0;
  const deps: WorkbenchShellTransitionDependencies = {
    createMountContainer: () => ({ remove() {} } as HTMLElement),
    getCatalogState: (): PiariumExtensionCatalogStoreState => ({
      busyExtensionId: null,
      error: null,
      loading: false,
      snapshot,
    }),
    getCatalogWatchGeneration: () => generation,
    getSurface: () => 'web',
    getSurfaceSnapshot: () => ({ ...emptySurface(), contributions }),
    refreshCatalog: async () => undefined,
    selectProfile: async (request) => {
      persistedProfiles.push(request.profileId);
    },
    setEnabled: async (extensionId, nextEnabled) => {
      enabled.push(extensionId);
      snapshot.catalog.extensions[0]!.desired.enabled = nextEnabled;
    },
    startMount: (mountOptions) => {
      mounts += 1;
      const session = startWorkbenchMountSession(mountOptions);
      const dispose = session.dispose;
      return {
        ...session,
        dispose: async (reason) => {
          disposed += 1;
          await dispose(reason);
        },
      };
    },
    triggerActivation: async () => {
      await options.activate?.();
      contributions = [contribution(options.implementation ?? { render: () => null })];
    },
    triggerVisible: async () => undefined,
    updateLayout: async () => undefined,
  };
  return {
    deps,
    enabled,
    persistedProfiles,
    get mounts() { return mounts; },
    get disposed() { return disposed; },
  };
};

test('does not persist a disabled shell profile and does not enable extensions', async () => {
  const harness = createDeps({ entry: shellEntry(false) });
  await expect(runSelectActiveWorkbenchProfile(harness.deps, 'studio')).rejects.toThrow(WorkbenchShellUnavailableError);
  expect(harness.persistedProfiles).toEqual([]);
  expect(harness.enabled).toEqual([]);
});

test('enable-and-switch turns the shell on and commits after a render-ready candidate', async () => {
  const harness = createDeps({ entry: shellEntry(false), implementation: { render: () => null } });
  await runSelectActiveWorkbenchProfile(harness.deps, 'studio', undefined, { enableShell: true });
  expect(harness.enabled).toEqual([shellExtensionId]);
  expect(harness.persistedProfiles).toEqual(['studio']);
});

test('select-without-enabling persists a disabled shell without changing enablement', async () => {
  const harness = createDeps({ entry: shellEntry(false) });
  await runSelectActiveWorkbenchProfile(harness.deps, 'studio', undefined, { persistUnavailable: true });
  expect(harness.enabled).toEqual([]);
  expect(harness.persistedProfiles).toEqual(['studio']);
});

test('sync, async, and isolated mounts commit only after they become ready', async () => {
  for (const implementation of [
    { mount: () => () => undefined },
    { mount: async () => () => undefined },
    { kind: 'isolated-iframe', mount: () => () => undefined },
  ]) {
    const harness = createDeps({ entry: shellEntry(true), implementation });
    await runSelectActiveWorkbenchProfile(harness.deps, 'studio');
    expect(harness.persistedProfiles).toEqual(['studio']);
    expect(harness.mounts).toBe(1);
    expect(harness.disposed).toBe(1);
  }
});

test('keeps the previous profile when candidate mount fails', async () => {
  const harness = createDeps({
    entry: shellEntry(true),
    implementation: { mount: () => { throw new Error('mount failed'); } },
  });
  await expect(runSelectActiveWorkbenchProfile(harness.deps, 'studio')).rejects.toThrow('mount failed');
  expect(harness.persistedProfiles).toEqual([]);
  expect(harness.disposed).toBe(1);
});

test('rejects a candidate after the catalog generation changes', async () => {
  let generation = 1;
  const harness = createDeps({
    entry: shellEntry(true),
    implementation: { render: () => null },
    activate: async () => {
      generation = 2;
    },
  });
  harness.deps.getCatalogWatchGeneration = () => generation;
  await expect(runSelectActiveWorkbenchProfile(harness.deps, 'studio')).rejects.toThrow(WorkbenchShellTransitionAbortedError);
  expect(harness.persistedProfiles).toEqual([]);
});

test('builtin profiles persist without staging a shell', async () => {
  const harness = createDeps({ entry: shellEntry(true) });
  await runSelectActiveWorkbenchProfile(harness.deps, 'default');
  expect(harness.persistedProfiles).toEqual(['default']);
  expect(harness.mounts).toBe(0);
});
