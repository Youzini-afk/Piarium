import fs from 'fs';
import os from 'os';
import path from 'path';
import { readPiAuthFile as readAuthFile, readPiConfigLayers as readConfigLayers } from '../pi-config/storage.js';
import { getModelCatalog } from './catalog.js';
import type { ModelsMetadata } from '../platform/models-metadata.js';
import { resolveSmallModel, parseModelRef, isUsableAuthEntry, getAuthEntryForProvider } from './resolve.js';
import { callSmallModel, resolveProviderLogin } from './call.js';

const PIARIUM_SETTINGS_FILE = path.join(
  process.env.PIARIUM_DATA_DIR
    ? path.resolve(process.env.PIARIUM_DATA_DIR)
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Piarium')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Piarium')
        : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'piarium'),
  'settings.json',
);

// Piarium settings can explicitly override Pi's default small-model choice.
type AuthStore = Record<string, unknown>;
type ModelRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const readAuthStore = (): AuthStore => {
  const value = readAuthFile() as unknown;
  return isRecord(value) ? value : {};
};

const catalogModel = (catalog: ModelsMetadata, providerID: string, modelID: string): ModelRecord | null => {
  const provider = catalog[providerID];
  if (!isRecord(provider) || !isRecord(provider.models)) return null;
  const model = provider.models[modelID];
  return isRecord(model) ? model : null;
};

const readSmallModelSettingsOverride = (): string | null => {
  try {
    const raw = fs.readFileSync(PIARIUM_SETTINGS_FILE, 'utf8');
    const settings = JSON.parse(raw) as unknown;
    if (!isRecord(settings)) return null;
    if (settings.smallModelUseDefault !== false) return null;
    const override = typeof settings.smallModelOverride === 'string' ? settings.smallModelOverride.trim() : '';
    return override || null;
  } catch {
    return null;
  }
};

// Rough safety clamp so a huge input never blows the model's context window.
// Token estimate is ~4 chars/token; when the catalog has no limit for the
// model (Copilot/codex utility models are not listed) a conservative default
// applies.
const DEFAULT_CONTEXT_TOKENS = 64_000;
const OUTPUT_RESERVE_TOKENS = 4_000;

export interface ModelBudgetInput {
  catalog: ModelsMetadata;
  modelID: string;
  outputReserveTokens?: unknown;
  providerID: string;
}

export const getModelInputCharBudget = ({ catalog, providerID, modelID, outputReserveTokens }: ModelBudgetInput) => {
  const model = catalogModel(catalog, providerID, modelID);
  const limit = model && isRecord(model.limit) ? model.limit : null;
  const known = Number(limit?.context) > 0;
  const contextTokens = known ? Number(limit!.context) : DEFAULT_CONTEXT_TOKENS;
  const reserve = Number(outputReserveTokens) > 0 ? Number(outputReserveTokens) : OUTPUT_RESERVE_TOKENS;
  const inputBudgetTokens = Math.max(1_000, contextTokens - reserve);
  return { maxChars: inputBudgetTokens * 4, contextTokens, contextKnown: known };
};

const resolveOutputTokens = ({ catalog, providerID, modelID, maxOutputTokens }: ModelBudgetInput & {
  maxOutputTokens?: unknown;
}): number | undefined => {
  const requested = Number(maxOutputTokens) > 0 ? Number(maxOutputTokens) : 0;
  if (!requested) return undefined;
  const model = catalogModel(catalog, providerID, modelID);
  const limitRecord = model && isRecord(model.limit) ? model.limit : null;
  const limit = Number(limitRecord?.output);
  return limit > 0 ? Math.min(requested, limit) : requested;
};

export interface ClampPromptInput extends ModelBudgetInput {
  onOverflow: 'error' | 'truncate';
  prompt: string;
  system?: string | undefined;
}

const clampPromptToModelLimit = ({ prompt, system, catalog, providerID, modelID, onOverflow, outputReserveTokens }: ClampPromptInput) => {
  const { maxChars } = getModelInputCharBudget({ catalog, providerID, modelID, outputReserveTokens });
  const systemChars = system?.length ?? 0;
  const requiredChars = prompt.length + systemChars;
  if (requiredChars <= maxChars) {
    return { prompt, truncated: false };
  }
  const availablePromptChars = maxChars - systemChars;
  if (onOverflow === 'error' || availablePromptChars < 2) {
    throw Object.assign(
      new Error(`Input is too large for ${providerID}/${modelID}: ${requiredChars} characters exceeds the ${maxChars} the model's context allows`),
      { statusCode: 413, code: 'context-too-small', providerID, modelID, requiredChars, availableChars: maxChars },
    );
  }
  return { prompt: `${prompt.slice(0, availablePromptChars - 1)}…`, truncated: true };
};

export const __testing = { clampPromptToModelLimit };

const readConfiguredSmallModel = (workingDirectory: unknown): string | null => {
  try {
    const { mergedConfig } = readConfigLayers(workingDirectory);
    const value = typeof mergedConfig?.smallModel === 'string'
      ? mergedConfig.smallModel
      : mergedConfig?.small_model;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
};

/**
 * Generates text with the user's small model, resolved and authenticated
 * entirely server-side from Pi's configuration and auth store.
 */
export interface GenerateSmallModelTextInput {
  directory?: string | undefined;
  maxOutputTokens?: number | undefined;
  model?: string | undefined;
  onOverflow?: 'error' | 'truncate' | undefined;
  preferredModelID?: string | undefined;
  preferredProviderID?: string | undefined;
  prompt: string;
  responseSchema?: unknown;
  restrictToPreferredProvider?: boolean | undefined;
  signal?: AbortSignal | undefined;
  system?: string | undefined;
  timeoutMs?: number | undefined;
}

export async function generateSmallModelText({ prompt, system, maxOutputTokens, model, directory, preferredProviderID, preferredModelID, restrictToPreferredProvider = false, responseSchema, timeoutMs, signal, onOverflow = 'truncate' }: GenerateSmallModelTextInput) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw Object.assign(new Error('prompt is required'), { statusCode: 400 });
  }

  const auth = readAuthStore();
  const catalog: ModelsMetadata = await getModelCatalog().catch(() => ({}));

  const explicit = parseModelRef(model);
  const resolved = explicit
    ? { ...explicit, source: 'request' }
    : resolveSmallModel({
      auth,
      catalog,
      settingsSmallModel: readSmallModelSettingsOverride(),
      configSmallModel: readConfiguredSmallModel(directory),
      preferredProviderID,
      preferredModelID,
    });

  if (!resolved) {
    throw Object.assign(
      new Error('No small model available — no authenticated provider has a suitable model'),
      { statusCode: 404 },
    );
  }

  // Callers with a session context can forbid silently switching providers:
  // an explicit user choice (settings override, Pi config, request
  // model) is always allowed, anything else must stay on the session's
  // provider.
  if (restrictToPreferredProvider
    && !['settings', 'config', 'request'].includes(resolved.source)
    && resolved.providerID !== preferredProviderID) {
    throw Object.assign(
      new Error('No small model available within the session provider'),
      { statusCode: 404 },
    );
  }

  const outputTokens = resolveOutputTokens({
    catalog,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    maxOutputTokens,
  });

  const normalizedSystem = typeof system === 'string' && system.trim() ? system.trim() : undefined;

  const clamped = clampPromptToModelLimit({
    prompt: prompt.trim(),
    system: normalizedSystem,
    catalog,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    onOverflow,
    outputReserveTokens: outputTokens,
  });

  const text = await callSmallModel({
    auth,
    catalog,
    workingDirectory: directory,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    prompt: clamped.prompt,
    system: normalizedSystem,
    maxOutputTokens: outputTokens,
    responseSchema,
    timeoutMs,
    signal,
  });

  return {
    text: text.trim(),
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    source: resolved.source,
    ...(clamped.truncated ? { inputTruncated: true } : {}),
  };
}

/**
 * Provider ids with a usable Pi credential: the set the small model can
 * actually call. Used by the settings override picker to hide providers that
 * would only ever fail.
 */
export function listAuthenticatedProviders(): string[] {
  try {
    const auth = readAuthStore();
    const ids = new Set(
      Object.keys(auth || {}).filter((providerID) => isUsableAuthEntry(auth[providerID])),
    );
    // The catalog id is github-copilot while legacy auth entries may sit
    // under the copilot alias.
    if (isUsableAuthEntry(getAuthEntryForProvider(auth, 'github-copilot'))) {
      ids.add('github-copilot');
    }
    return Array.from(ids);
  } catch {
    return [];
  }
}

/**
 * Reports which model would be used, without calling it.
 */
const resolveReserveTokens = (
  outputReserveTokens: number | ((limits: { contextTokens: number; outputTokenLimit: number | null }) => number) | undefined,
  limits: { contextTokens: number; outputTokenLimit: number | null },
): number | undefined => (
  typeof outputReserveTokens === 'function' ? outputReserveTokens(limits) : outputReserveTokens
);

export async function describeSmallModel({ directory, preferredProviderID, preferredModelID, outputReserveTokens, overrideModel }: {
  directory?: string | undefined;
  outputReserveTokens?: number | ((limits: { contextTokens: number; outputTokenLimit: number | null }) => number) | undefined;
  overrideModel?: string | undefined;
  preferredModelID?: string | undefined;
  preferredProviderID?: string | undefined;
} = {}) {
  const auth = readAuthStore();
  const catalog: ModelsMetadata = await getModelCatalog().catch(() => ({}));
  const explicit = parseModelRef(overrideModel);
  const resolved = explicit
    ? { ...explicit, source: 'request' }
    : resolveSmallModel({
      auth,
      catalog,
      settingsSmallModel: readSmallModelSettingsOverride(),
      configSmallModel: readConfiguredSmallModel(directory),
      preferredProviderID,
      preferredModelID,
    });
  if (!resolved) return resolved;

  const entry = catalogModel(catalog, resolved.providerID, resolved.modelID);
  const limit = entry && isRecord(entry.limit) ? entry.limit : null;
  const outputTokenLimit = Number(limit?.output) > 0 ? Number(limit!.output) : null;
  const { contextTokens, contextKnown } = getModelInputCharBudget({
    catalog,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
  });
  const reserveTokens = resolveReserveTokens(outputReserveTokens, { contextTokens, outputTokenLimit });
  const { maxChars } = getModelInputCharBudget({
    catalog,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    outputReserveTokens: reserveTokens,
  });
  const hasLogin = Boolean(resolveProviderLogin({
    auth,
    workingDirectory: directory,
    providerID: resolved.providerID,
  }));

  return {
    ...resolved,
    hasLogin,
    inputCharBudget: maxChars,
    contextTokens,
    contextKnown,
    outputTokens: Number(reserveTokens) > 0 ? Number(reserveTokens) : null,
    structuredOutput: typeof entry?.structured_output === 'boolean'
      ? entry.structured_output
      : typeof entry?.structuredOutput === 'boolean'
        ? entry.structuredOutput
        : null,
    outputTokenLimit,
  };
}
