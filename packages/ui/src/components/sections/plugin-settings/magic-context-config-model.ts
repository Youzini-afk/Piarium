import type { JsonValue } from '@piarium/protocol';
import {
  hasJsonPath,
  readJsonPath,
  type JsonObject,
} from './plugin-config-model';

export type MagicContextScope = 'user' | 'project';
/** User-facing areas. Legacy values remain accepted for deep links from older settings navigation. */
export type MagicContextPanel =
  | 'context'
  | 'memory'
  | 'models'
  | 'maintenance'
  | 'overview'
  | 'pipeline'
  | 'embedding'
  | 'agents'
  | 'tasks';
export type MagicContextAgent = 'historian' | 'dreamer' | 'sidekick';

export const MAGIC_CONTEXT_AGENTS: readonly MagicContextAgent[] = [
  'historian',
  'dreamer',
  'sidekick',
];

export const MAGIC_CONTEXT_PANELS: readonly MagicContextPanel[] = [
  'context',
  'memory',
  'models',
  'maintenance',
];

export const MAGIC_CONTEXT_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

export const MAGIC_CONTEXT_DREAMER_TASK_DEFAULTS = {
  'map-memories': { schedule: '0 2 * * *', timeout: 20 },
  verify: { schedule: '0 3 * * *', timeout: 20 },
  'verify-broad': { schedule: '0 4 * * 0', timeout: 20 },
  curate: { schedule: '0 4 * * 0', timeout: 20 },
  'compress-cues': { schedule: '0 4 * * *', timeout: 20 },
  'classify-memories': { schedule: '0 6 * * *', timeout: 20 },
  retrospective: { schedule: '0 5 * * *', timeout: 20 },
  'maintain-docs': { schedule: '', timeout: 20 },
  'evaluate-smart-notes': { schedule: '0 3 * * *', timeout: 20 },
  'review-user-memories': { schedule: '0 3 * * *', timeout: 20, promotionThreshold: 3 },
  'promote-primers': { schedule: '0 3 * * *', timeout: 20, promotionThreshold: 2 },
  'refresh-primers': { schedule: '0 3 * * *', timeout: 20 },
} as const;

export type MagicContextDreamerTask = keyof typeof MAGIC_CONTEXT_DREAMER_TASK_DEFAULTS;

export type MagicContextDraftIssue =
  | { code: 'embedding-required'; field: 'embedding.endpoint' | 'embedding.model' }
  | { code: 'invalid-color'; field: string }
  | { code: 'invalid-language'; field: 'language' }
  | { code: 'invalid-schedule'; field: string }
  | { code: 'invalid-value'; field: string }
  | { code: 'required'; field: string };

interface CronFieldSpec {
  max: number;
  min: number;
}

const CRON_FIELDS: readonly CronFieldSpec[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
];

const isObject = (value: JsonValue | undefined): value is JsonObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const nonEmptyString = (value: JsonValue | undefined): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

function validCronPart(part: string, spec: CronFieldSpec): boolean {
  const [rangePart, stepPart, ...extra] = part.split('/');
  if (!rangePart || extra.length > 0) return false;
  const step = stepPart === undefined
    ? 1
    : /^\d+$/.test(stepPart) ? Number(stepPart) : 0;
  if (step < 1) return false;

  let lower: number;
  let upper: number;
  if (rangePart === '*') {
    lower = spec.min;
    upper = spec.max;
  } else if (rangePart.includes('-')) {
    const [lowerText, upperText, ...rest] = rangePart.split('-');
    if (rest.length > 0 || !lowerText || !upperText) return false;
    if (!/^\d+$/.test(lowerText) || !/^\d+$/.test(upperText)) return false;
    lower = Number(lowerText);
    upper = Number(upperText);
  } else {
    if (!/^\d+$/.test(rangePart)) return false;
    lower = Number(rangePart);
    upper = stepPart === undefined ? lower : spec.max;
  }
  return lower >= spec.min && lower <= spec.max && upper >= spec.min && upper <= spec.max && lower <= upper;
}

/** Mirrors Magic Context's current numeric-only five-field cron surface. */
export function isValidMagicContextSchedule(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  const fields = trimmed.split(/\s+/);
  return fields.length === CRON_FIELDS.length && fields.every((field, index) => (
    field.split(',').every((part) => Boolean(part) && validCronPart(part, CRON_FIELDS[index]!))
  ));
}

const PROJECT_IGNORED_PATHS: readonly (readonly string[])[] = [
  ['auto_update'],
  ['fail_closed_blocking'],
  ['language'],
  ['sqlite'],
  ['subc'],
  ['shadow_embedding'],
  ['pi', 'subagent_extensions'],
  ['embedding', 'provider'],
  ['embedding', 'endpoint'],
  ['embedding', 'fallback_provider'],
  ['historian', 'model'],
  ['historian', 'fallback_models'],
  ...MAGIC_CONTEXT_AGENTS.flatMap((agent) => ([
    [agent, 'prompt'] as const,
    [agent, 'permission'] as const,
    [agent, 'tools'] as const,
    [agent, 'system_prompt'] as const,
  ])),
];

const EXPOSED_BOOLEAN_PATHS: readonly (readonly string[])[] = [
  ['enabled'],
  ['temporal_awareness'],
  ['todowrite', 'enabled'],
  ['todowrite', 'overlay'],
  ['keep_subagents'],
  ['experimental', 'mural', 'enabled'],
  ['commit_cluster_trigger', 'enabled'],
  ['system_prompt_injection', 'enabled'],
  ['smart_drops'],
  ['caveman_text_compression', 'enabled'],
  ['memory', 'enabled'],
  ['memory', 'auto_promote'],
  ['memory', 'auto_search', 'enabled'],
  ['memory', 'git_commit_indexing', 'enabled'],
];

const USER_EXPOSED_BOOLEAN_PATHS: readonly (readonly string[])[] = [
  ['fail_closed_blocking'],
  ['shadow_embedding', 'enabled'],
];

export function magicContextProjectIgnoredPaths(draft: JsonObject): string[] {
  return PROJECT_IGNORED_PATHS
    .filter((path) => hasJsonPath(draft, path))
    .map((path) => path.join('.'));
}

function invalidRecordValue(
  value: JsonValue | undefined,
  kind: 'number' | 'string',
  requiresDefault: boolean,
  min?: number,
  max?: number,
): boolean {
  if (!isObject(value)) return false;
  if (requiresDefault && !(kind === 'number'
    ? typeof value.default === 'number'
      && Number.isFinite(value.default)
      && (min === undefined || value.default >= min)
      && (max === undefined || value.default <= max)
    : typeof value.default === 'string')) return true;
  return Object.values(value).some((entry) => (
    kind === 'number'
      ? typeof entry !== 'number'
        || !Number.isFinite(entry)
        || (min !== undefined && entry < min)
        || (max !== undefined && entry > max)
      : typeof entry !== 'string'
  ));
}

const permissionValue = (value: JsonValue | undefined): boolean => (
  typeof value === 'string' && ['ask', 'allow', 'deny'].includes(value)
);

function agentIssue(
  draft: JsonObject,
  agent: MagicContextAgent,
  scope: MagicContextScope,
): MagicContextDraftIssue | null {
  const block = readJsonPath(draft, [agent]);
  if (block === undefined) return null;
  if (!isObject(block)) return { code: 'invalid-value', field: agent };

  const stringKeys = agent === 'historian' && scope === 'project'
    ? ['description', 'variant'] as const
    : ['model', 'description', 'variant'] as const;
  for (const key of stringKeys) {
    if (block[key] !== undefined && typeof block[key] !== 'string') {
      return { code: 'invalid-value', field: `${agent}.${key}` };
    }
  }

  if (scope === 'user') {
    for (const key of ['prompt', 'system_prompt'] as const) {
      if (block[key] !== undefined && typeof block[key] !== 'string') {
        return { code: 'invalid-value', field: `${agent}.${key}` };
      }
    }
  }

  if (!(agent === 'historian' && scope === 'project')) {
    const fallbackModels = block.fallback_models;
    if (
      fallbackModels !== undefined
      && typeof fallbackModels !== 'string'
      && (!Array.isArray(fallbackModels) || fallbackModels.some((value) => typeof value !== 'string'))
    ) return { code: 'invalid-value', field: `${agent}.fallback_models` };
  }

  for (const key of ['disable', ...(agent === 'historian' ? ['two_pass'] : []), ...(agent === 'dreamer' ? ['inject_docs'] : [])]) {
    if (block[key] !== undefined && typeof block[key] !== 'boolean') {
      return { code: 'invalid-value', field: `${agent}.${key}` };
    }
  }

  for (const key of ['maxSteps', 'maxTokens', ...(agent === 'sidekick' ? ['timeout_ms'] : [])]) {
    if (block[key] !== undefined && (
      typeof block[key] !== 'number' || !Number.isFinite(block[key])
    )) return { code: 'invalid-value', field: `${agent}.${key}` };
  }

  const color = block.color;
  if (color !== undefined && (typeof color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(color))) {
    return { code: 'invalid-color', field: `${agent}.color` };
  }

  const thinking = block.thinking_level;
  if (
    thinking !== undefined
    && (typeof thinking !== 'string'
      || !(MAGIC_CONTEXT_THINKING_LEVELS as readonly string[]).includes(thinking))
  ) {
    return { code: 'invalid-value', field: `${agent}.thinking_level` };
  }

  const mode = block.mode;
  if (mode !== undefined && !['subagent', 'primary', 'all'].includes(String(mode))) {
    return { code: 'invalid-value', field: `${agent}.mode` };
  }

  for (const [key, min, max] of [
    ['temperature', 0, 2],
    ['top_p', 0, 1],
  ] as const) {
    const value = block[key];
    if (value !== undefined && (
      typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
    )) return { code: 'invalid-value', field: `${agent}.${key}` };
  }

  if (scope === 'user') {
    const tools = block.tools;
    if (tools !== undefined && (
      !isObject(tools) || Object.values(tools).some((value) => typeof value !== 'boolean')
    )) return { code: 'invalid-value', field: `${agent}.tools` };

    const permission = block.permission;
    if (permission !== undefined) {
      if (!isObject(permission)) return { code: 'invalid-value', field: `${agent}.permission` };
      for (const key of ['edit', 'webfetch', 'doom_loop', 'external_directory'] as const) {
        if (permission[key] !== undefined && !permissionValue(permission[key])) {
          return { code: 'invalid-value', field: `${agent}.permission.${key}` };
        }
      }
      const bash = permission.bash;
      if (bash !== undefined && !permissionValue(bash) && (
        !isObject(bash) || Object.values(bash).some((value) => !permissionValue(value))
      )) return { code: 'invalid-value', field: `${agent}.permission.bash` };
    }
  }
  return null;
}

function dreamerTaskIssue(draft: JsonObject): MagicContextDraftIssue | null {
  for (const task of Object.keys(MAGIC_CONTEXT_DREAMER_TASK_DEFAULTS) as MagicContextDreamerTask[]) {
    const taskBlock = readJsonPath(draft, ['dreamer', 'tasks', task]);
    if (taskBlock === undefined) continue;
    if (!isObject(taskBlock)) return { code: 'invalid-value', field: `dreamer.tasks.${task}` };
    const schedule = taskBlock.schedule;
    if (schedule !== undefined && (
      typeof schedule !== 'string' || !isValidMagicContextSchedule(schedule)
    )) {
      return { code: 'invalid-schedule', field: `dreamer.tasks.${task}.schedule` };
    }
    if (taskBlock.model !== undefined && typeof taskBlock.model !== 'string') {
      return { code: 'invalid-value', field: `dreamer.tasks.${task}.model` };
    }
    const fallbackModels = taskBlock.fallback_models;
    if (
      fallbackModels !== undefined
      && typeof fallbackModels !== 'string'
      && (!Array.isArray(fallbackModels) || fallbackModels.some((value) => typeof value !== 'string'))
    ) return { code: 'invalid-value', field: `dreamer.tasks.${task}.fallback_models` };
    const thinking = taskBlock.thinking_level;
    if (
      thinking !== undefined
      && (typeof thinking !== 'string'
        || !(MAGIC_CONTEXT_THINKING_LEVELS as readonly string[]).includes(thinking))
    ) return { code: 'invalid-value', field: `dreamer.tasks.${task}.thinking_level` };
    const timeout = taskBlock.timeout_minutes;
    if (timeout !== undefined && (
      typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 5
    )) return { code: 'invalid-value', field: `dreamer.tasks.${task}.timeout_minutes` };
    const promotion = taskBlock.promotion_threshold;
    if (promotion !== undefined && (
      typeof promotion !== 'number' || !Number.isFinite(promotion) || promotion < 2 || promotion > 20
    )) return { code: 'invalid-value', field: `dreamer.tasks.${task}.promotion_threshold` };
  }
  return null;
}

export function magicContextDraftIssue(
  draft: JsonObject,
  scope: MagicContextScope,
): MagicContextDraftIssue | null {
  const language = readJsonPath(draft, ['language']);
  if (scope === 'user' && language !== undefined && (
    typeof language !== 'string' || !/^[A-Za-z]{2}$/.test(language.trim())
  )) return { code: 'invalid-language', field: 'language' };

  const transformMode = readJsonPath(draft, ['transform_mode']);
  if (transformMode !== undefined && !['ts', 'rust'].includes(String(transformMode))) {
    return { code: 'invalid-value', field: 'transform_mode' };
  }

  const booleanPaths = scope === 'user'
    ? [...EXPOSED_BOOLEAN_PATHS, ...USER_EXPOSED_BOOLEAN_PATHS]
    : EXPOSED_BOOLEAN_PATHS;
  for (const path of booleanPaths) {
    if (hasJsonPath(draft, path) && typeof readJsonPath(draft, path) !== 'boolean') {
      return { code: 'invalid-value', field: path.join('.') };
    }
  }

  const muralModel = readJsonPath(draft, ['experimental', 'mural', 'model']);
  if (hasJsonPath(draft, ['experimental', 'mural', 'model']) && !nonEmptyString(muralModel)) {
    return { code: 'invalid-value', field: 'experimental.mural.model' };
  }

  const skipSignatures = readJsonPath(draft, ['system_prompt_injection', 'skip_signatures']);
  if (hasJsonPath(draft, ['system_prompt_injection', 'skip_signatures']) && (
    !Array.isArray(skipSignatures) || skipSignatures.some((value) => typeof value !== 'string')
  )) return { code: 'invalid-value', field: 'system_prompt_injection.skip_signatures' };

  for (const agent of MAGIC_CONTEXT_AGENTS) {
    const issue = agentIssue(draft, agent, scope);
    if (issue) return issue;
  }
  const taskIssue = dreamerTaskIssue(draft);
  if (taskIssue) return taskIssue;

  const cacheTtl = readJsonPath(draft, ['cache_ttl']);
  if (cacheTtl !== undefined && typeof cacheTtl !== 'string' && (
    !isObject(cacheTtl) || invalidRecordValue(cacheTtl, 'string', true)
  )) return { code: 'invalid-value', field: 'cache_ttl' };

  const percentage = readJsonPath(draft, ['execute_threshold_percentage']);
  if (percentage !== undefined) {
    if (typeof percentage === 'number') {
      if (!Number.isFinite(percentage) || percentage < 20 || percentage > 80) {
        return { code: 'invalid-value', field: 'execute_threshold_percentage' };
      }
    } else if (!isObject(percentage) || invalidRecordValue(percentage, 'number', true, 20, 80)) {
      return { code: 'invalid-value', field: 'execute_threshold_percentage' };
    }
  }

  const tokenThresholds = readJsonPath(draft, ['execute_threshold_tokens']);
  if (tokenThresholds !== undefined && (
    !isObject(tokenThresholds) || invalidRecordValue(tokenThresholds, 'number', false, 5000, 2000000)
  )) return { code: 'invalid-value', field: 'execute_threshold_tokens' };

  for (const [path, min, max] of [
    [['toast_duration_ms'], 0, 60000],
    [['protected_tags'], 1, 100],
    [['clear_reasoning_age'], 10, Number.POSITIVE_INFINITY],
    [['history_budget_percentage'], 0.05, 0.5],
    [['historian_timeout_ms'], 60000, Number.POSITIVE_INFINITY],
    [['commit_cluster_trigger', 'min_clusters'], 1, Number.POSITIVE_INFINITY],
    [['caveman_text_compression', 'min_chars'], 100, 10000],
    [['memory', 'injection_budget_tokens'], 500, 20000],
    [['memory', 'retrieval_count_promotion_threshold'], 1, Number.POSITIVE_INFINITY],
    [['memory', 'auto_search', 'score_threshold'], 0.3, 0.95],
    [['memory', 'auto_search', 'min_prompt_chars'], 5, 500],
    [['memory', 'git_commit_indexing', 'since_days'], 7, 3650],
    [['memory', 'git_commit_indexing', 'max_commits'], 100, 20000],
  ] as const) {
    const value = readJsonPath(draft, path);
    if (value !== undefined && (
      typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
    )) return { code: 'invalid-value', field: path.join('.') };
  }

  const embedding = readJsonPath(draft, ['embedding']);
  if (embedding !== undefined && !isObject(embedding)) {
    return { code: 'invalid-value', field: 'embedding' };
  }
  if (isObject(embedding)) {
    for (const key of ['model', 'api_key', 'input_type', 'query_input_type', 'truncate'] as const) {
      if (embedding[key] !== undefined && typeof embedding[key] !== 'string') {
        return { code: 'invalid-value', field: `embedding.${key}` };
      }
    }
    const maxInputTokens = embedding.max_input_tokens;
    if (maxInputTokens !== undefined && (
      typeof maxInputTokens !== 'number'
      || !Number.isInteger(maxInputTokens)
      || maxInputTokens <= 0
    )) return { code: 'invalid-value', field: 'embedding.max_input_tokens' };
  }

  if (scope === 'user') {
    if (isObject(embedding)) {
      if (embedding.provider !== undefined && typeof embedding.provider !== 'string') {
        return { code: 'invalid-value', field: 'embedding.provider' };
      }
      const provider = typeof embedding.provider === 'string' ? embedding.provider : 'local';
      if (!['local', 'openai-compatible', 'off', 'synapse'].includes(provider)) {
        return { code: 'invalid-value', field: 'embedding.provider' };
      }
      if (
        embedding.fallback_provider !== undefined
        && (typeof embedding.fallback_provider !== 'string'
          || !['local', 'openai-compatible', 'off'].includes(embedding.fallback_provider))
      ) return { code: 'invalid-value', field: 'embedding.fallback_provider' };
      if (embedding.endpoint !== undefined && typeof embedding.endpoint !== 'string') {
        return { code: 'invalid-value', field: 'embedding.endpoint' };
      }
      const validationProvider = provider === 'synapse' ? embedding.fallback_provider : provider;
      if (validationProvider === 'openai-compatible') {
        if (!nonEmptyString(embedding.endpoint)) {
          return { code: 'embedding-required', field: 'embedding.endpoint' };
        }
        if (!nonEmptyString(embedding.model)) {
          return { code: 'embedding-required', field: 'embedding.model' };
        }
      }
    }

    const subc = readJsonPath(draft, ['subc']);
    if (subc !== undefined && (!isObject(subc) || !nonEmptyString(subc.connection_file))) {
      return { code: 'required', field: 'subc.connection_file' };
    }
    const extensions = readJsonPath(draft, ['pi', 'subagent_extensions']);
    if (extensions !== undefined && (
      !Array.isArray(extensions)
      || extensions.some((value) => typeof value !== 'string' || !value.trim())
    )) return { code: 'invalid-value', field: 'pi.subagent_extensions' };

    for (const [path, min, max] of [
      [['sqlite', 'cache_size_mb'], 2, 2048],
      [['sqlite', 'mmap_size_mb'], 0, 8192],
    ] as const) {
      const value = readJsonPath(draft, path);
      if (value !== undefined && (
        typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
      )) return { code: 'invalid-value', field: path.join('.') };
    }
  }
  return null;
}

export function hasObjectValue(draft: JsonObject, path: readonly string[]): boolean {
  return isObject(readJsonPath(draft, path));
}
