import { getCatalogProvider } from './catalog.js';
import type { ModelsMetadata } from '../platform/models-metadata.js';

// Piarium's small-model fallback chain:
// 1. `smallModel` from the merged Pi settings layers ("provider/model").
// 2. GitHub Copilot's hidden utility models when Copilot is logged in.
// 3. Family-priority scan of the authenticated providers' catalog models.
const FAMILY_PRIORITY = ['gemini-flash', 'gpt-nano', 'claude-haiku'];
const COPILOT_UTILITY_MODELS = ['gpt-5.4-nano', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'];
// The ChatGPT-plan codex backend only accepts a small allowlist of models
// (nano/API-key models are rejected with 400) — this is its cheapest one.
const OPENAI_OAUTH_SMALL_MODEL = 'gpt-5.4-mini';

const AUTH_PROVIDER_ALIASES = {
  'github-copilot': ['github-copilot', 'copilot'],
} as const;

type AuthEntry = Record<string, unknown>;
type AuthStore = Record<string, unknown>;
export interface ModelRef { modelID: string; providerID: string }
export interface SmallModelResolution extends ModelRef { source: string }

export function getAuthEntryForProvider(auth: AuthStore, providerID: string): AuthEntry | null {
  const aliases: readonly string[] = providerID === 'github-copilot'
    ? AUTH_PROVIDER_ALIASES['github-copilot']
    : [providerID];
  for (const alias of aliases) {
    const entry = auth?.[alias];
    if (entry && typeof entry === 'object') {
      return entry as AuthEntry;
    }
  }
  return null;
}

export function isUsableAuthEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const record = entry as AuthEntry;
  if (record.type === 'api_key') return typeof record.key === 'string' && record.key.length > 0;
  if (record.type === 'oauth') {
    return (typeof record.access === 'string' && record.access.length > 0)
      || (typeof record.refresh === 'string' && record.refresh.length > 0);
  }
  return false;
}

export function parseModelRef(value: unknown): ModelRef | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  };
}

const pickByFamily = (models: Record<string, unknown>, family: string): AuthEntry | null => {
  const matches = Object.values(models)
    .filter((model): model is AuthEntry => Boolean(model) && typeof model === 'object'
      && (model as AuthEntry).family === family);
  if (matches.length === 0) return null;
  matches.sort((a, b) => String(b.release_date || '').localeCompare(String(a.release_date || '')));
  return matches[0] ?? null;
};

// Small-model candidates within ONE provider, by family priority. Copilot and
// ChatGPT-plan OpenAI have fixed small models that never appear in the
// catalog; everyone else is scanned through the catalog families.
const pickWithinProvider = (
  providerID: string,
  auth: AuthStore,
  catalog: ModelsMetadata,
  family: string,
): SmallModelResolution | null => {
  const openaiAuth = auth.openai;
  if (providerID === 'openai' && openaiAuth && typeof openaiAuth === 'object'
    && (openaiAuth as AuthEntry).type === 'oauth') {
    return family === 'gpt-nano'
      ? { providerID, modelID: OPENAI_OAUTH_SMALL_MODEL, source: 'codex-small' }
      : null;
  }
  if (providerID === 'github-copilot') {
    return family === 'gpt-nano'
      ? { providerID, modelID: COPILOT_UTILITY_MODELS[0]!, source: 'copilot-utility' }
      : null;
  }
  const provider = getCatalogProvider(catalog, providerID);
  if (!provider || !provider.models || typeof provider.models !== 'object' || Array.isArray(provider.models)) return null;
  const model = pickByFamily(provider.models as Record<string, unknown>, family);
  return typeof model?.id === 'string' ? { providerID, modelID: model.id, source: 'family-scan' } : null;
};

export function resolveSmallModel({ auth, catalog, settingsSmallModel, configSmallModel, preferredProviderID, preferredModelID }: {
  auth: AuthStore;
  catalog: ModelsMetadata;
  configSmallModel?: unknown;
  preferredModelID?: unknown;
  preferredProviderID?: unknown;
  settingsSmallModel?: unknown;
}): SmallModelResolution | null {
  // Piarium's explicit Settings override outranks the native Pi config.
  const fromSettings = parseModelRef(settingsSmallModel);
  if (fromSettings) {
    return { ...fromSettings, source: 'settings' };
  }

  const explicit = parseModelRef(configSmallModel);
  if (explicit) {
    return { ...explicit, source: 'config' };
  }

  // With a session context, keep the utility call on the session provider.
  // Scan its model families first, then use the session model rather than
  // silently switching to a different subscription.
  const preferred = typeof preferredProviderID === 'string' && preferredProviderID
    ? preferredProviderID
    : null;
  if (preferred && isUsableAuthEntry(getAuthEntryForProvider(auth, preferred))) {
    for (const family of FAMILY_PRIORITY) {
      const match = pickWithinProvider(preferred, auth, catalog, family);
      if (match) return match;
    }
    if (typeof preferredModelID === 'string' && preferredModelID) {
      return { providerID: preferred, modelID: preferredModelID, source: 'session-model' };
    }
  }

  // No session context (or its provider has no usable login): scan all
  // authenticated providers by family priority.
  const authedProviders = Object.keys(auth || {}).filter((providerID) =>
    providerID !== preferred && isUsableAuthEntry(auth[providerID]));

  for (const family of FAMILY_PRIORITY) {
    for (const providerID of authedProviders) {
      const match = pickWithinProvider(providerID, auth, catalog, family);
      if (match) return match;
    }
  }

  // Copilot's utility fallback for legacy auth aliases the loop above missed.
  const copilotEntry = getAuthEntryForProvider(auth, 'github-copilot');
  if (isUsableAuthEntry(copilotEntry)) {
    return {
      providerID: 'github-copilot',
      modelID: COPILOT_UTILITY_MODELS[0]!,
      source: 'copilot-utility',
    };
  }

  return null;
}
