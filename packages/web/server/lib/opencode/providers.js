import {
  CONFIG_FILE,
  readConfigLayers,
  isPlainObject,
  getConfigForPath,
  writeConfig,
} from './shared.js';

const DEFAULT_OPENAI_COMPATIBLE_NPM = '@ai-sdk/openai-compatible';
const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const DEFAULT_CUSTOM_PROVIDER_TYPE = 'openai-compatible';
const DEFAULT_MODEL_OUTPUT_LIMIT = 8192;
const ANTHROPIC_API_VERSION = '2023-06-01';
const REASONING_EFFORT_LIST = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const REASONING_EFFORTS = new Set(REASONING_EFFORT_LIST);
const MODEL_MODALITIES = new Set(['text', 'audio', 'image', 'video', 'pdf']);

const CUSTOM_PROVIDER_TYPES = Object.freeze({
  'openai-compatible': {
    npm: DEFAULT_OPENAI_COMPATIBLE_NPM,
    defaultBaseURL: '',
  },
  'openai-responses': {
    npm: '@ai-sdk/openai',
    defaultBaseURL: 'https://api.openai.com/v1',
  },
  anthropic: {
    npm: '@ai-sdk/anthropic',
    defaultBaseURL: 'https://api.anthropic.com/v1',
  },
  google: {
    npm: '@ai-sdk/google',
    defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta',
  },
});

const CUSTOM_PROVIDER_TYPE_BY_NPM = Object.freeze(
  Object.fromEntries(Object.entries(CUSTOM_PROVIDER_TYPES).map(([type, config]) => [config.npm, type])),
);

function normalizeNonEmptyString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizePositiveInteger(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  }

  const normalized = normalizeNonEmptyString(value).replace(/,/g, '');
  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function buildModelLimit(context, output) {
  if (!context && !output) {
    return undefined;
  }

  return {
    ...(context ? { context } : {}),
    output: output || DEFAULT_MODEL_OUTPUT_LIMIT,
  };
}

function firstPositiveInteger(...values) {
  for (const value of values) {
    const normalized = normalizePositiveInteger(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function readContextLimit(entry) {
  if (!isPlainObject(entry)) {
    return undefined;
  }

  const limitInput = isPlainObject(entry.limit) ? entry.limit : {};
  return firstPositiveInteger(
    limitInput.context,
    limitInput.contextLimit,
    limitInput.context_limit,
    limitInput.contextWindow,
    limitInput.context_window,
    limitInput.contextLength,
    limitInput.context_length,
    limitInput.maxContext,
    limitInput.max_context,
    limitInput.maxContextLength,
    limitInput.max_context_length,
    limitInput.inputTokenLimit,
    limitInput.input_token_limit,
    entry.context,
    entry.contextLimit,
    entry.context_limit,
    entry.contextWindow,
    entry.context_window,
    entry.contextLength,
    entry.context_length,
    entry.maxContext,
    entry.max_context,
    entry.maxContextLength,
    entry.max_context_length,
    entry.inputTokenLimit,
    entry.input_token_limit,
  );
}

function readOutputLimit(entry) {
  if (!isPlainObject(entry)) {
    return undefined;
  }

  const limitInput = isPlainObject(entry.limit) ? entry.limit : {};
  return firstPositiveInteger(
    limitInput.output,
    limitInput.outputLimit,
    limitInput.output_limit,
    limitInput.outputTokenLimit,
    limitInput.output_token_limit,
    limitInput.maxOutput,
    limitInput.max_output,
    limitInput.maxOutputTokens,
    limitInput.max_output_tokens,
    entry.output,
    entry.outputLimit,
    entry.output_limit,
    entry.outputTokenLimit,
    entry.output_token_limit,
    entry.maxOutput,
    entry.max_output,
    entry.maxOutputTokens,
    entry.max_output_tokens,
  );
}

function readModelLimit(entry) {
  return buildModelLimit(readContextLimit(entry), readOutputLimit(entry));
}

function normalizeBooleanTrue(value) {
  return value === true;
}

function normalizeReasoningEffort(value) {
  const normalized = normalizeNonEmptyString(value).toLowerCase();
  return REASONING_EFFORTS.has(normalized) ? normalized : '';
}

function normalizeModelOptions(entry) {
  if (!isPlainObject(entry)) {
    return undefined;
  }

  const options = isPlainObject(entry.options) ? { ...entry.options } : {};
  const reasoningEffort = normalizeReasoningEffort(
    options.reasoningEffort ?? options.reasoning_effort ?? entry.reasoningEffort ?? entry.reasoning_effort,
  );

  delete options.reasoning_effort;
  if (reasoningEffort) {
    options.reasoningEffort = reasoningEffort;
  } else {
    delete options.reasoningEffort;
  }

  return Object.keys(options).length > 0 ? options : undefined;
}

function normalizeModalityList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const result = [];
  for (const item of value) {
    const normalized = normalizeNonEmptyString(item).toLowerCase();
    if (!MODEL_MODALITIES.has(normalized) || result.includes(normalized)) {
      continue;
    }
    result.push(normalized);
  }
  return result;
}

function ensureListValue(list, value, position = 'end') {
  if (list.includes(value)) {
    return list;
  }
  if (position === 'start') {
    return [value, ...list];
  }
  return [...list, value];
}

function normalizeModelModalities(entry, attachment) {
  if (!isPlainObject(entry)) {
    return undefined;
  }

  const modalities = isPlainObject(entry.modalities) ? entry.modalities : {};
  let input = normalizeModalityList(modalities.input);
  let output = normalizeModalityList(modalities.output);

  if (!attachment && input.length === 0 && output.length === 0) {
    return undefined;
  }

  input = input.length > 0 ? input : ['text'];
  output = output.length > 0 ? output : ['text'];
  input = ensureListValue(input, 'text', 'start');
  output = ensureListValue(output, 'text', 'start');

  if (attachment) {
    input = ensureListValue(input, 'image');
  }

  return { input, output };
}

function normalizeModelVariants(entry) {
  if (!isPlainObject(entry?.variants)) {
    return undefined;
  }

  const variants = {};
  for (const [variantKey, variantValue] of Object.entries(entry.variants)) {
    const normalizedKey = normalizeNonEmptyString(variantKey);
    if (!normalizedKey) {
      continue;
    }
    variants[normalizedKey] = isPlainObject(variantValue) ? { ...variantValue } : {};
  }

  return Object.keys(variants).length > 0 ? variants : undefined;
}

function hasReasoningVariantConfig(variants) {
  if (!isPlainObject(variants)) {
    return false;
  }

  return Object.entries(variants).some(([key, value]) => (
    REASONING_EFFORTS.has(normalizeNonEmptyString(key).toLowerCase())
    || normalizeReasoningEffort(isPlainObject(value) ? value.reasoningEffort ?? value.reasoning_effort : undefined)
  ));
}

function buildModelVariants(entry, options, reasoning) {
  const variants = normalizeModelVariants(entry) || {};
  const reasoningEffort = normalizeReasoningEffort(
    options?.reasoningEffort ?? options?.reasoning_effort ?? entry?.reasoningEffort ?? entry?.reasoning_effort,
  );
  const shouldExposeReasoningVariants = reasoning || Boolean(reasoningEffort) || hasReasoningVariantConfig(variants);

  if (!shouldExposeReasoningVariants) {
    return Object.keys(variants).length > 0 ? variants : undefined;
  }

  for (const effort of REASONING_EFFORT_LIST) {
    const existing = isPlainObject(variants[effort]) ? variants[effort] : {};
    variants[effort] = Object.prototype.hasOwnProperty.call(existing, 'reasoningEffort')
      || Object.prototype.hasOwnProperty.call(existing, 'reasoning_effort')
      ? existing
      : { ...existing, reasoningEffort: effort };
  }

  return variants;
}

function normalizeModelCapability(entry, key) {
  if (!isPlainObject(entry)) {
    return false;
  }

  if (key === 'tool_call') {
    return normalizeBooleanTrue(entry.tool_call) || normalizeBooleanTrue(entry.toolCall);
  }

  return normalizeBooleanTrue(entry[key]);
}

function normalizeProviderId(value) {
  const id = normalizeNonEmptyString(value);
  if (!id) {
    throw new Error('Provider ID is required');
  }
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new Error('Provider ID can only contain letters, numbers, dots, underscores, and hyphens');
  }
  return id;
}

function normalizeProviderType(input) {
  const type = normalizeNonEmptyString(
    input?.type ?? input?.apiType ?? input?.providerType ?? input?.format,
  ) || DEFAULT_CUSTOM_PROVIDER_TYPE;

  if (!Object.prototype.hasOwnProperty.call(CUSTOM_PROVIDER_TYPES, type)) {
    throw new Error(`Unsupported custom provider API type: ${type}`);
  }

  return type;
}

function normalizeModels(models) {
  if (!Array.isArray(models)) {
    throw new Error('At least one model is required');
  }

  const normalized = {};
  for (const entry of models) {
    const modelId = isPlainObject(entry)
      ? normalizeNonEmptyString(entry.id)
      : normalizeNonEmptyString(entry);

    if (!modelId) {
      continue;
    }

    const modelEntry = isPlainObject(entry) ? entry : {};
    const modelName = normalizeNonEmptyString(modelEntry.name);
    const limit = readModelLimit(modelEntry);
    const options = normalizeModelOptions(modelEntry);
    const attachment = normalizeModelCapability(modelEntry, 'attachment') || supportsImageInput(modelEntry);
    const reasoning = normalizeModelCapability(modelEntry, 'reasoning');
    const modalities = normalizeModelModalities(modelEntry, attachment);
    const variants = buildModelVariants(modelEntry, options, reasoning);

    normalized[modelId] = {
      ...(modelName ? { name: modelName } : {}),
      ...(limit ? { limit } : {}),
      ...(attachment ? { attachment: true } : {}),
      ...(normalizeModelCapability(modelEntry, 'tool_call') ? { tool_call: true } : {}),
      ...(reasoning ? { reasoning: true } : {}),
      ...(modalities ? { modalities } : {}),
      ...(options ? { options } : {}),
      ...(variants ? { variants } : {}),
    };
  }

  if (Object.keys(normalized).length === 0) {
    throw new Error('At least one model is required');
  }

  return normalized;
}

function buildProviderEntry(input) {
  if (!isPlainObject(input)) {
    throw new Error('Provider configuration is required');
  }

  const providerId = normalizeProviderId(input.id ?? input.providerId ?? input.providerID);
  const type = normalizeProviderType(input);
  const name = normalizeNonEmptyString(input.name) || providerId;
  const npm = normalizeNonEmptyString(input.npm) || CUSTOM_PROVIDER_TYPES[type].npm;
  const baseURL = normalizeNonEmptyString(input.baseURL ?? input.baseUrl);
  if (!baseURL) {
    throw new Error('Base URL is required');
  }

  return {
    providerId,
    entry: {
      npm,
      name,
      options: {
        baseURL,
      },
      models: normalizeModels(input.models),
    },
  };
}

function inferProviderType(entry) {
  const explicitType = normalizeNonEmptyString(entry?.type ?? entry?.apiType ?? entry?.providerType ?? entry?.format);
  if (explicitType && Object.prototype.hasOwnProperty.call(CUSTOM_PROVIDER_TYPES, explicitType)) {
    return explicitType;
  }

  const npm = normalizeNonEmptyString(entry?.npm);
  return CUSTOM_PROVIDER_TYPE_BY_NPM[npm] || DEFAULT_CUSTOM_PROVIDER_TYPE;
}

function getProviderConfigEntry(config, providerId) {
  if (!isPlainObject(config)) {
    return null;
  }

  const providerConfig = isPlainObject(config.provider) ? config.provider : {};
  if (Object.prototype.hasOwnProperty.call(providerConfig, providerId) && isPlainObject(providerConfig[providerId])) {
    return providerConfig[providerId];
  }

  const providersConfig = isPlainObject(config.providers) ? config.providers : {};
  if (Object.prototype.hasOwnProperty.call(providersConfig, providerId) && isPlainObject(providersConfig[providerId])) {
    return providersConfig[providerId];
  }

  return null;
}

function normalizeProviderConfigModels(models) {
  if (Array.isArray(models)) {
    return models
      .map((entry) => {
        if (!isPlainObject(entry)) {
          const id = normalizeNonEmptyString(entry);
          return id ? { id, name: '' } : null;
        }

        const id = normalizeNonEmptyString(entry.id);
        if (!id) {
          return null;
        }

        const options = normalizeModelOptions(entry);
        const editableOptions = options ? { ...options } : undefined;
        const reasoningEffort = normalizeReasoningEffort(editableOptions?.reasoningEffort ?? entry.reasoningEffort ?? entry.reasoning_effort);
        if (editableOptions) {
          delete editableOptions.reasoningEffort;
        }
        const attachment = normalizeBooleanTrue(entry.attachment) || supportsImageInput(entry);
        const variants = normalizeModelVariants(entry);

        return {
          id,
          name: normalizeNonEmptyString(entry.name),
          ...(attachment ? { attachment: true } : {}),
          ...(normalizeModelCapability(entry, 'tool_call') ? { tool_call: true } : {}),
          ...(normalizeModelCapability(entry, 'reasoning') ? { reasoning: true } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(variants ? { variants } : {}),
          ...(editableOptions && Object.keys(editableOptions).length > 0 ? { options: editableOptions } : {}),
          ...(() => {
            const context = readContextLimit(entry);
            const output = readOutputLimit(entry);
            return {
              ...(context ? { context } : {}),
              ...(output ? { output } : {}),
            };
          })(),
        };
      })
      .filter(Boolean);
  }

  if (!isPlainObject(models)) {
    return [];
  }

  return Object.entries(models)
    .map(([modelId, entry]) => {
      const id = normalizeNonEmptyString(modelId);
      if (!id) {
        return null;
      }

      const modelEntry = isPlainObject(entry) ? entry : {};
      const context = readContextLimit(modelEntry);
      const output = readOutputLimit(modelEntry);
      const options = normalizeModelOptions(modelEntry);
      const editableOptions = options ? { ...options } : undefined;
      const reasoningEffort = normalizeReasoningEffort(editableOptions?.reasoningEffort ?? modelEntry.reasoningEffort ?? modelEntry.reasoning_effort);
      if (editableOptions) {
        delete editableOptions.reasoningEffort;
      }
      const attachment = normalizeBooleanTrue(modelEntry.attachment) || supportsImageInput(modelEntry);
      const variants = normalizeModelVariants(modelEntry);

      return {
        id,
        name: normalizeNonEmptyString(modelEntry.name),
        ...(context ? { context } : {}),
        ...(output ? { output } : {}),
        ...(attachment ? { attachment: true } : {}),
        ...(normalizeModelCapability(modelEntry, 'tool_call') ? { tool_call: true } : {}),
        ...(normalizeModelCapability(modelEntry, 'reasoning') ? { reasoning: true } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(variants ? { variants } : {}),
        ...(editableOptions && Object.keys(editableOptions).length > 0 ? { options: editableOptions } : {}),
      };
    })
    .filter(Boolean);
}

function buildEditableProviderConfig(providerId, entry, scope, path) {
  const options = isPlainObject(entry.options) ? entry.options : {};
  const baseURL = normalizeNonEmptyString(options.baseURL ?? options.baseUrl ?? entry.baseURL ?? entry.baseUrl);

  return {
    providerId,
    type: inferProviderType(entry),
    name: normalizeNonEmptyString(entry.name),
    baseURL,
    scope,
    path: path || null,
    models: normalizeProviderConfigModels(entry.models),
  };
}

function normalizeFetchBaseURL(value, providerType) {
  const baseURL = normalizeNonEmptyString(value) || CUSTOM_PROVIDER_TYPES[providerType]?.defaultBaseURL || '';
  if (!baseURL) {
    throw new Error('Base URL is required');
  }

  let url;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error('Base URL must be a valid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Base URL must use http or https');
  }

  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

function appendURLPath(baseURL, path) {
  return `${baseURL}/${path.replace(/^\/+/, '')}`;
}

function buildModelListRequest(providerType, baseURL, apiKey) {
  if (providerType === 'google') {
    const url = new URL(appendURLPath(baseURL, 'models'));
    url.searchParams.set('key', apiKey);
    return {
      url: url.toString(),
      requestOptions: {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      },
    };
  }

  if (providerType === 'anthropic') {
    return {
      url: appendURLPath(baseURL, 'models'),
      requestOptions: {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'anthropic-version': ANTHROPIC_API_VERSION,
          'x-api-key': apiKey,
        },
      },
    };
  }

  return {
    url: appendURLPath(baseURL, 'models'),
    requestOptions: {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    },
  };
}

function getModelEntries(providerType, payload) {
  if (!isPlainObject(payload)) {
    return [];
  }
  if (providerType === 'google') {
    return Array.isArray(payload.models) ? payload.models : [];
  }
  return Array.isArray(payload.data) ? payload.data : [];
}

function containsImageModality(value) {
  if (Array.isArray(value)) {
    return value.some((entry) => containsImageModality(entry));
  }

  const normalized = normalizeNonEmptyString(value).toLowerCase();
  return normalized === 'image'
    || normalized === 'images'
    || normalized === 'vision'
    || normalized.includes('image');
}

function supportsImageInput(entry) {
  if (!isPlainObject(entry)) {
    return false;
  }

  if (
    normalizeBooleanTrue(entry.attachment)
    || normalizeBooleanTrue(entry.image)
    || normalizeBooleanTrue(entry.imageInput)
    || normalizeBooleanTrue(entry.vision)
    || normalizeBooleanTrue(entry.supportsImages)
    || normalizeBooleanTrue(entry.supports_images)
  ) {
    return true;
  }

  const modalities = isPlainObject(entry.modalities) ? entry.modalities : {};
  const capabilities = isPlainObject(entry.capabilities) ? entry.capabilities : {};
  const architecture = isPlainObject(entry.architecture) ? entry.architecture : {};

  return containsImageModality(modalities.input)
    || containsImageModality(entry.input_modalities)
    || containsImageModality(entry.inputModalities)
    || containsImageModality(entry.supported_input_modalities)
    || containsImageModality(entry.supportedInputModalities)
    || containsImageModality(capabilities.input)
    || containsImageModality(capabilities.modalities)
    || containsImageModality(architecture.input_modalities)
    || containsImageModality(architecture.inputModalities)
    || containsImageModality(architecture.modality);
}

function containsSupportedParameter(value, patterns) {
  if (Array.isArray(value)) {
    return value.some((entry) => containsSupportedParameter(entry, patterns));
  }

  const normalized = normalizeNonEmptyString(value).toLowerCase();
  return patterns.some((pattern) => normalized === pattern || normalized.includes(pattern));
}

function supportsToolCalling(entry) {
  if (!isPlainObject(entry)) {
    return false;
  }

  if (
    normalizeBooleanTrue(entry.tool_call)
    || normalizeBooleanTrue(entry.toolCall)
    || normalizeBooleanTrue(entry.tool_calls)
    || normalizeBooleanTrue(entry.tools)
    || normalizeBooleanTrue(entry.function_calling)
    || normalizeBooleanTrue(entry.functionCalling)
    || normalizeBooleanTrue(entry.supportsTools)
    || normalizeBooleanTrue(entry.supports_tools)
  ) {
    return true;
  }

  const capabilities = isPlainObject(entry.capabilities) ? entry.capabilities : {};
  return normalizeBooleanTrue(capabilities.tool_call)
    || normalizeBooleanTrue(capabilities.toolCall)
    || normalizeBooleanTrue(capabilities.toolcall)
    || normalizeBooleanTrue(capabilities.tools)
    || normalizeBooleanTrue(capabilities.function_calling)
    || normalizeBooleanTrue(capabilities.functionCalling)
    || containsSupportedParameter(entry.supported_parameters, ['tools', 'tool_choice', 'function_calling'])
    || containsSupportedParameter(entry.supportedParameters, ['tools', 'tool_choice', 'function_calling']);
}

function supportsReasoning(entry) {
  if (!isPlainObject(entry)) {
    return false;
  }

  if (
    normalizeBooleanTrue(entry.reasoning)
    || normalizeBooleanTrue(entry.supportsReasoning)
    || normalizeBooleanTrue(entry.supports_reasoning)
  ) {
    return true;
  }

  const capabilities = isPlainObject(entry.capabilities) ? entry.capabilities : {};
  return normalizeBooleanTrue(capabilities.reasoning)
    || normalizeBooleanTrue(capabilities.thinking)
    || containsSupportedParameter(entry.supported_parameters, ['reasoning', 'reasoning_effort', 'reasoningeffort'])
    || containsSupportedParameter(entry.supportedParameters, ['reasoning', 'reasoning_effort', 'reasoningeffort']);
}

function normalizeFetchedModel(providerType, entry) {
  if (!isPlainObject(entry)) {
    return null;
  }

  const rawId = providerType === 'google'
    ? normalizeNonEmptyString(entry.name).replace(/^models\//, '')
    : normalizeNonEmptyString(entry.id);

  if (!rawId) {
    return null;
  }

  const displayName = normalizeNonEmptyString(
    entry.displayName ?? entry.display_name ?? entry.title ?? '',
  );
  const limit = readModelLimit(entry);
  const options = normalizeModelOptions(entry);

  return {
    id: rawId,
    name: displayName || rawId,
    ...(limit ? { limit } : {}),
    ...(supportsImageInput(entry) ? { attachment: true } : {}),
    ...(supportsToolCalling(entry) ? { tool_call: true } : {}),
    ...(supportsReasoning(entry) ? { reasoning: true } : {}),
    ...(options ? { options } : {}),
  };
}

function normalizeFetchedModels(providerType, payload) {
  const seen = new Set();
  const models = [];

  for (const entry of getModelEntries(providerType, payload)) {
    const model = normalizeFetchedModel(providerType, entry);
    if (!model || seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    models.push(model);
  }

  if (models.length === 0) {
    throw new Error('No models returned by provider');
  }

  return models;
}

function getProviderErrorMessage(payload) {
  if (!isPlainObject(payload)) {
    return '';
  }

  if (typeof payload.error === 'string') {
    return payload.error;
  }

  if (isPlainObject(payload.error) && typeof payload.error.message === 'string') {
    return payload.error.message;
  }

  if (typeof payload.message === 'string') {
    return payload.message;
  }

  return '';
}

async function readJSONResponse(response) {
  if (!response || typeof response.json !== 'function') {
    return null;
  }

  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchProviderModels(input, fetchImpl = globalThis.fetch) {
  if (!isPlainObject(input)) {
    throw new Error('Provider model fetch configuration is required');
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch is not available');
  }

  const type = normalizeProviderType(input);
  const apiKey = normalizeNonEmptyString(input.apiKey ?? input.key ?? input.token);
  if (!apiKey) {
    throw new Error('API key is required to fetch models');
  }

  const baseURL = normalizeFetchBaseURL(input.baseURL ?? input.baseUrl, type);
  const request = buildModelListRequest(type, baseURL, apiKey);
  const response = await fetchImpl(request.url, request.requestOptions);
  const payload = await readJSONResponse(response);

  if (!response?.ok) {
    const providerMessage = getProviderErrorMessage(payload);
    const status = typeof response?.status === 'number' ? response.status : 'unknown';
    throw new Error(providerMessage || `Failed to fetch models (${status})`);
  }

  return {
    type,
    baseURL,
    models: normalizeFetchedModels(type, payload),
  };
}

function getProviderSources(providerId, workingDirectory) {
  const layers = readConfigLayers(workingDirectory);
  const { userConfig, projectConfig, customConfig, paths } = layers;

  const customProviders = isPlainObject(customConfig?.provider) ? customConfig.provider : {};
  const customProvidersAlias = isPlainObject(customConfig?.providers) ? customConfig.providers : {};
  const projectProviders = isPlainObject(projectConfig?.provider) ? projectConfig.provider : {};
  const projectProvidersAlias = isPlainObject(projectConfig?.providers) ? projectConfig.providers : {};
  const userProviders = isPlainObject(userConfig?.provider) ? userConfig.provider : {};
  const userProvidersAlias = isPlainObject(userConfig?.providers) ? userConfig.providers : {};

  const customExists =
    Object.prototype.hasOwnProperty.call(customProviders, providerId) ||
    Object.prototype.hasOwnProperty.call(customProvidersAlias, providerId);
  const projectExists =
    Object.prototype.hasOwnProperty.call(projectProviders, providerId) ||
    Object.prototype.hasOwnProperty.call(projectProvidersAlias, providerId);
  const userExists =
    Object.prototype.hasOwnProperty.call(userProviders, providerId) ||
    Object.prototype.hasOwnProperty.call(userProvidersAlias, providerId);

  return {
    sources: {
      auth: { exists: false },
      user: { exists: userExists, path: paths.userPath },
      project: { exists: projectExists, path: paths.projectPath || null },
      custom: { exists: customExists, path: paths.customPath }
    }
  };
}

function getProviderConfig(providerId, workingDirectory) {
  if (!providerId || typeof providerId !== 'string') {
    throw new Error('Provider ID is required');
  }

  const layers = readConfigLayers(workingDirectory);
  const candidates = [
    { scope: 'custom', path: layers.paths.customPath, config: layers.customConfig },
    { scope: 'project', path: layers.paths.projectPath, config: layers.projectConfig },
    { scope: 'user', path: layers.paths.userPath, config: layers.userConfig },
  ];

  for (const candidate of candidates) {
    if (!candidate.path && candidate.scope !== 'user') {
      continue;
    }

    const entry = getProviderConfigEntry(candidate.config, providerId);
    if (!entry) {
      continue;
    }

    return buildEditableProviderConfig(providerId, entry, candidate.scope, candidate.path);
  }

  return null;
}

function upsertProviderConfig(input, workingDirectory, scope = 'user') {
  const { providerId, entry } = buildProviderEntry(input);
  const layers = readConfigLayers(workingDirectory);
  let targetPath = layers.paths.userPath;
  let resolvedScope = 'user';

  if (scope === 'project') {
    if (!workingDirectory) {
      throw new Error('Working directory is required for project scope');
    }
    targetPath = layers.paths.projectPath || targetPath;
    resolvedScope = 'project';
  } else if (scope === 'custom') {
    if (!layers.paths.customPath) {
      throw new Error('Custom config path is not configured');
    }
    targetPath = layers.paths.customPath;
    resolvedScope = 'custom';
  } else if (scope !== 'user') {
    throw new Error('Invalid scope');
  }

  const targetConfig = getConfigForPath(layers, targetPath);
  const providerConfig = isPlainObject(targetConfig.provider) ? { ...targetConfig.provider } : {};
  providerConfig[providerId] = entry;
  targetConfig.provider = providerConfig;

  writeConfig(targetConfig, targetPath || CONFIG_FILE);
  console.log(`Saved provider ${providerId} to config: ${targetPath}`);

  return {
    providerId,
    scope: resolvedScope,
    path: targetPath || CONFIG_FILE,
  };
}

function removeProviderConfig(providerId, workingDirectory, scope = 'user') {
  if (!providerId || typeof providerId !== 'string') {
    throw new Error('Provider ID is required');
  }

  const layers = readConfigLayers(workingDirectory);
  let targetPath = layers.paths.userPath;

  if (scope === 'project') {
    if (!workingDirectory) {
      throw new Error('Working directory is required for project scope');
    }
    targetPath = layers.paths.projectPath || targetPath;
  } else if (scope === 'custom') {
    if (!layers.paths.customPath) {
      return false;
    }
    targetPath = layers.paths.customPath;
  }

  const targetConfig = getConfigForPath(layers, targetPath);
  const providerConfig = isPlainObject(targetConfig.provider) ? targetConfig.provider : {};
  const providersConfig = isPlainObject(targetConfig.providers) ? targetConfig.providers : {};
  const removedProvider = Object.prototype.hasOwnProperty.call(providerConfig, providerId);
  const removedProviders = Object.prototype.hasOwnProperty.call(providersConfig, providerId);

  if (!removedProvider && !removedProviders) {
    return false;
  }

  if (removedProvider) {
    delete providerConfig[providerId];
    if (Object.keys(providerConfig).length === 0) {
      delete targetConfig.provider;
    } else {
      targetConfig.provider = providerConfig;
    }
  }

  if (removedProviders) {
    delete providersConfig[providerId];
    if (Object.keys(providersConfig).length === 0) {
      delete targetConfig.providers;
    } else {
      targetConfig.providers = providersConfig;
    }
  }

  writeConfig(targetConfig, targetPath || CONFIG_FILE);
  console.log(`Removed provider ${providerId} from config: ${targetPath}`);
  return true;
}

export {
  getProviderSources,
  getProviderConfig,
  upsertProviderConfig,
  removeProviderConfig,
  fetchProviderModels,
};
