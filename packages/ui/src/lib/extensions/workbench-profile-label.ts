import {
  PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
  PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID,
  PIARIUM_WORKBENCH_DEFAULT_PROFILE_LABEL,
} from '@piarium/extension-contract';
import type { I18nKey } from '@/lib/i18n';

const officialDefaultProfileLabels = new Set([
  PIARIUM_WORKBENCH_DEFAULT_PROFILE_LABEL,
  'Default',
]);

export const workbenchProfileLabel = (
  profile: { id: string; label: string },
  t: (key: I18nKey) => string,
): string => (
  profile.id === PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID
    && officialDefaultProfileLabels.has(profile.label)
    ? t('settings.piarium.extensions.workbench.profile.agent')
    : profile.label
);

export const workbenchExtensionDisplayName = (
  entry: { manifest: { id: string; displayName?: string } },
  t: (key: I18nKey) => string,
): string => (
  entry.manifest.id === PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID
    ? t('settings.piarium.extensions.workbench.extension.agentWorkspace')
    : (entry.manifest.displayName ?? entry.manifest.id)
);
