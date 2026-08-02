import fs from 'fs';
import os from 'os';
import path from 'path';
import { readPiAuthFile as readAuthFile, readPiConfigLayers as readConfigLayers } from '../pi-config/storage.js';
import { getModelCatalog } from './catalog.js';
import { resolveSmallModel, parseModelRef, isUsableAuthEntry, getAuthEntryForProvider } from './resolve.js';
import { callSmallModel } from './call.js';

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
const readSmallModelSettingsOverride = () => {
  try {
    const raw = fs.readFileSync(PIARIUM_SETTINGS_FILE, 'utf8');
    const settings = JSON.parse(raw);
    if (!settings || typeof settings !== 'object') return null;
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

const clampPromptToModelLimit = ({ prompt, catalog, providerID, modelID }) => {
  const limit = catalog?.[providerID]?.models?.[modelID]?.limit;
  const contextTokens = Number(limit?.context) > 0 ? Number(limit.context) : DEFAULT_CONTEXT_TOKENS;
  const inputBudgetTokens = Math.max(1_000, contextTokens - OUTPUT_RESERVE_TOKENS);
  const maxChars = inputBudgetTokens * 4;
  if (prompt.length <= maxChars) {
    return { prompt, truncated: false };
  }
  return { prompt: `${prompt.slice(0, maxChars)}…`, truncated: true };
};

const readConfiguredSmallModel = (workingDirectory) => {
  try {
    const { mergedConfig } = readConfigLayers(workingDirectory);
    const value = mergedConfig?.smallModel;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
};

/**
 * Generates text with the user's small model, resolved and authenticated
 * entirely server-side from Pi's configuration and auth store.
 */
export async function generateSmallModelText({ prompt, system, maxOutputTokens, model, directory, preferredProviderID, preferredModelID, restrictToPreferredProvider = false }) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw Object.assign(new Error('prompt is required'), { statusCode: 400 });
  }

  const auth = readAuthFile();
  const catalog = await getModelCatalog().catch(() => ({}));

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

  const clamped = clampPromptToModelLimit({
    prompt: prompt.trim(),
    catalog,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
  });

  const text = await callSmallModel({
    auth,
    catalog,
    workingDirectory: directory,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    prompt: clamped.prompt,
    system: typeof system === 'string' && system.trim() ? system.trim() : undefined,
    maxOutputTokens,
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
export function listAuthenticatedProviders() {
  try {
    const auth = readAuthFile();
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
export async function describeSmallModel({ directory, preferredProviderID, preferredModelID } = {}) {
  const auth = readAuthFile();
  const catalog = await getModelCatalog().catch(() => ({}));
  const resolved = resolveSmallModel({
    auth,
    catalog,
    settingsSmallModel: readSmallModelSettingsOverride(),
    configSmallModel: readConfiguredSmallModel(directory),
    preferredProviderID,
    preferredModelID,
  });
  return resolved;
}
