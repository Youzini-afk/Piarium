import type { ProviderConfigDetails } from '@piarium/protocol';
import { createCustomProviderFormStateFromConfig } from './customProviderForm';
import type { CustomProviderEditableFormState } from './customProviderForm';

export interface ProviderSourceInfo {
  exists: boolean;
  path?: string | null;
}

export interface ProviderSources {
  auth: ProviderSourceInfo;
  custom: ProviderSourceInfo;
  project: ProviderSourceInfo;
  user: ProviderSourceInfo;
}

export const buildProviderSourcesFromDetails = (
  details: ProviderConfigDetails,
): ProviderSources => ({
  auth: { exists: details.auth.configured },
  custom: {
    exists: details.locations.custom.exists,
    path: details.locations.custom.path ?? null,
  },
  project: {
    exists: details.locations.project.exists,
    path: details.locations.project.path ?? null,
  },
  user: {
    exists: details.locations.user.exists,
    path: details.locations.user.path ?? null,
  },
});

export const editableProviderFromDetails = (
  details: ProviderConfigDetails | undefined,
): CustomProviderEditableFormState | null => (
  details?.config
    ? createCustomProviderFormStateFromConfig({
        ...details.config,
        scope: details.effectiveScope,
      })
    : null
);

export const canEditProviderFromDetails = (
  details: ProviderConfigDetails | undefined,
): boolean => details?.config !== undefined;
