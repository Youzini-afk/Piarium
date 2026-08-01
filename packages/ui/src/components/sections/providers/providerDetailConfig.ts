import {
  hasEditableProviderConfigSource,
} from './customProviderForm';
import type {
  CustomProviderConfigInput,
  CustomProviderEditableFormState,
} from './customProviderForm';

export interface ProviderSourceInfo {
  exists: boolean;
  path?: string | null;
}

export interface ProviderSources {
  auth: ProviderSourceInfo;
  user: ProviderSourceInfo;
  project: ProviderSourceInfo;
  custom?: ProviderSourceInfo;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const isEditableCustomProviderConfig = (config: unknown): config is CustomProviderConfigInput => {
  if (!isRecord(config)) return false;
  const baseURL = typeof config.baseURL === 'string' ? config.baseURL.trim() : '';
  return baseURL.length > 0 && (Array.isArray(config.models) || isRecord(config.models));
};

export const readProviderConfigPayload = (payload: unknown): CustomProviderConfigInput | undefined => {
  if (!isRecord(payload)) return undefined;
  if (isRecord(payload.config)) return payload.config as CustomProviderConfigInput;
  if (isRecord(payload.data) && isRecord(payload.data.config)) {
    return payload.data.config as CustomProviderConfigInput;
  }
  return undefined;
};

export const buildProviderSourcesFromConfig = (
  config: CustomProviderConfigInput,
  existing?: ProviderSources,
): ProviderSources => {
  const scope = config.scope === 'project' || config.scope === 'custom' ? config.scope : 'user';
  const path = isRecord(config) && typeof config.path === 'string' ? config.path : null;
  return {
    auth: existing?.auth ?? { exists: false },
    user: {
      exists: existing?.user?.exists || scope === 'user',
      path: existing?.user?.path ?? (scope === 'user' ? path : null),
    },
    project: {
      exists: existing?.project?.exists || scope === 'project',
      path: existing?.project?.path ?? (scope === 'project' ? path : null),
    },
    custom: {
      exists: existing?.custom?.exists || scope === 'custom',
      path: existing?.custom?.path ?? (scope === 'custom' ? path : null),
    },
  };
};

export const canEditProviderFromDetails = (
  editableConfig: CustomProviderEditableFormState | null | undefined,
  sources?: ProviderSources,
): boolean => (
  Boolean(editableConfig) || hasEditableProviderConfigSource(sources)
);
