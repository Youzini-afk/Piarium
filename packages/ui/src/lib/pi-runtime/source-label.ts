import type { PiRuntimeInstallationSource } from '@piarium/protocol';
import type { I18nKey } from '@/lib/i18n/store';

export const piRuntimeSourceLabelKey = (source: PiRuntimeInstallationSource): I18nKey => {
  switch (source) {
    case 'system':
      return 'onboarding.localSetup.runtime.source.system';
    case 'standalone':
      return 'onboarding.localSetup.runtime.source.standalone';
    case 'custom':
      return 'onboarding.localSetup.runtime.source.custom';
    case 'development':
      return 'onboarding.localSetup.runtime.source.development';
    case 'bundled':
      return 'onboarding.localSetup.runtime.source.bundled';
    default:
      return 'onboarding.localSetup.runtime.source';
  }
};
