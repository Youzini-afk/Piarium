/* eslint-disable react-refresh/only-export-components */
import React from 'react';
import type { SurfaceContribution, SurfaceRegistrySnapshot } from '@piarium/extension-surface';
import type { PackageDescriptor, RuntimeContextTarget } from '@piarium/protocol';
import type { IconName } from '@/components/icon/icons';
import { piPackageNameFromSource } from '@/lib/pi-runtime/packages';
import { piariumSurfaceRuntime } from './surface-runtime';

export interface PiPluginSettingsAdapterRenderProps {
  activeSessionId: string | null;
  currentDirectory: string;
  navigationSection?: string;
  packageVersion: string | null;
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
}

export interface PiPluginSettingsAdapterImplementation {
  render(props: PiPluginSettingsAdapterRenderProps): React.ReactNode;
}

export interface PiPluginSettingsAdapterRegistration {
  adapterId: string;
  contributionId: string;
  icon: IconName;
  implementation: PiPluginSettingsAdapterImplementation;
  packageNames: readonly string[];
}

export interface PiSettingsPanelImplementation {
  render(): React.ReactNode;
}

interface PiSettingsPanelRegistration {
  contributionId: string;
  implementation: PiSettingsPanelImplementation;
}

const stringData = (data: Record<string, unknown>, key: string): string | undefined => (
  typeof data[key] === 'string' ? data[key] : undefined
);

const pluginAdapterRegistration = (
  contribution: SurfaceContribution,
): PiPluginSettingsAdapterRegistration | null => {
  if (contribution.descriptor.kind !== 'panel') return null;
  if (contribution.descriptor.placement?.slot !== 'pi.plugin-settings.adapters') return null;
  const data = contribution.descriptor.data;
  if (stringData(data, 'contract') !== 'pi-plugin-settings-adapter/v1') return null;
  const adapterId = stringData(data, 'adapterId');
  const icon = stringData(data, 'icon');
  const packageNames = Array.isArray(data.packageNames)
    ? data.packageNames.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];
  const implementation = contribution.implementation as PiPluginSettingsAdapterImplementation;
  if (!adapterId || !icon || packageNames.length === 0 || typeof implementation?.render !== 'function') return null;
  return {
    adapterId,
    contributionId: contribution.descriptor.id,
    icon: icon as IconName,
    implementation,
    packageNames,
  };
};

export const pluginSettingsAdaptersFromSnapshot = (
  snapshot: SurfaceRegistrySnapshot,
): PiPluginSettingsAdapterRegistration[] => snapshot.visibleContributions
  .map(pluginAdapterRegistration)
  .filter((value): value is PiPluginSettingsAdapterRegistration => value !== null);

export const usePiPluginSettingsAdapters = (): PiPluginSettingsAdapterRegistration[] => {
  const snapshot = React.useSyncExternalStore(
    piariumSurfaceRuntime.subscribe,
    piariumSurfaceRuntime.getSnapshot,
    piariumSurfaceRuntime.getSnapshot,
  );
  return React.useMemo(() => pluginSettingsAdaptersFromSnapshot(snapshot), [snapshot]);
};

const normalizedPackageNames = (entry: PackageDescriptor): Set<string> => new Set([
  entry.name,
  piPackageNameFromSource(entry.source),
].map((value) => value.trim().replace(/^npm:/, '').replace(/@[^/@]+$/, '').toLowerCase()));

export const pluginSettingsAdapterForPackage = (
  entry: PackageDescriptor,
  adapters: readonly PiPluginSettingsAdapterRegistration[],
): PiPluginSettingsAdapterRegistration | null => {
  const names = normalizedPackageNames(entry);
  return adapters.find((adapter) => adapter.packageNames.some((packageName) => (
    names.has(packageName.trim().replace(/^npm:/, '').replace(/@[^/@]+$/, '').toLowerCase())
  ))) ?? null;
};

export const usePiSettingsPanelContributions = (
  slot: string,
): PiSettingsPanelRegistration[] => {
  const snapshot = React.useSyncExternalStore(
    piariumSurfaceRuntime.subscribe,
    piariumSurfaceRuntime.getSnapshot,
    piariumSurfaceRuntime.getSnapshot,
  );
  return React.useMemo(() => snapshot.visibleContributions.flatMap((contribution) => {
    if (contribution.descriptor.kind !== 'panel' || contribution.descriptor.placement?.slot !== slot) return [];
    const implementation = contribution.implementation as PiSettingsPanelImplementation;
    return typeof implementation?.render === 'function'
      ? [{ contributionId: contribution.descriptor.id, implementation }]
      : [];
  }), [slot, snapshot]);
};

export const PiSettingsContributionSlot: React.FC<{ slot: string }> = ({ slot }) => {
  const panels = usePiSettingsPanelContributions(slot);
  return <>{panels.map((panel) => (
    <React.Fragment key={panel.contributionId}>{panel.implementation.render()}</React.Fragment>
  ))}</>;
};
