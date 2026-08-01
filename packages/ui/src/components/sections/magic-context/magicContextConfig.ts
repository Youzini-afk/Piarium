export type MagicContextScalarMap<T extends string | number> = T | string | Record<string, T | string>;

export type MagicContextAgentFallbackModels = string | string[];

export type MagicContextDreamTaskConfig = Record<string, unknown> & {
  schedule?: string;
  model?: string;
  fallback_models?: MagicContextAgentFallbackModels;
  thinking_level?: string;
  timeout_minutes?: number;
  promotion_threshold?: number;
};

export type MagicContextAgentConfig = Record<string, unknown> & {
  model?: string;
  fallback_models?: MagicContextAgentFallbackModels;
  variant?: string;
  thinking_level?: string;
  temperature?: number;
  top_p?: number;
  prompt?: string;
  maxTokens?: number;
  maxSteps?: number;
  disable?: boolean;
};

export type MagicContextConfig = Record<string, unknown> & {
  enabled?: boolean;
  auto_update?: boolean;
  ctx_reduce_enabled?: boolean;
  cache_ttl?: MagicContextScalarMap<string>;
  toast_duration_ms?: number;
  execute_threshold_percentage?: MagicContextScalarMap<number>;
  execute_threshold_tokens?: Record<string, number>;
  protected_tags?: number;
  clear_reasoning_age?: number;
  history_budget_percentage?: number;
  historian_timeout_ms?: number;
  temporal_awareness?: boolean;
  keep_subagents?: boolean;
  commit_cluster_trigger?: Record<string, unknown>;
  sqlite?: Record<string, unknown>;
  caveman_text_compression?: Record<string, unknown>;
  historian?: MagicContextAgentConfig & { two_pass?: boolean; disallowed_tools?: string[] };
  dreamer?: MagicContextAgentConfig & {
    inject_docs?: boolean;
    tasks?: Record<string, MagicContextDreamTaskConfig>;
  };
  embedding?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  system_prompt_injection?: Record<string, unknown>;
  sidekick?: MagicContextAgentConfig & {
    timeout_ms?: number;
    system_prompt?: string;
  };
};

export interface MagicContextConfigSourceLike {
  path?: string | null;
  exists?: boolean;
  format?: 'json' | 'jsonc';
  mtimeMs?: number | null;
  legacy?: boolean;
}

export interface MagicContextConfigResponseLike {
  raw?: MagicContextConfig;
  source?: MagicContextConfigSourceLike | null;
  project?: {
    overriddenKeys?: string[];
  };
}

export interface MagicContextSavePayload {
  expectedMtimeMs: number | null;
  sourcePath?: string | null;
  sourceMtimeMs?: number | null;
  config: MagicContextConfig;
}

export interface MagicContextFallbackRow {
  id: string;
  model: string;
}

export const CANONICAL_DREAMER_TASKS = [
  'map-memories',
  'verify',
  'verify-broad',
  'curate',
  'classify-memories',
  'retrospective',
  'maintain-docs',
  'evaluate-smart-notes',
  'review-user-memories',
  'promote-primers',
  'refresh-primers',
] as const;

export type CanonicalDreamerTask = typeof CANONICAL_DREAMER_TASKS[number];

export const DEFAULT_DREAMER_TASK_SCHEDULES: Record<CanonicalDreamerTask, string> = {
  'map-memories': '0 2 * * *',
  verify: '0 3 * * *',
  'verify-broad': '0 4 * * 0',
  curate: '0 4 * * 0',
  'classify-memories': '0 6 * * *',
  retrospective: '0 5 * * *',
  'maintain-docs': '',
  'evaluate-smart-notes': '0 3 * * *',
  'review-user-memories': '0 3 * * *',
  'promote-primers': '0 3 * * *',
  'refresh-primers': '0 3 * * *',
};

const MAGIC_CONTEXT_SCHEMA_URL = 'https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json';
const OLD_VERIFY_TASK = 'verify';
const OLD_CURATE_TASKS = ['consolidate', 'archive-stale', 'improve'];
const RETIRED_OBJECT_MEMORY_TASKS = ['maintain-memory', ...OLD_CURATE_TASKS];
const DEFAULT_BASE_CRON = '0 2 * * *';
const DEFAULT_CLASSIFY_CRON = '0 6 * * *';
const DEFAULT_RETROSPECTIVE_CRON = '0 5 * * *';
const DEFAULT_VERIFY_BROAD_CRON = '0 4 * * 0';
const EMBEDDING_PROVIDERS = new Set(['local', 'openai-compatible', 'off']);
const AGENT_MODES = new Set(['subagent', 'primary', 'all']);
const HISTORIAN_DISALLOWED_TOOLS = new Set(['*', 'read', 'aft_outline', 'aft_zoom', 'aft_search']);
const CURRENT_DREAMER_TASKS = new Set<string>(CANONICAL_DREAMER_TASKS);
const RETIRED_TOP_LEVEL_KEYS = new Set([
  'nudge_interval_tokens',
  'auto_drop_tool_age',
  'drop_tool_structure',
  'iteration_nudge_threshold',
  'compaction_markers',
  'compressor',
  'experimental',
]);
const AGENT_KNOWN_KEYS = new Set([
  'model',
  'variant',
  'thinking_level',
  'prompt',
  'description',
  'temperature',
  'top_p',
  'maxTokens',
  'maxSteps',
  'fallback_models',
  'tools',
  'permission',
  'mode',
  'color',
  'disable',
]);
const HISTORIAN_KNOWN_KEYS = new Set([...AGENT_KNOWN_KEYS, 'enabled', 'two_pass', 'disallowed_tools']);
const DREAMER_KNOWN_KEYS = new Set([
  ...AGENT_KNOWN_KEYS,
  'enabled',
  'schedule',
  'max_runtime_minutes',
  'task_timeout_minutes',
  'inject_docs',
  'tasks',
  'user_memories',
  'pin_key_files',
]);
const SIDEKICK_KNOWN_KEYS = new Set([...AGENT_KNOWN_KEYS, 'enabled', 'timeout_ms', 'system_prompt']);
const COMMIT_CLUSTER_KNOWN_KEYS = new Set(['enabled', 'min_clusters']);
const SQLITE_KNOWN_KEYS = new Set(['cache_size_mb', 'mmap_size_mb']);
const SYSTEM_PROMPT_INJECTION_KNOWN_KEYS = new Set(['enabled', 'skip_signatures']);
const EMBEDDING_KNOWN_KEYS = new Set([
  'provider',
  'model',
  'endpoint',
  'api_key',
  'input_type',
  'query_input_type',
  'truncate',
  'max_input_tokens',
]);
const MEMORY_KNOWN_KEYS = new Set([
  'enabled',
  'auto_promote',
  'injection_budget_tokens',
  'retrieval_count_promotion_threshold',
  'auto_search',
  'git_commit_indexing',
]);
const GIT_COMMIT_INDEXING_KNOWN_KEYS = new Set(['enabled', 'since_days', 'max_commits']);
const AUTO_SEARCH_KNOWN_KEYS = new Set(['enabled', 'score_threshold', 'min_prompt_chars']);
const CAVEMAN_TEXT_COMPRESSION_KNOWN_KEYS = new Set(['enabled', 'min_chars']);
const DREAM_TASK_CONFIG_KNOWN_KEYS = new Set([
  'schedule',
  'model',
  'fallback_models',
  'thinking_level',
  'timeout_minutes',
  'promotion_threshold',
  'broad_interval_days',
]);
const TOP_LEVEL_MAGIC_CONTEXT_KEYS = [
  '$schema',
  'enabled',
  'auto_update',
  'ctx_reduce_enabled',
  'cache_ttl',
  'toast_duration_ms',
  'execute_threshold_percentage',
  'execute_threshold_tokens',
  'protected_tags',
  'clear_reasoning_age',
  'history_budget_percentage',
  'historian_timeout_ms',
  'commit_cluster_trigger',
  'sqlite',
  'system_prompt_injection',
  'temporal_awareness',
  'keep_subagents',
  'caveman_text_compression',
  'historian',
  'dreamer',
  'embedding',
  'memory',
  'sidekick',
  'command',
  'disabled_hooks',
];
const CURRENT_TOP_LEVEL_KEY_SET = new Set(TOP_LEVEL_MAGIC_CONTEXT_KEYS);

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? {}));

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const normalizeString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const hasOwn = (input: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(input, key);

const mergePreservingUnknown = <T extends Record<string, unknown>>(
  input: unknown,
  sanitized: Record<string, unknown> | undefined,
  knownKeys: Set<string>,
): T | undefined => {
  if (!isPlainObject(input)) {
    return sanitized && Object.keys(sanitized).length > 0 ? sanitized as T : undefined;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!knownKeys.has(key)) {
      result[key] = cloneJson(value);
    }
  }

  if (sanitized) {
    for (const [key, value] of Object.entries(sanitized)) {
      if (value !== undefined) {
        result[key] = value;
      }
    }
  }

  return Object.keys(result).length > 0 ? result as T : undefined;
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

const normalizeNumberInRange = (value: unknown, min: number, max: number): number | undefined => {
  const parsed = normalizeFiniteNumber(value);
  if (parsed === undefined || parsed < min || parsed > max) return undefined;
  return parsed;
};

const normalizeNumberMin = (value: unknown, min: number): number | undefined => {
  const parsed = normalizeFiniteNumber(value);
  if (parsed === undefined || parsed < min) return undefined;
  return parsed;
};

const normalizePositiveInteger = (value: unknown): number | undefined => {
  const parsed = normalizeFiniteNumber(value);
  if (parsed === undefined || parsed <= 0) return undefined;
  return Math.floor(parsed);
};

const normalizeIntegerMin = (value: unknown, min: number): number | undefined => {
  const parsed = normalizeNumberMin(value, min);
  return parsed === undefined ? undefined : Math.floor(parsed);
};

const normalizeIntegerInRange = (value: unknown, min: number, max: number): number | undefined => {
  const parsed = normalizeNumberInRange(value, min, max);
  return parsed === undefined ? undefined : Math.floor(parsed);
};

const normalizeStringMap = (value: unknown): string | Record<string, string> | undefined => {
  if (typeof value === 'string') {
    const normalized = normalizeString(value);
    return normalized || undefined;
  }
  if (!isPlainObject(value)) return undefined;
  const entries = Object.entries(value)
    .map(([key, entryValue]) => [normalizeString(key), normalizeString(entryValue)])
    .filter(([key, entryValue]) => key && entryValue);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const normalizeNumberMap = (value: unknown, min: number, max: number): number | Record<string, number> | undefined => {
  if (typeof value === 'number' || typeof value === 'string') {
    return normalizeNumberInRange(value, min, max);
  }
  if (!isPlainObject(value)) return undefined;
  const entries: Array<[string, number]> = [];
  for (const [key, entryValue] of Object.entries(value)) {
    const normalizedKey = normalizeString(key);
    const normalizedValue = normalizeNumberInRange(entryValue, min, max);
    if (normalizedKey && normalizedValue !== undefined) entries.push([normalizedKey, normalizedValue]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const normalizeTokenThresholdMap = (value: unknown): Record<string, number> | undefined => {
  if (!isPlainObject(value)) return undefined;
  const entries: Array<[string, number]> = [];
  for (const [key, entryValue] of Object.entries(value)) {
    const normalizedKey = normalizeString(key);
    const normalizedValue = normalizeIntegerInRange(entryValue, 5000, 2_000_000);
    if (normalizedKey && normalizedValue !== undefined) entries.push([normalizedKey, normalizedValue]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const normalizeFallbackModels = (value: unknown): MagicContextAgentFallbackModels | undefined => {
  if (typeof value === 'string') {
    const model = normalizeString(value);
    return model || undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .map((entry) => {
      if (typeof entry === 'string') return normalizeString(entry) || null;
      return isPlainObject(entry) ? normalizeString(entry.model) || null : null;
    })
    .filter(Boolean) as string[];
  return entries.length > 0 ? entries : undefined;
};

const normalizeBooleanRecord = (value: unknown): Record<string, boolean> | undefined => {
  if (!isPlainObject(value)) return undefined;
  const entries = Object.entries(value)
    .filter(([key, enabled]) => normalizeString(key) && typeof enabled === 'boolean')
    .map(([key, enabled]) => [normalizeString(key), enabled as boolean]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const assignString = (target: Record<string, unknown>, input: Record<string, unknown>, key: string) => {
  if (!hasOwn(input, key)) return;
  const value = normalizeString(input[key]);
  if (value) target[key] = value;
};

const assignNumber = (target: Record<string, unknown>, input: Record<string, unknown>, key: string, min: number, max: number) => {
  if (!hasOwn(input, key)) return;
  const value = normalizeNumberInRange(input[key], min, max);
  if (value !== undefined) target[key] = value;
};

const assignPositiveInteger = (target: Record<string, unknown>, input: Record<string, unknown>, key: string) => {
  if (!hasOwn(input, key)) return;
  const value = normalizePositiveInteger(input[key]);
  if (value !== undefined) target[key] = value;
};

function normalizeAgentConfig(input: unknown, extra?: (result: MagicContextAgentConfig, input: Record<string, unknown>) => void): MagicContextAgentConfig | undefined {
  if (!isPlainObject(input)) return undefined;
  const result: MagicContextAgentConfig = {};

  assignString(result, input, 'model');
  assignString(result, input, 'variant');
  assignString(result, input, 'thinking_level');
  assignString(result, input, 'prompt');
  assignString(result, input, 'description');
  assignNumber(result, input, 'temperature', 0, 2);
  assignNumber(result, input, 'top_p', 0, 1);
  assignPositiveInteger(result, input, 'maxTokens');
  assignPositiveInteger(result, input, 'maxSteps');

  const fallbackModels = normalizeFallbackModels(input.fallback_models);
  if (fallbackModels !== undefined) result.fallback_models = fallbackModels;
  const tools = normalizeBooleanRecord(input.tools);
  if (tools) result.tools = tools;
  const mode = normalizeString(input.mode);
  if (AGENT_MODES.has(mode)) result.mode = mode;
  const color = normalizeString(input.color);
  if (/^#[0-9A-Fa-f]{6}$/.test(color)) result.color = color;
  if (typeof input.disable === 'boolean') result.disable = input.disable;
  if (isPlainObject(input.permission) && Object.keys(input.permission).length > 0) result.permission = cloneJson(input.permission);
  extra?.(result, input);
  return Object.keys(result).length > 0 ? result : undefined;
}

function windowToCron(schedule: unknown): string {
  if (typeof schedule !== 'string') return DEFAULT_BASE_CRON;
  const match = /^(\d{1,2}):(\d{2})\s*-/.exec(schedule.trim());
  if (!match) return DEFAULT_BASE_CRON;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour >= 24 || minute >= 60) return DEFAULT_BASE_CRON;
  return `${minute} ${hour} * * *`;
}

function cronIntervalScore(schedule: string): number {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return Number.POSITIVE_INFINITY;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (month !== '*') return 366 * 24 * 60;
  if (dayOfMonth !== '*') return 31 * 24 * 60;
  if (dayOfWeek !== '*') return 7 * 24 * 60;
  const everyHour = /^\*\/(\d+)$/.exec(hour ?? '');
  if (everyHour) return Math.max(1, Number(everyHour[1])) * 60;
  if (hour === '*') {
    const everyMinute = /^\*\/(\d+)$/.exec(minute ?? '');
    return everyMinute ? Math.max(1, Number(everyMinute[1])) : 60;
  }
  return 24 * 60;
}

function mostFrequentSchedule(schedules: string[]): string {
  const enabled = schedules.map((schedule) => normalizeString(schedule)).filter(Boolean);
  if (enabled.length === 0) return '';
  return enabled.sort((a, b) => cronIntervalScore(a) - cronIntervalScore(b))[0] ?? '';
}

function withoutBroadInterval(entry: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...entry };
  delete rest.broad_interval_days;
  return rest;
}

function isEnabledSchedule(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function reconcileV2TasksObject(
  rawConfig: Record<string, unknown>,
  dreamer: Record<string, unknown>,
  tasksObject: Record<string, unknown>,
): Record<string, unknown> {
  const hasVerifyBroad = hasOwn(tasksObject, 'verify-broad');
  const hasBroadIntervalAnywhere = Object.values(tasksObject).some((entry) => isPlainObject(entry) && hasOwn(entry, 'broad_interval_days'));
  const hasStaleKeyFiles = hasOwn(tasksObject, 'key-files');
  if (hasVerifyBroad && !hasBroadIntervalAnywhere && !hasStaleKeyFiles) return rawConfig;
  const nextTasks: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tasksObject)) {
    if (key === 'key-files') continue;
    nextTasks[key] = isPlainObject(value) ? withoutBroadInterval(value) : value;
  }
  if (!hasVerifyBroad) {
    const verify = isPlainObject(tasksObject.verify) ? tasksObject.verify : undefined;
    nextTasks['verify-broad'] = { schedule: isEnabledSchedule(verify?.schedule) ? DEFAULT_VERIFY_BROAD_CRON : '' };
  }
  return { ...rawConfig, dreamer: { ...dreamer, tasks: nextTasks } };
}

function migrateDreamerV2(rawConfig: Record<string, unknown>): Record<string, unknown> {
  const dreamer = isPlainObject(rawConfig.dreamer) ? rawConfig.dreamer : undefined;
  if (!dreamer) return rawConfig;
  const tasksObject = isPlainObject(dreamer.tasks) ? dreamer.tasks : undefined;
  const hasRetiredObjectTasks = tasksObject ? RETIRED_OBJECT_MEMORY_TASKS.some((task) => hasOwn(tasksObject, task)) : false;

  if (tasksObject && !hasRetiredObjectTasks) {
    const hasLegacyOutsideTasks = hasOwn(dreamer, 'schedule')
      || hasOwn(dreamer, 'user_memories')
      || hasOwn(dreamer, 'pin_key_files')
      || hasOwn(dreamer, 'task_timeout_minutes')
      || hasOwn(dreamer, 'max_runtime_minutes');
    if (!hasLegacyOutsideTasks) return reconcileV2TasksObject(rawConfig, dreamer, tasksObject);
  }

  const hasLegacy = hasOwn(dreamer, 'schedule')
    || Array.isArray(dreamer.tasks)
    || hasRetiredObjectTasks
    || hasOwn(dreamer, 'user_memories')
    || hasOwn(dreamer, 'pin_key_files')
    || hasOwn(dreamer, 'task_timeout_minutes')
    || hasOwn(dreamer, 'max_runtime_minutes');
  if (!hasLegacy) return rawConfig;

  const baseCron = windowToCron(dreamer.schedule);
  const timeout = typeof dreamer.task_timeout_minutes === 'number' ? dreamer.task_timeout_minutes : undefined;
  const withTimeout = <T extends Record<string, unknown>>(entry: T): T => (timeout !== undefined ? { ...entry, timeout_minutes: timeout } : entry);
  const classifySchedule = dreamer.disable === true ? '' : DEFAULT_CLASSIFY_CRON;
  const retrospectiveSchedule = dreamer.disable === true ? '' : DEFAULT_RETROSPECTIVE_CRON;
  const tasks: Record<string, Record<string, unknown>> = {};

  if (tasksObject) {
    for (const [key, value] of Object.entries(tasksObject)) {
      if (RETIRED_OBJECT_MEMORY_TASKS.includes(key)) continue;
      if (isPlainObject(value)) tasks[key] = { ...value };
    }
    const maintainMemoryEntry = isPlainObject(tasksObject['maintain-memory']) ? tasksObject['maintain-memory'] : undefined;
    if (maintainMemoryEntry) {
      const schedule = typeof maintainMemoryEntry.schedule === 'string' ? maintainMemoryEntry.schedule : baseCron;
      tasks.verify = withTimeout({ ...withoutBroadInterval(maintainMemoryEntry), ...(tasks.verify ?? {}), schedule: tasks.verify?.schedule ?? schedule });
      tasks.curate = withTimeout({ ...withoutBroadInterval(maintainMemoryEntry), ...(tasks.curate ?? {}), schedule: tasks.curate?.schedule ?? schedule });
    }
    const oldVerifyEntry = isPlainObject(tasksObject[OLD_VERIFY_TASK]) ? tasksObject[OLD_VERIFY_TASK] : undefined;
    if (oldVerifyEntry) {
      tasks.verify = withTimeout({
        ...withoutBroadInterval(oldVerifyEntry),
        ...(tasks.verify ?? {}),
        schedule: tasks.verify?.schedule ?? (typeof oldVerifyEntry.schedule === 'string' ? oldVerifyEntry.schedule : baseCron),
      });
    }
    if (!tasks['verify-broad']) {
      tasks['verify-broad'] = withTimeout({ schedule: isEnabledSchedule(tasks.verify?.schedule) ? DEFAULT_VERIFY_BROAD_CRON : '' });
    }
    const oldCurateEntries = OLD_CURATE_TASKS
      .map((task) => (isPlainObject(tasksObject[task]) ? tasksObject[task] : null))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));
    if (oldCurateEntries.length > 0) {
      tasks.curate = withTimeout({
        ...(tasks.curate ?? {}),
        schedule: mostFrequentSchedule(oldCurateEntries.map((entry) => (typeof entry.schedule === 'string' ? entry.schedule : baseCron))),
      });
    }
    for (const task of CANONICAL_DREAMER_TASKS) {
      if (!tasks[task]) {
        const schedule = task === 'verify' || task === 'curate' || task === 'verify-broad'
          ? ''
          : task === 'classify-memories'
            ? classifySchedule
            : task === 'retrospective'
              ? retrospectiveSchedule
              : task === 'maintain-docs'
                ? ''
                : baseCron;
        tasks[task] = withTimeout({ schedule });
      }
    }
  } else {
    const legacyArray = Array.isArray(dreamer.tasks) ? dreamer.tasks.filter((task): task is string => typeof task === 'string') : null;
    const verifySelected = legacyArray ? legacyArray.includes(OLD_VERIFY_TASK) : true;
    const curateSelected = legacyArray ? legacyArray.some((task) => OLD_CURATE_TASKS.includes(task)) : true;
    tasks.verify = withTimeout({ schedule: verifySelected ? baseCron : '' });
    tasks['verify-broad'] = withTimeout({ schedule: verifySelected ? DEFAULT_VERIFY_BROAD_CRON : '' });
    tasks.curate = withTimeout({ schedule: curateSelected ? baseCron : '' });
    tasks['classify-memories'] = withTimeout({ schedule: classifySchedule });
    tasks.retrospective = withTimeout({ schedule: retrospectiveSchedule });
    tasks['maintain-docs'] = withTimeout({ schedule: legacyArray?.includes('maintain-docs') ? baseCron : '' });
  }

  tasks['map-memories'] ??= withTimeout({ schedule: baseCron });
  tasks['evaluate-smart-notes'] ??= withTimeout({ schedule: baseCron });
  const userMemories = isPlainObject(dreamer.user_memories) ? dreamer.user_memories : undefined;
  const userMemoriesEnabled = userMemories ? userMemories.enabled !== false : true;
  if (userMemories || !tasks['review-user-memories']) {
    tasks['review-user-memories'] = withTimeout({
      ...(tasks['review-user-memories'] ?? {}),
      schedule: userMemoriesEnabled ? baseCron : '',
      ...(userMemories && typeof userMemories.promotion_threshold === 'number' ? { promotion_threshold: userMemories.promotion_threshold } : {}),
    });
  }

  const rest = { ...dreamer };
  delete rest.schedule;
  delete rest.tasks;
  delete rest.task_timeout_minutes;
  delete rest.max_runtime_minutes;
  delete rest.user_memories;
  delete rest.pin_key_files;
  return { ...rawConfig, dreamer: { ...rest, tasks } };
}

const coerceToEnabledObject = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value === 'boolean') return { enabled: value };
  if (isPlainObject(value)) return { ...value };
  return undefined;
};

function migrateLegacyExperimental(input: Record<string, unknown>): Record<string, unknown> {
  const experimental = isPlainObject(input.experimental) ? input.experimental : undefined;
  if (!experimental) return input;
  const patched: Record<string, unknown> = { ...input };
  const memory = isPlainObject(patched.memory) ? { ...patched.memory } : {};
  if (hasOwn(experimental, 'temporal_awareness') && !hasOwn(patched, 'temporal_awareness')) patched.temporal_awareness = experimental.temporal_awareness;
  if (hasOwn(experimental, 'caveman_text_compression') && !hasOwn(patched, 'caveman_text_compression')) patched.caveman_text_compression = experimental.caveman_text_compression;
  for (const key of ['auto_search', 'git_commit_indexing']) {
    if (!hasOwn(experimental, key)) continue;
    const oldValue = experimental[key];
    const existing = memory[key];
    if (existing === undefined) {
      memory[key] = oldValue;
    } else if (isPlainObject(oldValue) && isPlainObject(existing)) {
      memory[key] = { ...oldValue, ...existing };
    }
  }
  if (Object.keys(memory).length > 0) patched.memory = memory;

  // Relocate graduated dreamer-owned keys (v0.14): experimental.user_memories
  // and experimental.pin_key_files → dreamer.user_memories /
  // dreamer.pin_key_files, so migrateDreamerV2 can consume them. Primitive
  // shorthand is coerced to { enabled: <bool> }; when both source and
  // destination are objects, destination wins but source-only sub-fields are
  // preserved (matches the plugin's migrate-experimental semantics). The
  // `experimental` branch itself is retired and dropped later by sanitize.
  if (hasOwn(experimental, 'user_memories') || hasOwn(experimental, 'pin_key_files')) {
    const dreamer = isPlainObject(patched.dreamer) ? { ...patched.dreamer } : {};
    for (const key of ['user_memories', 'pin_key_files']) {
      if (!hasOwn(experimental, key)) continue;
      const oldValue = coerceToEnabledObject(experimental[key]);
      if (oldValue === undefined) continue;
      const existing = dreamer[key];
      if (existing === undefined) {
        dreamer[key] = oldValue;
      } else if (isPlainObject(existing)) {
        dreamer[key] = { ...oldValue, ...existing };
      } else if (typeof existing === 'boolean') {
        dreamer[key] = { ...oldValue, enabled: existing };
      }
    }
    patched.dreamer = dreamer;
  }
  return patched;
}

function migrateLegacyAgentEnabled(input: Record<string, unknown>): Record<string, unknown> {
  let patched = input;
  for (const agentName of ['dreamer', 'sidekick', 'historian']) {
    const agent = isPlainObject(patched[agentName]) ? { ...patched[agentName] } : undefined;
    if (!agent || !hasOwn(agent, 'enabled')) continue;
    const enabled = agent.enabled;
    delete agent.enabled;
    if (agentName !== 'historian' && agent.disable !== true && enabled === false) agent.disable = true;
    patched = { ...patched, [agentName]: agent };
  }
  return patched;
}

function migrateMagicContextConfigInput(input: Record<string, unknown>): Record<string, unknown> {
  return migrateLegacyAgentEnabled(migrateDreamerV2(migrateLegacyExperimental(input)));
}

function normalizeDreamTaskConfig(value: unknown): MagicContextDreamTaskConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  const result: Record<string, unknown> = {};
  if (hasOwn(value, 'schedule')) result.schedule = normalizeString(value.schedule);
  assignString(result, value, 'model');
  const fallbackModels = normalizeFallbackModels(value.fallback_models);
  if (fallbackModels !== undefined) result.fallback_models = fallbackModels;
  assignString(result, value, 'thinking_level');
  const timeout = normalizeIntegerMin(value.timeout_minutes, 5);
  if (timeout !== undefined) result.timeout_minutes = timeout;
  const promotionThreshold = normalizeIntegerInRange(value.promotion_threshold, 2, 20);
  if (promotionThreshold !== undefined) result.promotion_threshold = promotionThreshold;
  return mergePreservingUnknown<MagicContextDreamTaskConfig>(value, result, DREAM_TASK_CONFIG_KNOWN_KEYS);
}

function normalizeDreamerTasks(value: unknown): Record<string, MagicContextDreamTaskConfig> | undefined {
  if (!isPlainObject(value)) return undefined;
  const result: Record<string, MagicContextDreamTaskConfig> = {};
  for (const [taskName, taskConfig] of Object.entries(value)) {
    if (taskName === 'key-files') continue;
    const normalized = normalizeDreamTaskConfig(taskConfig);
    if (normalized && (CURRENT_DREAMER_TASKS.has(taskName) || isPlainObject(taskConfig))) result[taskName] = normalized;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeDreamerConfig(value: unknown): MagicContextConfig['dreamer'] | undefined {
  const normalized = normalizeAgentConfig(value, (result, input) => {
    if (typeof input.inject_docs === 'boolean') result.inject_docs = input.inject_docs;
    const tasks = normalizeDreamerTasks(input.tasks);
    if (tasks) result.tasks = tasks;
  });
  return mergePreservingUnknown<MagicContextConfig['dreamer'] & Record<string, unknown>>(value, normalized, DREAMER_KNOWN_KEYS) as MagicContextConfig['dreamer'] | undefined;
}

function normalizeSidekickConfig(value: unknown): MagicContextConfig['sidekick'] | undefined {
  const normalized = normalizeAgentConfig(value, (result, input) => {
    const timeout = normalizeIntegerMin(input.timeout_ms, 1);
    if (timeout !== undefined) result.timeout_ms = timeout;
    assignString(result, input, 'system_prompt');
  });
  return mergePreservingUnknown<MagicContextConfig['sidekick'] & Record<string, unknown>>(value, normalized, SIDEKICK_KNOWN_KEYS) as MagicContextConfig['sidekick'] | undefined;
}

const normalizeObjectWithFields = (
  value: unknown,
  builder: (result: Record<string, unknown>, input: Record<string, unknown>) => void,
  knownKeys?: Set<string>,
): Record<string, unknown> | undefined => {
  if (!isPlainObject(value)) return undefined;
  const result: Record<string, unknown> = {};
  builder(result, value);
  if (knownKeys) return mergePreservingUnknown(value, result, knownKeys);
  return Object.keys(result).length > 0 ? result : undefined;
};

function normalizeAutoSearch(value: unknown): Record<string, unknown> | undefined {
  return normalizeObjectWithFields(value, (target, source) => {
    if (typeof source.enabled === 'boolean') target.enabled = source.enabled;
    const threshold = normalizeNumberInRange(source.score_threshold, 0.3, 0.95);
    if (threshold !== undefined) target.score_threshold = threshold;
    const minChars = normalizeIntegerInRange(source.min_prompt_chars, 5, 500);
    if (minChars !== undefined) target.min_prompt_chars = minChars;
  }, AUTO_SEARCH_KNOWN_KEYS);
}

function normalizeGitCommitIndexing(value: unknown): Record<string, unknown> | undefined {
  return normalizeObjectWithFields(value, (target, source) => {
    if (typeof source.enabled === 'boolean') target.enabled = source.enabled;
    const sinceDays = normalizeIntegerInRange(source.since_days, 7, 3650);
    if (sinceDays !== undefined) target.since_days = sinceDays;
    const maxCommits = normalizeIntegerInRange(source.max_commits, 100, 20000);
    if (maxCommits !== undefined) target.max_commits = maxCommits;
  }, GIT_COMMIT_INDEXING_KNOWN_KEYS);
}

export function normalizeMagicContextConfig(input: unknown): MagicContextConfig {
  if (!isPlainObject(input)) return {};
  const migratedInput = migrateMagicContextConfigInput(input);
  const result: MagicContextConfig = {};

  const schema = normalizeString(migratedInput.$schema);
  if (schema) result.$schema = MAGIC_CONTEXT_SCHEMA_URL;
  if (typeof migratedInput.enabled === 'boolean') result.enabled = migratedInput.enabled;
  if (typeof migratedInput.auto_update === 'boolean') result.auto_update = migratedInput.auto_update;
  if (typeof migratedInput.ctx_reduce_enabled === 'boolean') result.ctx_reduce_enabled = migratedInput.ctx_reduce_enabled;
  if (typeof migratedInput.temporal_awareness === 'boolean') result.temporal_awareness = migratedInput.temporal_awareness;
  if (typeof migratedInput.keep_subagents === 'boolean') result.keep_subagents = migratedInput.keep_subagents;

  const cacheTtl = normalizeStringMap(migratedInput.cache_ttl);
  if (cacheTtl !== undefined) result.cache_ttl = cacheTtl;
  const toastDuration = normalizeIntegerInRange(migratedInput.toast_duration_ms, 0, 60000);
  if (toastDuration !== undefined) result.toast_duration_ms = toastDuration;
  const executeThresholdPercentage = normalizeNumberMap(migratedInput.execute_threshold_percentage, 20, 80);
  if (executeThresholdPercentage !== undefined) result.execute_threshold_percentage = executeThresholdPercentage;
  const executeThresholdTokens = normalizeTokenThresholdMap(migratedInput.execute_threshold_tokens);
  if (executeThresholdTokens !== undefined) result.execute_threshold_tokens = executeThresholdTokens;
  const protectedTags = normalizeIntegerInRange(migratedInput.protected_tags, 1, 100);
  if (protectedTags !== undefined) result.protected_tags = protectedTags;
  const clearReasoningAge = normalizeIntegerMin(migratedInput.clear_reasoning_age, 10);
  if (clearReasoningAge !== undefined) result.clear_reasoning_age = clearReasoningAge;
  const historyBudget = normalizeNumberInRange(migratedInput.history_budget_percentage, 0.05, 0.5);
  if (historyBudget !== undefined) result.history_budget_percentage = historyBudget;
  const historianTimeout = normalizeIntegerMin(migratedInput.historian_timeout_ms, 60000);
  if (historianTimeout !== undefined) result.historian_timeout_ms = historianTimeout;

  const commitClusterTrigger = normalizeObjectWithFields(migratedInput.commit_cluster_trigger, (target, source) => {
    if (typeof source.enabled === 'boolean') target.enabled = source.enabled;
    const minClusters = normalizeIntegerMin(source.min_clusters, 1);
    if (minClusters !== undefined) target.min_clusters = minClusters;
  }, COMMIT_CLUSTER_KNOWN_KEYS);
  if (commitClusterTrigger) result.commit_cluster_trigger = commitClusterTrigger;
  const sqlite = normalizeObjectWithFields(migratedInput.sqlite, (target, source) => {
    const cacheSize = normalizeIntegerInRange(source.cache_size_mb, 2, 2048);
    if (cacheSize !== undefined) target.cache_size_mb = cacheSize;
    const mmapSize = normalizeIntegerInRange(source.mmap_size_mb, 0, 8192);
    if (mmapSize !== undefined) target.mmap_size_mb = mmapSize;
  }, SQLITE_KNOWN_KEYS);
  if (sqlite) result.sqlite = sqlite;

  const systemPromptInjection = normalizeObjectWithFields(migratedInput.system_prompt_injection, (target, source) => {
    if (typeof source.enabled === 'boolean') target.enabled = source.enabled;
    if (Array.isArray(source.skip_signatures)) {
      const signatures = source.skip_signatures.map(normalizeString).filter(Boolean);
      if (signatures.length > 0) target.skip_signatures = Array.from(new Set(signatures));
    }
  }, SYSTEM_PROMPT_INJECTION_KNOWN_KEYS);
  if (systemPromptInjection) result.system_prompt_injection = systemPromptInjection;
  const caveman = normalizeObjectWithFields(migratedInput.caveman_text_compression, (target, source) => {
    if (typeof source.enabled === 'boolean') target.enabled = source.enabled;
    const minChars = normalizeIntegerInRange(source.min_chars, 100, 10000);
    if (minChars !== undefined) target.min_chars = minChars;
  }, CAVEMAN_TEXT_COMPRESSION_KNOWN_KEYS);
  if (caveman) result.caveman_text_compression = caveman;

  const historian = normalizeAgentConfig(migratedInput.historian, (target, source) => {
    if (typeof source.two_pass === 'boolean') target.two_pass = source.two_pass;
    if (Array.isArray(source.disallowed_tools)) {
      const disallowedTools = source.disallowed_tools.map(normalizeString).filter((tool) => HISTORIAN_DISALLOWED_TOOLS.has(tool));
      if (disallowedTools.length > 0) target.disallowed_tools = Array.from(new Set(disallowedTools));
    }
  });
  const mergedHistorian = mergePreservingUnknown<MagicContextConfig['historian'] & Record<string, unknown>>(migratedInput.historian, historian, HISTORIAN_KNOWN_KEYS);
  if (mergedHistorian) result.historian = mergedHistorian as MagicContextConfig['historian'];
  const dreamer = normalizeDreamerConfig(migratedInput.dreamer);
  if (dreamer) result.dreamer = dreamer;
  const sidekick = normalizeSidekickConfig(migratedInput.sidekick);
  if (sidekick) result.sidekick = sidekick;

  const embedding = normalizeObjectWithFields(migratedInput.embedding, (target, source) => {
    const provider = normalizeString(source.provider);
    if (EMBEDDING_PROVIDERS.has(provider)) target.provider = provider;
    const model = normalizeString(source.model);
    if (model) target.model = model;
    const endpoint = normalizeString(source.endpoint);
    if (endpoint) target.endpoint = endpoint;
    const apiKey = normalizeString(source.api_key);
    if (apiKey) target.api_key = apiKey;
    const inputType = normalizeString(source.input_type);
    if (inputType) target.input_type = inputType;
    const queryInputType = normalizeString(source.query_input_type);
    if (queryInputType) target.query_input_type = queryInputType;
    const truncate = normalizeString(source.truncate);
    if (truncate) target.truncate = truncate;
    const maxInputTokens = normalizePositiveInteger(source.max_input_tokens);
    if (maxInputTokens !== undefined) target.max_input_tokens = maxInputTokens;
  }, EMBEDDING_KNOWN_KEYS);
  if (embedding) result.embedding = embedding;

  const memory = normalizeObjectWithFields(migratedInput.memory, (target, source) => {
    if (typeof source.enabled === 'boolean') target.enabled = source.enabled;
    if (typeof source.auto_promote === 'boolean') target.auto_promote = source.auto_promote;
    const budget = normalizeIntegerInRange(source.injection_budget_tokens, 500, 20000);
    if (budget !== undefined) target.injection_budget_tokens = budget;
    const threshold = normalizeIntegerMin(source.retrieval_count_promotion_threshold, 1);
    if (threshold !== undefined) target.retrieval_count_promotion_threshold = threshold;
    const autoSearch = normalizeAutoSearch(source.auto_search);
    if (autoSearch) target.auto_search = autoSearch;
    const gitCommitIndexing = normalizeGitCommitIndexing(source.git_commit_indexing);
    if (gitCommitIndexing) target.git_commit_indexing = gitCommitIndexing;
  }, MEMORY_KNOWN_KEYS);
  if (memory) result.memory = memory;

  if (isPlainObject(migratedInput.command)) result.command = cloneJson(migratedInput.command);
  if (Array.isArray(migratedInput.disabled_hooks)) {
    const hooks = migratedInput.disabled_hooks.map(normalizeString).filter(Boolean);
    if (hooks.length > 0) result.disabled_hooks = Array.from(new Set(hooks));
  }

  for (const [key, value] of Object.entries(migratedInput)) {
    if (!CURRENT_TOP_LEVEL_KEY_SET.has(key) && !RETIRED_TOP_LEVEL_KEYS.has(key)) result[key] = cloneJson(value);
  }

  return result;
}

export function agentFallbackModelsToRows(value: unknown): MagicContextFallbackRow[] {
  const entries = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  return entries
    .map((entry, index) => {
      const model = typeof entry === 'string'
        ? entry
        : isPlainObject(entry)
          ? normalizeString(entry.model)
          : '';
      return { id: `fallback-${index}`, model };
    })
    .filter((row) => normalizeString(row.model));
}

export function agentFallbackRowsToConfig(rows: MagicContextFallbackRow[]): MagicContextAgentFallbackModels | undefined {
  const entries = rows.map((row) => normalizeString(row.model)).filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

export function createMagicContextDraftFromConfig(config: MagicContextConfigResponseLike | null | undefined): MagicContextConfig {
  // Initialize the draft from the migrated/normalized effective config so UI
  // controls read v2 schema (e.g. dreamer.disable instead of legacy
  // dreamer.enabled=false, v2 tasks object instead of legacy array/window).
  // Unknown future fields survive normalization; the save payload still
  // re-normalizes and strips retired keys before writing.
  return normalizeMagicContextConfig(config?.raw ?? {});
}

export function buildMagicContextSavePayload(
  expectedMtimeMs: number | null,
  draft: MagicContextConfig,
  source?: MagicContextConfigSourceLike | null,
): MagicContextSavePayload {
  const normalized = normalizeMagicContextConfig(draft);
  const config: MagicContextConfig = {};

  for (const key of Object.keys(normalized)) {
    if (!RETIRED_TOP_LEVEL_KEYS.has(key)) config[key] = normalized[key];
  }
  for (const key of TOP_LEVEL_MAGIC_CONTEXT_KEYS) {
    if (!hasOwn(draft, key) || RETIRED_TOP_LEVEL_KEYS.has(key)) continue;
    if (!hasOwn(normalized, key)) config[key] = draft[key];
  }

  return {
    expectedMtimeMs,
    sourcePath: source?.path ?? null,
    sourceMtimeMs: source?.mtimeMs ?? null,
    config,
  };
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

export function stableStringifyMagicContext(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function hasMagicContextDraftChanges(initial: MagicContextConfig, draft: MagicContextConfig): boolean {
  return stableStringifyMagicContext(normalizeMagicContextConfig(initial)) !== stableStringifyMagicContext(normalizeMagicContextConfig(draft));
}

export function parseModelRef(model: string | undefined | null): { providerId: string; modelId: string } {
  const normalized = normalizeString(model);
  const slashIndex = normalized.indexOf('/');
  if (slashIndex <= 0 || slashIndex === normalized.length - 1) return { providerId: '', modelId: normalized };
  return { providerId: normalized.slice(0, slashIndex), modelId: normalized.slice(slashIndex + 1) };
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
