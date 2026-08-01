type ApiKeyInputLike = {
  value?: string | null;
} | null | undefined;

export interface CustomProviderModelRowInput {
  id: string;
  name?: string;
  context?: string | number;
  contextLimit?: string | number;
  context_limit?: string | number;
  contextWindow?: string | number;
  context_window?: string | number;
  contextLength?: string | number;
  context_length?: string | number;
  maxContext?: string | number;
  max_context?: string | number;
  maxContextLength?: string | number;
  max_context_length?: string | number;
  inputTokenLimit?: string | number;
  input_token_limit?: string | number;
  output?: string | number;
  outputLimit?: string | number;
  output_limit?: string | number;
  outputTokenLimit?: string | number;
  output_token_limit?: string | number;
  maxOutput?: string | number;
  max_output?: string | number;
  maxOutputTokens?: string | number;
  max_output_tokens?: string | number;
  attachment?: boolean;
  tool_call?: boolean;
  toolCall?: boolean;
  reasoning?: boolean;
  reasoningEffort?: string;
  limit?: {
    context?: string | number;
    contextLimit?: string | number;
    context_limit?: string | number;
    contextWindow?: string | number;
    context_window?: string | number;
    contextLength?: string | number;
    context_length?: string | number;
    maxContext?: string | number;
    max_context?: string | number;
    maxContextLength?: string | number;
    max_context_length?: string | number;
    inputTokenLimit?: string | number;
    input_token_limit?: string | number;
    output?: string | number;
    outputLimit?: string | number;
    output_limit?: string | number;
    outputTokenLimit?: string | number;
    output_token_limit?: string | number;
    maxOutput?: string | number;
    max_output?: string | number;
    maxOutputTokens?: string | number;
    max_output_tokens?: string | number;
  };
  options?: Record<string, unknown>;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  variants?: Record<string, Record<string, unknown>>;
}

export type CustomProviderApiTypeValue = 'openai-compatible' | 'openai-responses' | 'anthropic' | 'google';

export interface CustomProviderEditableFormState {
  type: CustomProviderApiTypeValue;
  id: string;
  name: string;
  baseURL: string;
  models: Array<{
    id: string;
    name: string;
    context: string;
    output: string;
    attachment: boolean;
    tool_call: boolean;
    reasoning: boolean;
    reasoningEffort: string;
    options?: Record<string, unknown>;
    variants?: Record<string, Record<string, unknown>>;
  }>;
  apiKey: string;
  scope: 'user' | 'project' | 'custom';
}

export interface CustomProviderConfigInput {
  id?: string;
  providerId?: string;
  providerID?: string;
  type?: string;
  name?: string;
  baseURL?: string;
  baseUrl?: string;
  scope?: string;
  models?: CustomProviderModelRowInput[];
}

interface ProviderConfigSourceInput {
  exists?: boolean;
}

export interface ProviderSourcesInput {
  auth?: ProviderConfigSourceInput;
  user?: ProviderConfigSourceInput;
  project?: ProviderConfigSourceInput;
  custom?: ProviderConfigSourceInput;
}

interface CustomProviderModelPayload {
  id: string;
  name?: string;
  attachment?: true;
  tool_call?: true;
  reasoning?: true;
  options?: Record<string, unknown>;
  modalities?: {
    input: string[];
    output: string[];
  };
  variants?: Record<string, Record<string, unknown>>;
  limit?: {
    context?: number;
    output?: number;
  };
}

const REASONING_EFFORT_LIST = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const REASONING_EFFORTS = new Set<string>(REASONING_EFFORT_LIST);
const DEFAULT_MODEL_OUTPUT_LIMIT = 8192;

const trimString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const normalizeReasoningEffort = (value: unknown): string => {
  const normalized = trimString(value).toLowerCase();
  return REASONING_EFFORTS.has(normalized) ? normalized : '';
};

const normalizeEditableApiType = (value: unknown): CustomProviderApiTypeValue => {
  const normalized = trimString(value);
  return normalized === 'openai-responses'
    || normalized === 'anthropic'
    || normalized === 'google'
    || normalized === 'openai-compatible'
    ? normalized
    : 'openai-compatible';
};

const normalizePositiveInteger = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  }

  const normalized = trimString(value).replace(/,/g, '');
  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
};

const normalizePositiveIntegerInputValue = (value: unknown): string => {
  const normalized = normalizePositiveInteger(value);
  return normalized ? String(normalized) : '';
};

const buildModelLimit = (context?: number, output?: number): CustomProviderModelPayload['limit'] => {
  if (!context && !output) {
    return undefined;
  }

  return {
    ...(context ? { context } : {}),
    output: output || DEFAULT_MODEL_OUTPUT_LIMIT,
  };
};

const firstPositiveInteger = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    const normalized = normalizePositiveInteger(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
};

const readContextLimit = (entry: CustomProviderModelRowInput): number | undefined => (
  firstPositiveInteger(
    entry.limit?.context,
    entry.limit?.contextLimit,
    entry.limit?.context_limit,
    entry.limit?.contextWindow,
    entry.limit?.context_window,
    entry.limit?.contextLength,
    entry.limit?.context_length,
    entry.limit?.maxContext,
    entry.limit?.max_context,
    entry.limit?.maxContextLength,
    entry.limit?.max_context_length,
    entry.limit?.inputTokenLimit,
    entry.limit?.input_token_limit,
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
  )
);

const readOutputLimit = (entry: CustomProviderModelRowInput): number | undefined => (
  firstPositiveInteger(
    entry.limit?.output,
    entry.limit?.outputLimit,
    entry.limit?.output_limit,
    entry.limit?.outputTokenLimit,
    entry.limit?.output_token_limit,
    entry.limit?.maxOutput,
    entry.limit?.max_output,
    entry.limit?.maxOutputTokens,
    entry.limit?.max_output_tokens,
    entry.output,
    entry.outputLimit,
    entry.output_limit,
    entry.outputTokenLimit,
    entry.output_token_limit,
    entry.maxOutput,
    entry.max_output,
    entry.maxOutputTokens,
    entry.max_output_tokens,
  )
);

const containsImageModality = (value: unknown): boolean => {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.some((item) => trimString(item).toLowerCase().includes('image'));
};

const buildModelModalities = (attachment: boolean): CustomProviderModelPayload['modalities'] | undefined => (
  attachment
    ? { input: ['text', 'image'], output: ['text'] }
    : undefined
);

const buildModelOptions = (
  optionsInput: unknown,
  reasoningEffortInput: unknown,
): Record<string, unknown> | undefined => {
  const options = isRecord(optionsInput) ? { ...optionsInput } : {};
  const reasoningEffort = normalizeReasoningEffort(
    reasoningEffortInput || options.reasoningEffort || options.reasoning_effort,
  );

  delete options.reasoning_effort;
  if (reasoningEffort) {
    options.reasoningEffort = reasoningEffort;
  } else {
    delete options.reasoningEffort;
  }

  return Object.keys(options).length > 0 ? options : undefined;
};

const buildPreservedEditableModelOptions = (optionsInput: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(optionsInput)) {
    return undefined;
  }

  const options = { ...optionsInput };
  delete options.reasoningEffort;
  delete options.reasoning_effort;
  return Object.keys(options).length > 0 ? options : undefined;
};

const normalizeModelVariants = (value: unknown): Record<string, Record<string, unknown>> | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const variants: Record<string, Record<string, unknown>> = {};
  for (const [key, variant] of Object.entries(value)) {
    const variantKey = trimString(key);
    if (!variantKey) {
      continue;
    }
    variants[variantKey] = isRecord(variant) ? { ...variant } : {};
  }

  return Object.keys(variants).length > 0 ? variants : undefined;
};

const hasReasoningVariantConfig = (variants: Record<string, Record<string, unknown>> | undefined): boolean => {
  if (!variants) {
    return false;
  }
  return Object.entries(variants).some(([key, variant]) => (
    REASONING_EFFORTS.has(trimString(key).toLowerCase())
    || normalizeReasoningEffort(variant.reasoningEffort || variant.reasoning_effort).length > 0
  ));
};

const buildModelVariants = (
  row: CustomProviderModelRowInput,
  options: Record<string, unknown> | undefined,
): Record<string, Record<string, unknown>> | undefined => {
  const variants = normalizeModelVariants(row.variants) || {};
  const reasoningEffort = normalizeReasoningEffort(row.reasoningEffort || options?.reasoningEffort || options?.reasoning_effort);
  const shouldExposeReasoningVariants = row.reasoning === true || reasoningEffort.length > 0 || hasReasoningVariantConfig(variants);

  if (!shouldExposeReasoningVariants) {
    return Object.keys(variants).length > 0 ? variants : undefined;
  }

  for (const effort of REASONING_EFFORT_LIST) {
    const existing = isRecord(variants[effort]) ? variants[effort] : {};
    variants[effort] = Object.prototype.hasOwnProperty.call(existing, 'reasoningEffort')
      || Object.prototype.hasOwnProperty.call(existing, 'reasoning_effort')
      ? existing
      : { ...existing, reasoningEffort: effort };
  }

  return variants;
};

const createEmptyEditableModelRow = () => ({
  id: '',
  name: '',
  context: '',
  output: '',
  attachment: false,
  tool_call: false,
  reasoning: false,
  reasoningEffort: '',
});

export const resolveCustomProviderApiKey = (
  controlledValue: string,
  inputElement?: ApiKeyInputLike
): string => {
  const stateValue = trimString(controlledValue);
  if (stateValue) {
    return stateValue;
  }

  return trimString(inputElement?.value);
};

export const normalizeCustomProviderModelRows = (
  rows: CustomProviderModelRowInput[]
): CustomProviderModelPayload[] => {
  const seen = new Set<string>();
  const models: CustomProviderModelPayload[] = [];

  for (const row of rows) {
    const id = trimString(row.id);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);

    const name = trimString(row.name);
    const context = readContextLimit(row);
    const output = readOutputLimit(row);
    const limit = buildModelLimit(context, output);
    const options = buildModelOptions(row.options, row.reasoningEffort);
    const attachment = row.attachment === true;
    const modalities = buildModelModalities(attachment);
    const variants = buildModelVariants(row, options);

    models.push({
      id,
      ...(name ? { name } : {}),
      ...(attachment ? { attachment: true } : {}),
      ...(row.tool_call === true || row.toolCall === true ? { tool_call: true } : {}),
      ...(row.reasoning === true ? { reasoning: true } : {}),
      ...(modalities ? { modalities } : {}),
      ...(options ? { options } : {}),
      ...(variants ? { variants } : {}),
      ...(limit ? { limit } : {}),
    });
  }

  return models;
};

const hasModelRowContent = (row: CustomProviderModelRowInput): boolean => (
  trimString(row.id).length > 0
  || trimString(row.name).length > 0
  || trimString(row.context).length > 0
  || trimString(row.output).length > 0
  || row.attachment === true
  || row.tool_call === true
  || row.toolCall === true
  || row.reasoning === true
  || normalizeReasoningEffort(row.reasoningEffort).length > 0
  || Boolean(row.options && Object.keys(row.options).length > 0)
  || Boolean(row.variants && Object.keys(row.variants).length > 0)
);

const mergeModelRow = (
  existing: CustomProviderEditableFormState['models'][number],
  imported: CustomProviderModelRowInput,
): CustomProviderEditableFormState['models'][number] => {
  const options = buildPreservedEditableModelOptions(imported.options) ?? existing.options;
  const variants = normalizeModelVariants(imported.variants) ?? existing.variants;
  return {
    id: trimString(imported.id) || existing.id,
    name: trimString(imported.name) || existing.name,
    context: normalizePositiveIntegerInputValue(readContextLimit(imported)) || existing.context,
    output: normalizePositiveIntegerInputValue(readOutputLimit(imported)) || existing.output,
    attachment: imported.attachment === true || containsImageModality(imported.modalities?.input) || existing.attachment,
    tool_call: imported.tool_call === true || imported.toolCall === true || existing.tool_call,
    reasoning: imported.reasoning === true || existing.reasoning,
    reasoningEffort: normalizeReasoningEffort(imported.reasoningEffort || imported.options?.reasoningEffort || imported.options?.reasoning_effort) || existing.reasoningEffort,
    ...(options ? { options } : {}),
    ...(variants ? { variants } : {}),
  };
};

export const mergeCustomProviderModelRows = (
  existingRows: CustomProviderEditableFormState['models'],
  importedRows: CustomProviderModelRowInput[],
): CustomProviderEditableFormState['models'] => {
  const rows = existingRows.filter(hasModelRowContent).map((row) => ({ ...row }));
  const rowIndexById = new Map<string, number>();

  rows.forEach((row, index) => {
    const id = trimString(row.id);
    if (id && !rowIndexById.has(id)) {
      rowIndexById.set(id, index);
    }
  });

  for (const imported of importedRows) {
    const id = trimString(imported.id);
    if (!id) {
      continue;
    }

    const existingIndex = rowIndexById.get(id);
    if (typeof existingIndex === 'number') {
      rows[existingIndex] = mergeModelRow(rows[existingIndex], imported);
      continue;
    }

    rowIndexById.set(id, rows.length);
    rows.push(mergeModelRow(createEmptyEditableModelRow(), imported));
  }

  return rows.length > 0 ? rows : [createEmptyEditableModelRow()];
};

export const createCustomProviderFormStateFromConfig = (
  config: CustomProviderConfigInput
): CustomProviderEditableFormState => {
  const models = Array.isArray(config.models)
    ? config.models
        .map((model) => {
          const options = buildPreservedEditableModelOptions(model.options);
          const variants = normalizeModelVariants(model.variants);
          return {
            id: trimString(model.id),
            name: trimString(model.name),
            context: normalizePositiveIntegerInputValue(readContextLimit(model)),
            output: normalizePositiveIntegerInputValue(readOutputLimit(model)),
            attachment: model.attachment === true || containsImageModality(model.modalities?.input),
            tool_call: model.tool_call === true || model.toolCall === true,
            reasoning: model.reasoning === true,
            reasoningEffort: normalizeReasoningEffort(model.reasoningEffort || model.options?.reasoningEffort || model.options?.reasoning_effort),
            ...(options ? { options } : {}),
            ...(variants ? { variants } : {}),
          };
        })
        .filter((model) => model.id.length > 0)
    : [];

  return {
    type: normalizeEditableApiType(config.type),
    id: trimString(config.providerId ?? config.providerID ?? config.id),
    name: trimString(config.name),
    baseURL: trimString(config.baseURL ?? config.baseUrl),
    models: models.length > 0 ? models : [createEmptyEditableModelRow()],
    apiKey: '',
    scope: config.scope === 'custom' ? 'custom' : config.scope === 'project' ? 'project' : 'user',
  };
};

export const hasEditableProviderConfigSource = (sources?: ProviderSourcesInput): boolean => (
  Boolean(sources?.user?.exists || sources?.project?.exists || sources?.custom?.exists)
);
