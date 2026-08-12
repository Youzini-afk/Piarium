import { useSyncExternalStore } from 'react';
import type { PackageDescriptor, RuntimeContextTarget } from '@piarium/protocol';
import { listPiPackages, piPackageNameFromSource } from '@/lib/pi-runtime/packages';
import { getRuntimeKey } from '@/lib/runtime-switch';

export interface PluginSettingsCatalogState {
  error: string | null;
  loaded: boolean;
  loading: boolean;
  packages: readonly PackageDescriptor[];
  selectedIdentity: string | null;
  targetKey: string;
}

const EMPTY_STATE: PluginSettingsCatalogState = {
  error: null,
  loaded: false,
  loading: false,
  packages: [],
  selectedIdentity: null,
  targetKey: '',
};

let state = EMPTY_STATE;
let generation = 0;
let preferredPackage: { identity?: string; pluginId: string } | null = null;
const listeners = new Set<() => void>();

export const pluginSettingsPackageIdentity = (entry: PackageDescriptor): string => (
  `${entry.scope}:${entry.source}`
);

export const installedPluginSettingsPackages = (
  packages: readonly PackageDescriptor[],
): PackageDescriptor[] => packages
  .filter((entry) => entry.installed === true)
  .slice()
  .sort((left, right) => (
    left.name.localeCompare(right.name)
    || left.scope.localeCompare(right.scope)
    || left.source.localeCompare(right.source)
  ));

const packageMatchesPluginId = (entry: PackageDescriptor, pluginId: string): boolean => {
  const normalized = pluginId.trim().replace(/^npm:/, '').toLowerCase();
  return entry.name.toLowerCase() === normalized
    || piPackageNameFromSource(entry.source).toLowerCase() === normalized;
};

const publish = (next: PluginSettingsCatalogState): void => {
  state = next;
  for (const listener of listeners) listener();
};

const selectedIdentityFor = (
  packages: readonly PackageDescriptor[],
  currentIdentity: string | null,
): string | null => {
  if (preferredPackage) {
    const requested = preferredPackage;
    const preferred = packages.find((entry) => (
      (requested.identity === undefined
        || pluginSettingsPackageIdentity(entry) === requested.identity)
      && packageMatchesPluginId(entry, requested.pluginId)
    ));
    if (preferred) {
      preferredPackage = null;
      return pluginSettingsPackageIdentity(preferred);
    }
  }
  if (currentIdentity && packages.some((entry) => pluginSettingsPackageIdentity(entry) === currentIdentity)) {
    return currentIdentity;
  }
  return packages[0] ? pluginSettingsPackageIdentity(packages[0]) : null;
};

export function usePluginSettingsCatalogState(): PluginSettingsCatalogState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

export function beginPluginSettingsCatalogTarget(targetKey: string): void {
  if (state.targetKey === targetKey) return;
  generation += 1;
  publish({ ...EMPTY_STATE, targetKey });
}

export function selectPluginSettingsPackage(identity: string): void {
  if (state.selectedIdentity === identity) return;
  if (!state.packages.some((entry) => pluginSettingsPackageIdentity(entry) === identity)) return;
  publish({ ...state, selectedIdentity: identity });
}

export function preferPluginSettingsPackage(pluginId: string, identity?: string): void {
  preferredPackage = { pluginId, ...(identity === undefined ? {} : { identity }) };
  const selectedIdentity = selectedIdentityFor(state.packages, state.selectedIdentity);
  if (selectedIdentity !== state.selectedIdentity) publish({ ...state, selectedIdentity });
}

export async function refreshPluginSettingsCatalog(
  runtimeTarget: RuntimeContextTarget,
  targetKey: string,
): Promise<void> {
  beginPluginSettingsCatalogTarget(targetKey);
  if (state.loading) return;
  const requestGeneration = ++generation;
  const runtimeKey = getRuntimeKey();
  publish({ ...state, error: null, loading: true });
  try {
    const packages = installedPluginSettingsPackages(await listPiPackages(runtimeTarget));
    if (
      requestGeneration !== generation
      || state.targetKey !== targetKey
      || runtimeKey !== getRuntimeKey()
    ) return;
    publish({
      ...state,
      error: null,
      loaded: true,
      loading: false,
      packages,
      selectedIdentity: selectedIdentityFor(packages, state.selectedIdentity),
    });
  } catch (error) {
    if (
      requestGeneration !== generation
      || state.targetKey !== targetKey
      || runtimeKey !== getRuntimeKey()
    ) return;
    publish({
      ...state,
      error: error instanceof Error ? error.message : String(error),
      loading: false,
    });
  }
}

export function resetPluginSettingsCatalogForTests(): void {
  generation += 1;
  preferredPackage = null;
  state = EMPTY_STATE;
}
