import {
  registerBuiltinSettingsContributionSource,
} from '@/lib/settings/surface-registry';
import {
  BUILTIN_SETTINGS_EXTENSION_ID,
} from '@/lib/settings/builtin-page-metadata';

let registered = false;

export const registerBuiltinSettingsWorkbench = (): void => {
  if (registered) return;
  registerBuiltinSettingsContributionSource({
    activate: async (context) => {
      const { registerBuiltinSettingsContributions } = await import('./builtin-settings-contributions');
      registerBuiltinSettingsContributions(context);
    },
    extensionId: BUILTIN_SETTINGS_EXTENSION_ID,
    extensionVersion: '0.1.0',
  });
  registered = true;
};
