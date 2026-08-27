import { useSyncExternalStore } from 'react';
import {
  FOUNDATIONAL_PI_PACKAGE_MANIFEST,
  matchesFoundationalPackage,
  type PackageDescriptor,
  type RuntimeContextTarget,
} from '@piarium/protocol';
import { listPiPackages } from '@/lib/pi-runtime/packages';
import { subscribePiRuntimeCatalogChanged } from '@/lib/pi-runtime/catalog-events';
import { getRuntimeKey } from '@/lib/runtime-switch';

export interface McpSettingsAvailabilityState {
  error: string | null;
  installed: boolean | undefined;
  loading: boolean;
  targetKey: string;
}

const EMPTY_STATE: McpSettingsAvailabilityState = {
  error: null,
  installed: undefined,
  loading: false,
  targetKey: '',
};

let state = EMPTY_STATE;
let generation = 0;
let lastTarget: { key: string; target: RuntimeContextTarget } | null = null;
const listeners = new Set<() => void>();
const MCP_FOUNDATIONAL_PACKAGE = FOUNDATIONAL_PI_PACKAGE_MANIFEST.integrations.find((entry) => entry.id === 'mcp');

const publish = (next: McpSettingsAvailabilityState): void => {
  state = next;
  for (const listener of listeners) listener();
};

export const isPiMcpAdapterInstalled = (packages: readonly PackageDescriptor[]): boolean => (
  packages.some((candidate) => (
    candidate.installed
    && candidate.enabled
    && MCP_FOUNDATIONAL_PACKAGE !== undefined
    && matchesFoundationalPackage(MCP_FOUNDATIONAL_PACKAGE, candidate)
  ))
);

export function useMcpSettingsAvailabilityState(): McpSettingsAvailabilityState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

export function beginMcpSettingsAvailabilityTarget(targetKey: string): void {
  if (state.targetKey === targetKey) return;
  generation += 1;
  publish({ ...EMPTY_STATE, targetKey });
}

export async function refreshMcpSettingsAvailability(
  runtimeTarget: RuntimeContextTarget,
  targetKey: string,
): Promise<void> {
  beginMcpSettingsAvailabilityTarget(targetKey);
  lastTarget = { key: targetKey, target: runtimeTarget };
  if (state.loading) return;
  const requestGeneration = ++generation;
  const runtimeKey = getRuntimeKey();
  publish({ ...state, error: null, loading: true });
  try {
    const installed = isPiMcpAdapterInstalled(await listPiPackages(runtimeTarget));
    if (
      requestGeneration !== generation
      || state.targetKey !== targetKey
      || runtimeKey !== getRuntimeKey()
    ) return;
    publish({ error: null, installed, loading: false, targetKey });
  } catch (error) {
    if (
      requestGeneration !== generation
      || state.targetKey !== targetKey
      || runtimeKey !== getRuntimeKey()
    ) return;
    // A failed authoritative read is not an authoritative empty package list.
    publish({
      ...state,
      error: error instanceof Error ? error.message : String(error),
      loading: false,
    });
  }
}

subscribePiRuntimeCatalogChanged((reason) => {
  if (reason !== 'package' || !lastTarget) return;
  void refreshMcpSettingsAvailability(lastTarget.target, lastTarget.key);
});

export function resetMcpSettingsAvailabilityForTests(): void {
  generation += 1;
  lastTarget = null;
  state = EMPTY_STATE;
}
