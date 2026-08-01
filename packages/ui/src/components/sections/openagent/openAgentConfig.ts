export type OpenAgentKind = 'agent' | 'category';

export type OpenAgentThinkingConfig = {
  type: 'enabled' | 'disabled';
  budgetTokens?: number;
};

export type FallbackModelObject = {
  model: string;
  variant?: string;
  reasoningEffort?: string;
  temperature?: number;
  top_p?: number;
  maxTokens?: number;
  thinking?: OpenAgentThinkingConfig;
};

export type FallbackModels = string | Array<string | FallbackModelObject>;

export type OpenAgentOverride = Record<string, unknown> & {
  model?: string;
  fallback_models?: FallbackModels;
  variant?: string;
  category?: string;
  temperature?: number;
  top_p?: number;
  maxTokens?: number;
  disable?: boolean;
  reasoningEffort?: string;
  textVerbosity?: string;
  thinking?: OpenAgentThinkingConfig;
};

export type OpenAgentOverrideRecord = Record<string, OpenAgentOverride>;

export interface OpenAgentDraft {
  agents: OpenAgentOverrideRecord;
  categories: OpenAgentOverrideRecord;
  disabled_hooks: string[];
  disabled_skills?: string[];
  disabled_commands?: string[];
  disabled_tools?: string[];
  disabled_mcps?: string[];
  disabled_providers?: string[];
  mcp_env_allowlist?: string[];
  default_mode?: string;
  hashline_edit?: boolean;
  model_fallback?: boolean;
  runtime_fallback?: unknown;
  background_task?: Record<string, unknown>;
  team_mode?: Record<string, unknown>;
  model_capabilities?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
  skills?: Record<string, unknown>;
  tmux?: Record<string, unknown>;
}

export interface OpenAgentConfigResponseLike {
  raw?: {
    agents?: OpenAgentOverrideRecord;
    categories?: OpenAgentOverrideRecord;
    disabled_hooks?: string[];
    disabled_skills?: string[];
    disabled_commands?: string[];
    disabled_tools?: string[];
    disabled_mcps?: string[];
    disabled_providers?: string[];
    mcp_env_allowlist?: string[];
    default_mode?: string;
    hashline_edit?: boolean;
    model_fallback?: boolean;
    runtime_fallback?: unknown;
    background_task?: Record<string, unknown>;
    team_mode?: Record<string, unknown>;
    model_capabilities?: Record<string, unknown>;
    experimental?: Record<string, unknown>;
    skills?: Record<string, unknown>;
    tmux?: Record<string, unknown>;
  };
  project?: {
    overriddenAgents?: string[];
    overriddenCategories?: string[];
  };
}

export interface OpenAgentFallbackRow {
  id: string;
  model: string;
  variant: string;
  maxTokens: string;
  reasoningEffort: string;
  temperature?: string;
  top_p?: string;
  thinkingType?: string;
  thinkingBudgetTokens?: string;
  originalType: 'string' | 'object';
}

export interface OpenAgentSavePayload {
  expectedMtimeMs: number | null;
  agents: OpenAgentOverrideRecord;
  categories: OpenAgentOverrideRecord;
  disabled_hooks: string[];
  disabled_skills?: string[];
  disabled_commands?: string[];
  disabled_tools?: string[];
  disabled_mcps?: string[];
  disabled_providers?: string[];
  mcp_env_allowlist?: string[];
  default_mode?: string;
  hashline_edit?: boolean;
  model_fallback?: boolean;
  runtime_fallback?: unknown;
  background_task?: Record<string, unknown>;
  team_mode?: Record<string, unknown>;
  model_capabilities?: Record<string, unknown>;
  experimental?: Record<string, unknown>;
  skills?: Record<string, unknown>;
  tmux?: Record<string, unknown>;
}

export interface OpenAgentDefinition {
  id: string;
  label: string;
  description: string;
  group: 'main' | 'sub' | 'category' | 'custom';
  defaultModel?: string;
  defaultVariant?: string;
}

const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const TEXT_VERBOSITIES = new Set(['low', 'medium', 'high']);
const MODES = new Set(['subagent', 'primary', 'all']);

export const OPEN_AGENT_AGENT_DEFINITIONS: OpenAgentDefinition[] = [
  { id: 'sisyphus', label: 'Sisyphus - Ultraworker', description: '主编排者', group: 'main' },
  { id: 'hephaestus', label: 'Hephaestus - Deep Agent', description: '自主深度工作者', group: 'main' },
  { id: 'prometheus', label: 'Prometheus - Plan Builder', description: '战略规划者', group: 'main' },
  { id: 'atlas', label: 'Atlas - Plan Executor', description: '任务管理者', group: 'main' },
  { id: 'oracle', label: 'Oracle', description: '战略顾问', group: 'sub' },
  { id: 'librarian', label: 'Librarian', description: '多仓库研究员', group: 'sub' },
  { id: 'explore', label: 'Explore', description: '快速代码搜索', group: 'sub' },
  { id: 'multimodal-looker', label: 'Multimodal-Looker', description: '媒体分析器', group: 'sub' },
  { id: 'metis', label: 'Metis - Plan Consultant', description: '规划前分析顾问', group: 'sub' },
  { id: 'momus', label: 'Momus - Plan Critic', description: '计划审查者', group: 'sub' },
  { id: 'sisyphus-junior', label: 'Sisyphus-Junior', description: '委托任务执行器', group: 'sub' },
];

export const OPEN_AGENT_CATEGORY_DEFINITIONS: OpenAgentDefinition[] = [
  { id: 'visual-engineering', label: 'Visual Engineering', description: '视觉/前端工程', group: 'category', defaultModel: 'google/gemini-3.1-pro', defaultVariant: 'high' },
  { id: 'ultrabrain', label: 'Ultrabrain', description: '超级思考', group: 'category', defaultModel: 'openai/gpt-5.5', defaultVariant: 'xhigh' },
  { id: 'deep', label: 'Deep', description: '深度工作', group: 'category', defaultModel: 'openai/gpt-5.5', defaultVariant: 'medium' },
  { id: 'artistry', label: 'Artistry', description: '创意/文艺', group: 'category', defaultModel: 'google/gemini-3.1-pro', defaultVariant: 'high' },
  { id: 'quick', label: 'Quick', description: '快速响应', group: 'category', defaultModel: 'openai/gpt-5.4-mini' },
  { id: 'unspecified-low', label: 'Unspecified Low', description: '通用低配', group: 'category', defaultModel: 'anthropic/claude-sonnet-4-6' },
  { id: 'unspecified-high', label: 'Unspecified High', description: '通用高配', group: 'category', defaultModel: 'anthropic/claude-opus-4-7', defaultVariant: 'max' },
  { id: 'writing', label: 'Writing', description: '写作', group: 'category', defaultModel: 'kimi-for-coding/k2p5' },
];

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? {}));
export const OPEN_AGENT_TOP_LEVEL_ARRAY_KEYS = [
  'disabled_skills',
  'disabled_commands',
  'disabled_tools',
  'disabled_mcps',
  'disabled_providers',
  'mcp_env_allowlist',
] as const;

export const OPEN_AGENT_TOP_LEVEL_OBJECT_KEYS = [
  'background_task',
  'team_mode',
  'model_capabilities',
  'experimental',
  'skills',
  'tmux',
] as const;

export const OPEN_AGENT_TOP_LEVEL_SCALAR_KEYS = [
  'default_mode',
  'hashline_edit',
  'model_fallback',
  'runtime_fallback',
] as const;

export type OpenAgentTopLevelArrayKey = typeof OPEN_AGENT_TOP_LEVEL_ARRAY_KEYS[number];
export type OpenAgentTopLevelObjectKey = typeof OPEN_AGENT_TOP_LEVEL_OBJECT_KEYS[number];
export type OpenAgentTopLevelScalarKey = typeof OPEN_AGENT_TOP_LEVEL_SCALAR_KEYS[number];

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const normalizeString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

export const normalizeDisabledHooks = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(normalizeString).filter(Boolean))).sort();
};

export const normalizeStringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const entries = Array.from(new Set(value.map(normalizeString).filter(Boolean))).sort();
  return entries.length > 0 ? entries : undefined;
};

const normalizePlainObject = (value: unknown): Record<string, unknown> | undefined => {
  if (!isPlainObject(value)) return undefined;
  return Object.keys(value).length > 0 ? cloneJson(value) : undefined;
};

const normalizeRuntimeFallback = (value: unknown): unknown => {
  if (typeof value === 'boolean') return value;
  return normalizePlainObject(value);
};

const addOpenAgentGlobalFields = (target: Partial<OpenAgentDraft>, source: Record<string, unknown>) => {
  for (const key of OPEN_AGENT_TOP_LEVEL_ARRAY_KEYS) {
    const value = normalizeStringList(source[key]);
    if (value) target[key] = value;
  }

  for (const key of OPEN_AGENT_TOP_LEVEL_OBJECT_KEYS) {
    const value = normalizePlainObject(source[key]);
    if (value) target[key] = value;
  }

  const defaultMode = normalizeString(source.default_mode);
  if (defaultMode) target.default_mode = defaultMode;
  if (typeof source.hashline_edit === 'boolean') target.hashline_edit = source.hashline_edit;
  if (typeof source.model_fallback === 'boolean') target.model_fallback = source.model_fallback;
  const runtimeFallback = normalizeRuntimeFallback(source.runtime_fallback);
  if (runtimeFallback !== undefined) target.runtime_fallback = runtimeFallback;
};

const normalizeFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  const normalized = normalizeString(value);
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const normalizePositiveInteger = (value: unknown): number | undefined => {
  const parsed = normalizeFiniteNumber(value);
  if (parsed === undefined || parsed <= 0) return undefined;
  return Math.floor(parsed);
};

const normalizeNumberInRange = (value: unknown, min: number, max: number): number | undefined => {
  const parsed = normalizeFiniteNumber(value);
  if (parsed === undefined || parsed < min || parsed > max) return undefined;
  return parsed;
};

const assignString = (target: OpenAgentOverride, input: Record<string, unknown>, key: string) => {
  if (!Object.prototype.hasOwnProperty.call(input, key)) return;
  const value = normalizeString(input[key]);
  if (value) target[key] = value;
};

const assignNumber = (target: OpenAgentOverride, input: Record<string, unknown>, key: string, min: number, max: number) => {
  if (!Object.prototype.hasOwnProperty.call(input, key)) return;
  const value = normalizeNumberInRange(input[key], min, max);
  if (value !== undefined) target[key] = value;
};

const assignPositiveInteger = (target: OpenAgentOverride, input: Record<string, unknown>, key: string) => {
  if (!Object.prototype.hasOwnProperty.call(input, key)) return;
  const value = normalizePositiveInteger(input[key]);
  if (value !== undefined) target[key] = value;
};

const normalizeStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const entries = value.map(normalizeString).filter(Boolean);
  return entries.length > 0 ? entries : undefined;
};

const normalizeBooleanRecord = (value: unknown): Record<string, boolean> | undefined => {
  if (!isPlainObject(value)) return undefined;
  const entries = Object.entries(value)
    .filter(([key, enabled]) => normalizeString(key) && typeof enabled === 'boolean')
    .map(([key, enabled]) => [normalizeString(key), enabled as boolean]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const normalizeThinking = (value: unknown): OpenAgentOverride['thinking'] | undefined => {
  if (!isPlainObject(value)) return undefined;
  const type = normalizeString(value.type);
  if (type !== 'enabled' && type !== 'disabled') return undefined;
  const budgetTokens = normalizePositiveInteger(value.budgetTokens);
  return {
    type,
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
  };
};

const normalizeFallbackObject = (value: unknown): FallbackModelObject | null => {
  if (!isPlainObject(value)) return null;
  const model = normalizeString(value.model);
  if (!model) return null;
  const normalized: FallbackModelObject = { model };
  const variant = normalizeString(value.variant);
  if (variant) normalized.variant = variant;
  const reasoningEffort = normalizeString(value.reasoningEffort);
  if (REASONING_EFFORTS.has(reasoningEffort)) normalized.reasoningEffort = reasoningEffort;
  const maxTokens = normalizePositiveInteger(value.maxTokens);
  if (maxTokens !== undefined) normalized.maxTokens = maxTokens;
  const temperature = normalizeNumberInRange(value.temperature, 0, 2);
  if (temperature !== undefined) normalized.temperature = temperature;
  const topP = normalizeNumberInRange(value.top_p, 0, 1);
  if (topP !== undefined) normalized.top_p = topP;
  const thinking = normalizeThinking(value.thinking);
  if (thinking) normalized.thinking = thinking;
  return normalized;
};

const normalizeFallbackModels = (value: unknown): FallbackModels | undefined => {
  if (typeof value === 'string') {
    const model = normalizeString(value);
    return model || undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .map((entry) => (typeof entry === 'string' ? normalizeString(entry) || null : normalizeFallbackObject(entry)))
    .filter(Boolean) as Array<string | FallbackModelObject>;
  return entries.length > 0 ? entries : undefined;
};

export function normalizeOpenAgentOverride(kind: OpenAgentKind, input: unknown): OpenAgentOverride {
  if (!isPlainObject(input)) return {};
  const result: OpenAgentOverride = {};

  assignString(result, input, 'model');
  assignString(result, input, 'variant');
  assignNumber(result, input, 'temperature', 0, 2);
  assignNumber(result, input, 'top_p', 0, 1);
  assignPositiveInteger(result, input, 'maxTokens');
  assignString(result, input, 'prompt_append');

  const fallbackModels = normalizeFallbackModels(input.fallback_models);
  if (fallbackModels !== undefined) result.fallback_models = fallbackModels;

  const tools = normalizeBooleanRecord(input.tools);
  if (tools) result.tools = tools;

  const thinking = normalizeThinking(input.thinking);
  if (thinking) result.thinking = thinking;

  const reasoningEffort = normalizeString(input.reasoningEffort);
  if (REASONING_EFFORTS.has(reasoningEffort)) result.reasoningEffort = reasoningEffort;

  const textVerbosity = normalizeString(input.textVerbosity);
  if (TEXT_VERBOSITIES.has(textVerbosity)) result.textVerbosity = textVerbosity;

  if (typeof input.disable === 'boolean') result.disable = input.disable;

  if (kind === 'agent') {
    assignString(result, input, 'category');
    assignString(result, input, 'prompt');
    assignString(result, input, 'description');
    const skills = normalizeStringArray(input.skills);
    if (skills) result.skills = skills;
    const mode = normalizeString(input.mode);
    if (MODES.has(mode)) result.mode = mode;
    const color = normalizeString(input.color);
    if (/^#[0-9A-Fa-f]{6}$/.test(color)) result.color = color;
    if (isPlainObject(input.permission) && Object.keys(input.permission).length > 0) result.permission = input.permission;
    if (isPlainObject(input.providerOptions) && Object.keys(input.providerOptions).length > 0) result.providerOptions = input.providerOptions;
  } else {
    assignString(result, input, 'description');
    assignPositiveInteger(result, input, 'max_prompt_tokens');
    if (typeof input.is_unstable_agent === 'boolean') result.is_unstable_agent = input.is_unstable_agent;
  }

  return Object.fromEntries(Object.entries(result).filter(([, value]) => {
    if (value === undefined || value === null) return false;
    if (Array.isArray(value) && value.length === 0) return false;
    if (isPlainObject(value) && Object.keys(value).length === 0) return false;
    return true;
  }));
}

export function normalizeOpenAgentRecord(kind: OpenAgentKind, input: unknown): OpenAgentOverrideRecord {
  if (!isPlainObject(input)) return {};
  const result: OpenAgentOverrideRecord = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = normalizeString(rawKey);
    if (!key) continue;
    const override = normalizeOpenAgentOverride(kind, rawValue);
    if (Object.keys(override).length > 0) {
      result[key] = override;
    }
  }
  return result;
}

export function fallbackModelsToRows(value: unknown): OpenAgentFallbackRow[] {
  const entries = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  return entries.map((entry, index) => {
    if (typeof entry === 'string') {
      return {
        id: `fallback-${index}`,
        model: entry,
        variant: '',
        maxTokens: '',
        reasoningEffort: '',
        originalType: 'string' as const,
      };
    }

    const objectEntry = isPlainObject(entry) ? entry : {};
    const thinking = isPlainObject(objectEntry.thinking) ? objectEntry.thinking : {};
    return {
      id: `fallback-${index}`,
      model: normalizeString(objectEntry.model),
      variant: normalizeString(objectEntry.variant),
      maxTokens: objectEntry.maxTokens == null ? '' : String(objectEntry.maxTokens),
      reasoningEffort: normalizeString(objectEntry.reasoningEffort),
      temperature: objectEntry.temperature == null ? undefined : String(objectEntry.temperature),
      top_p: objectEntry.top_p == null ? undefined : String(objectEntry.top_p),
      thinkingType: normalizeString(thinking.type) || undefined,
      thinkingBudgetTokens: thinking.budgetTokens == null ? undefined : String(thinking.budgetTokens),
      originalType: 'object' as const,
    };
  });
}

export function fallbackRowsToConfig(rows: OpenAgentFallbackRow[]): FallbackModels | undefined {
  const entries = rows
    .map((row) => {
      const model = normalizeString(row.model);
      if (!model) return null;

      const variant = normalizeString(row.variant);
      const reasoningEffort = normalizeString(row.reasoningEffort);
      const maxTokens = normalizePositiveInteger(row.maxTokens);
      const temperature = normalizeNumberInRange(row.temperature, 0, 2);
      const topP = normalizeNumberInRange(row.top_p, 0, 1);
      const thinking = normalizeThinking({
        type: row.thinkingType,
        budgetTokens: row.thinkingBudgetTokens,
      });
      const hasObjectFields = row.originalType === 'object'
        || variant
        || REASONING_EFFORTS.has(reasoningEffort)
        || maxTokens !== undefined
        || temperature !== undefined
        || topP !== undefined
        || thinking !== undefined;

      if (!hasObjectFields) return model;

      return {
        model,
        ...(variant ? { variant } : {}),
        ...(REASONING_EFFORTS.has(reasoningEffort) ? { reasoningEffort } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(topP !== undefined ? { top_p: topP } : {}),
        ...(thinking !== undefined ? { thinking } : {}),
      };
    })
    .filter(Boolean) as Array<string | FallbackModelObject>;

  return entries.length > 0 ? entries : undefined;
}

export function createOpenAgentDraftFromConfig(config: OpenAgentConfigResponseLike | null | undefined): OpenAgentDraft {
  const draft: OpenAgentDraft = {
    agents: cloneJson(config?.raw?.agents ?? {}),
    categories: cloneJson(config?.raw?.categories ?? {}),
    disabled_hooks: normalizeDisabledHooks(config?.raw?.disabled_hooks),
  };
  addOpenAgentGlobalFields(draft, config?.raw ?? {});
  return draft;
}

export function buildOpenAgentSavePayload(expectedMtimeMs: number | null, draft: OpenAgentDraft): OpenAgentSavePayload {
  const payload: OpenAgentSavePayload = {
    expectedMtimeMs,
    agents: normalizeOpenAgentRecord('agent', draft.agents),
    categories: normalizeOpenAgentRecord('category', draft.categories),
    disabled_hooks: normalizeDisabledHooks(draft.disabled_hooks),
  };

  addOpenAgentGlobalFields(payload, draft as unknown as Record<string, unknown>);
  return payload;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue(value[key])]),
  );
}

export function stableStringifyOpenAgent(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function hasOpenAgentDraftChanges(initial: OpenAgentDraft, draft: OpenAgentDraft): boolean {
  const normalizedInitial = {
    agents: normalizeOpenAgentRecord('agent', initial.agents),
    categories: normalizeOpenAgentRecord('category', initial.categories),
    disabled_hooks: normalizeDisabledHooks(initial.disabled_hooks),
  };
  addOpenAgentGlobalFields(normalizedInitial, initial as unknown as Record<string, unknown>);
  const normalizedDraft = {
    agents: normalizeOpenAgentRecord('agent', draft.agents),
    categories: normalizeOpenAgentRecord('category', draft.categories),
    disabled_hooks: normalizeDisabledHooks(draft.disabled_hooks),
  };
  addOpenAgentGlobalFields(normalizedDraft, draft as unknown as Record<string, unknown>);
  return stableStringifyOpenAgent(normalizedInitial) !== stableStringifyOpenAgent(normalizedDraft);
}

export function parseModelRef(model: string | undefined | null): { providerId: string; modelId: string } {
  const normalized = normalizeString(model);
  const slashIndex = normalized.indexOf('/');
  if (slashIndex <= 0 || slashIndex === normalized.length - 1) {
    return { providerId: '', modelId: normalized };
  }
  return {
    providerId: normalized.slice(0, slashIndex),
    modelId: normalized.slice(slashIndex + 1),
  };
}

export function joinModelRef(providerId: string, modelId: string): string {
  const provider = normalizeString(providerId);
  const model = normalizeString(modelId);
  return provider && model ? `${provider}/${model}` : model;
}

export function countFallbackModels(value: unknown): number {
  if (typeof value === 'string') return normalizeString(value) ? 1 : 0;
  if (!Array.isArray(value)) return 0;
  return value.filter((entry) => {
    if (typeof entry === 'string') return Boolean(normalizeString(entry));
    return Boolean(isPlainObject(entry) && normalizeString(entry.model));
  }).length;
}
