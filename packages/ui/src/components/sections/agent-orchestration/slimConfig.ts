export type SlimMode = 'native' | 'slim' | 'omo' | 'conflict';

export type SlimAgentGroup = 'primary' | 'sub' | 'optional' | 'custom';

export type SlimAgentOverride = Record<string, unknown> & {
  model?: string | Array<string | { id: string; variant?: string }>;
  variant?: string;
  temperature?: number;
  skills?: string[];
  mcps?: string[];
  options?: Record<string, unknown>;
  displayName?: string;
  prompt?: string;
  orchestratorPrompt?: string;
};

export type SlimRawConfig = Record<string, unknown> & {
  $schema?: string;
  preset?: string;
  presets?: Record<string, Record<string, SlimAgentOverride>>;
  agents?: Record<string, SlimAgentOverride>;
  disabled_agents?: string[];
  autoUpdate?: boolean;
  disabled_mcps?: string[];
  fallback?: Record<string, unknown>;
  multiplexer?: Record<string, unknown>;
  council?: Record<string, unknown>;
  divoom?: Record<string, unknown>;
  interview?: Record<string, unknown>;
  sessionManager?: Record<string, unknown>;
  todoContinuation?: Record<string, unknown>;
};

export interface SlimAgentItem {
  id: string;
  label: string;
  description: string;
  group: SlimAgentGroup;
  defaultModel: string | null;
  defaultVariant: string | null;
  disabled: boolean;
  projectDisabled: boolean;
  override: SlimAgentOverride | null;
  projectOverride: boolean;
}

export interface SlimConfigResponse {
  plugin: {
    detected: boolean;
    enabled: boolean;
    entry: string | null;
    configPath?: string | null;
    mtimeMs?: number | null;
  };
  target: {
    scope: 'user';
    path: string;
    exists: boolean;
    format: 'json' | 'jsonc';
    mtimeMs?: number | null;
  };
  project: {
    path: string | null;
    exists: boolean;
    overriddenKeys: string[];
  };
  raw: SlimRawConfig;
  projectRaw?: SlimRawConfig;
  effective: SlimRawConfig;
  presets: string[];
  agents: SlimAgentItem[];
}

export interface SlimSavePayload {
  expectedMtimeMs: number | null;
  config: SlimRawConfig;
}

export const SLIM_AGENT_DEFINITIONS: Array<{
  id: string;
  label: string;
  description: string;
  group: SlimAgentGroup;
  defaultModel?: string;
  defaultVariant?: string;
}> = [
  { id: 'orchestrator', label: 'Orchestrator', description: '主编排者', group: 'primary', defaultModel: 'openai/gpt-5.5' },
  { id: 'oracle', label: 'Oracle', description: '架构顾问与深度审查', group: 'sub', defaultModel: 'openai/gpt-5.5', defaultVariant: 'high' },
  { id: 'librarian', label: 'Librarian', description: '外部文档与资料检索', group: 'sub', defaultModel: 'openai/gpt-5.4-mini', defaultVariant: 'low' },
  { id: 'explorer', label: 'Explorer', description: '代码库搜索与侦察', group: 'sub', defaultModel: 'openai/gpt-5.4-mini', defaultVariant: 'low' },
  { id: 'designer', label: 'Designer', description: 'UI/UX 设计与前端体验', group: 'sub', defaultModel: 'openai/gpt-5.4-mini', defaultVariant: 'medium' },
  { id: 'fixer', label: 'Fixer', description: '明确范围内的快速实现', group: 'sub', defaultModel: 'openai/gpt-5.4-mini', defaultVariant: 'low' },
  { id: 'observer', label: 'Observer', description: '图像/PDF/视觉分析', group: 'optional', defaultModel: 'openai/gpt-5.4-mini' },
  { id: 'council', label: 'Council', description: '多模型共识与高风险决策', group: 'optional', defaultModel: 'openai/gpt-5.4-mini' },
];

const VARIANTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const PROTECTED_AGENTS = new Set(['orchestrator', 'councillor']);
const MULTIPLEXER_TYPES = new Set(['auto', 'tmux', 'zellij', 'none']);
const MULTIPLEXER_LAYOUTS = new Set(['main-horizontal', 'main-vertical', 'tiled', 'even-horizontal', 'even-vertical']);

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? {}));

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const normalizeString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const normalizeFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const normalized = normalizeString(value);
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const normalizeNumberInRange = (value: unknown, min: number, max: number): number | undefined => {
  const parsed = normalizeFiniteNumber(value);
  if (parsed === undefined || parsed < min || parsed > max) return undefined;
  return parsed;
};

const normalizeIntegerInRange = (value: unknown, min: number, max: number): number | undefined => {
  const parsed = normalizeNumberInRange(value, min, max);
  return parsed === undefined ? undefined : Math.floor(parsed);
};

const normalizeIntegerMin = (value: unknown, min: number): number | undefined => {
  const parsed = normalizeFiniteNumber(value);
  if (parsed === undefined || parsed < min) return undefined;
  return Math.floor(parsed);
};

const normalizeStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value.map(normalizeString).filter(Boolean);
};

const normalizeModel = (value: unknown): SlimAgentOverride['model'] | undefined => {
  if (typeof value === 'string') return normalizeString(value) || undefined;
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .map((entry) => {
      if (typeof entry === 'string') return normalizeString(entry) || null;
      if (!isPlainObject(entry)) return null;
      const id = normalizeString(entry.id);
      if (!id) return null;
      const variant = normalizeString(entry.variant);
      return { id, ...(variant ? { variant } : {}) };
    })
    .filter(Boolean) as Array<string | { id: string; variant?: string }>;
  return entries.length > 0 ? entries : undefined;
};

export function normalizeSlimAgentOverride(input: unknown): SlimAgentOverride {
  if (!isPlainObject(input)) return {};
  const result: SlimAgentOverride = {};
  const model = normalizeModel(input.model);
  if (model) result.model = model;
  const variant = normalizeString(input.variant);
  if (variant) result.variant = variant;
  const temperature = normalizeNumberInRange(input.temperature, 0, 2);
  if (temperature !== undefined) result.temperature = temperature;
  const skills = normalizeStringArray(input.skills);
  if (skills !== undefined) result.skills = skills;
  const mcps = normalizeStringArray(input.mcps);
  if (mcps !== undefined) result.mcps = mcps;
  const displayName = normalizeString(input.displayName);
  if (displayName) result.displayName = displayName;
  const prompt = normalizeString(input.prompt);
  if (prompt) result.prompt = prompt;
  const orchestratorPrompt = normalizeString(input.orchestratorPrompt);
  if (orchestratorPrompt) result.orchestratorPrompt = orchestratorPrompt;
  if (isPlainObject(input.options) && Object.keys(input.options).length > 0) result.options = input.options;
  return result;
}

const normalizeAgentRecord = (input: unknown): Record<string, SlimAgentOverride> | undefined => {
  if (!isPlainObject(input)) return undefined;
  const result: Record<string, SlimAgentOverride> = {};
  for (const [rawKey, value] of Object.entries(input)) {
    const key = normalizeString(rawKey);
    if (!key) continue;
    const override = normalizeSlimAgentOverride(value);
    if (Object.keys(override).length > 0) result[key] = override;
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

const normalizePresets = (input: unknown): SlimRawConfig['presets'] | undefined => {
  if (!isPlainObject(input)) return undefined;
  const result: NonNullable<SlimRawConfig['presets']> = {};
  for (const [rawKey, value] of Object.entries(input)) {
    const key = normalizeString(rawKey);
    if (!key) continue;
    const agents = normalizeAgentRecord(value);
    if (agents) result[key] = agents;
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

const normalizeRecordJson = (value: unknown): Record<string, unknown> | undefined => (
  isPlainObject(value) && Object.keys(value).length > 0 ? cloneJson(value) : undefined
);

export function normalizeSlimConfig(input: unknown): SlimRawConfig {
  if (!isPlainObject(input)) return {};
  const result: SlimRawConfig = {};
  const schema = normalizeString(input.$schema);
  if (schema) result.$schema = schema;
  const preset = normalizeString(input.preset);
  if (preset) result.preset = preset;
  const presets = normalizePresets(input.presets);
  if (presets) result.presets = presets;
  const agents = normalizeAgentRecord(input.agents);
  if (agents) result.agents = agents;
  const disabledAgents = normalizeStringArray(input.disabled_agents);
  if (disabledAgents) result.disabled_agents = Array.from(new Set(disabledAgents.filter((id) => !PROTECTED_AGENTS.has(id))));
  if (typeof input.autoUpdate === 'boolean') result.autoUpdate = input.autoUpdate;
  const disabledMcps = normalizeStringArray(input.disabled_mcps);
  if (disabledMcps) result.disabled_mcps = disabledMcps;
  const fallback = normalizeRecordJson(input.fallback);
  if (fallback) result.fallback = fallback;
  const multiplexer = normalizeRecordJson(input.multiplexer);
  if (multiplexer) result.multiplexer = multiplexer;
  const council = normalizeRecordJson(input.council);
  if (council) result.council = council;
  const divoom = normalizeRecordJson(input.divoom);
  if (divoom) result.divoom = divoom;
  const interview = normalizeRecordJson(input.interview);
  if (interview) result.interview = interview;
  const sessionManager = normalizeRecordJson(input.sessionManager);
  if (sessionManager) result.sessionManager = sessionManager;
  const todoContinuation = normalizeRecordJson(input.todoContinuation);
  if (todoContinuation) result.todoContinuation = todoContinuation;
  return result;
}

export function createSlimDraftFromConfig(config: SlimConfigResponse | null | undefined): SlimRawConfig {
  return cloneJson(config?.raw ?? {});
}

export function buildSlimSavePayload(expectedMtimeMs: number | null, draft: SlimRawConfig): SlimSavePayload {
  return {
    expectedMtimeMs,
    config: normalizeSlimConfig(draft),
  };
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

export function stableStringifySlim(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function hasSlimDraftChanges(initial: SlimRawConfig, draft: SlimRawConfig): boolean {
  return stableStringifySlim(normalizeSlimConfig(initial)) !== stableStringifySlim(normalizeSlimConfig(draft));
}

export function getActivePreset(draft: SlimRawConfig): string {
  const preset = normalizeString(draft.preset);
  if (preset) return preset;
  const presets = isPlainObject(draft.presets) ? Object.keys(draft.presets) : [];
  return presets[0] ?? 'openai';
}

export function getPresetAgent(draft: SlimRawConfig, agentId: string): SlimAgentOverride {
  const preset = getActivePreset(draft);
  const presets = isPlainObject(draft.presets) ? draft.presets : {};
  const presetRecord = isPlainObject(presets[preset]) ? presets[preset] : {};
  return isPlainObject(presetRecord[agentId]) ? presetRecord[agentId] : {};
}

export function getModelString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    if (typeof first === 'string') return first;
    if (isPlainObject(first)) return normalizeString(first.id);
  }
  return '';
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

export function normalizeNumberInput(value: string, kind: 'temperature' | 'mainPane' | 'integer' = 'integer'): number | undefined {
  if (kind === 'temperature') return normalizeNumberInRange(value, 0, 2);
  if (kind === 'mainPane') return normalizeIntegerInRange(value, 20, 80);
  return normalizeIntegerMin(value, 0);
}

export function normalizeVariant(value: string): string | undefined {
  const variant = normalizeString(value);
  if (!variant) return undefined;
  return VARIANTS.has(variant) ? variant : variant;
}

export function normalizeMultiplexerType(value: string): string | undefined {
  const type = normalizeString(value);
  return MULTIPLEXER_TYPES.has(type) ? type : undefined;
}

export function normalizeMultiplexerLayout(value: string): string | undefined {
  const layout = normalizeString(value);
  return MULTIPLEXER_LAYOUTS.has(layout) ? layout : undefined;
}

export function countFallbackChains(value: unknown, agentId: string): number {
  if (!isPlainObject(value)) return 0;
  const chains = isPlainObject(value.chains) ? value.chains : {};
  const chain = chains[agentId];
  return Array.isArray(chain) ? chain.map(normalizeString).filter(Boolean).length : 0;
}
