import {
  PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
  PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
  PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID,
  PIARIUM_WORKBENCH_DEFAULT_PROFILE_LABEL,
  PIARIUM_WORKBENCH_IDE_PROFILE_ID,
  PIARIUM_WORKBENCH_IDE_PROFILE_LABEL,
} from '@piarium/extension-contract';
import type { I18nKey } from '@/lib/i18n';

const officialDefaultProfileLabels = new Set([
  PIARIUM_WORKBENCH_DEFAULT_PROFILE_LABEL,
  'Default',
]);

const officialIdeProfileLabels = new Set([
  PIARIUM_WORKBENCH_IDE_PROFILE_LABEL,
]);

export const workbenchProfileLabel = (
  profile: { id: string; label: string },
  t: (key: I18nKey) => string,
): string => {
  if (profile.id === PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID && officialDefaultProfileLabels.has(profile.label)) {
    return t('settings.piarium.extensions.workbench.profile.agent');
  }
  if (profile.id === PIARIUM_WORKBENCH_IDE_PROFILE_ID && officialIdeProfileLabels.has(profile.label)) {
    return t('settings.piarium.extensions.workbench.profile.ide');
  }
  return profile.label;
};

export const workbenchExtensionDisplayName = (
  entry: { manifest: { id: string; displayName?: string } },
  t: (key: I18nKey) => string,
): string => {
  if (entry.manifest.id === PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID) {
    return t('settings.piarium.extensions.workbench.extension.agentWorkspace');
  }
  if (entry.manifest.id === PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION_ID) {
    return t('settings.piarium.extensions.workbench.extension.ideWorkbench');
  }
  return entry.manifest.displayName ?? entry.manifest.id;
};
