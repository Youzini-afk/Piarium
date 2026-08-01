import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  applyEdits,
  modify as modifyJsonc,
  parse as parseJsonc,
  printParseErrorCode,
} from 'jsonc-parser';

const PLUGIN_NAME = 'opencode-magic-context';
const OFFICIAL_NPM_PLUGIN_NAME = '@cortexkit/opencode-magic-context';
const YOUZINI_NPM_PLUGIN_NAME = '@youzini/opencode-magic-context';
const MAGIC_CONTEXT_PLUGIN_NAMES = new Set([PLUGIN_NAME, OFFICIAL_NPM_PLUGIN_NAME, YOUZINI_NPM_PLUGIN_NAME]);
const CONFIG_BASENAME = 'magic-context';
const SCHEMA_URL = 'https://raw.githubusercontent.com/cortexkit/magic-context/master/assets/magic-context.schema.json';
const TUI_PLUGIN_NAMES = MAGIC_CONTEXT_PLUGIN_NAMES;
const OMO_PLUGIN_NAMES = new Set(['oh-my-openagent', 'oh-my-opencode']);
const OMO_CONFIG_BASENAMES = ['oh-my-openagent', 'oh-my-opencode'];
const CONFLICTING_OMO_HOOKS = [
  'context-window-monitor',
  'preemptive-compaction',
  'anthropic-context-window-limit-recovery',
];

const JSONC_FORMATTING_OPTIONS = {
  insertSpaces: true,
  tabSize: 2,
  eol: '\n',
};

const TOP_LEVEL_KEYS = [
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

const RETIRED_TOP_LEVEL_KEYS = new Set([
  'nudge_interval_tokens',
  'auto_drop_tool_age',
  'drop_tool_structure',
  'iteration_nudge_threshold',
  'compaction_markers',
  'compressor',
  'experimental',
]);
const CURRENT_TOP_LEVEL_KEY_SET = new Set(TOP_LEVEL_KEYS);
const OLD_VERIFY_TASK = 'verify';
const OLD_CURATE_TASKS = ['consolidate', 'archive-stale', 'improve'];
const RETIRED_OBJECT_MEMORY_TASKS = ['maintain-memory', ...OLD_CURATE_TASKS];
const CANONICAL_DREAMER_TASKS = [
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
];
const CANONICAL_DREAMER_TASK_SET = new Set(CANONICAL_DREAMER_TASKS);
const DEFAULT_BASE_CRON = '0 2 * * *';
const DEFAULT_CLASSIFY_CRON = '0 6 * * *';
const DEFAULT_RETROSPECTIVE_CRON = '0 5 * * *';
const DEFAULT_VERIFY_BROAD_CRON = '0 4 * * 0';
const DEFAULT_TASK_SCHEDULES = {
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
const EMBEDDING_PROVIDERS = new Set(['local', 'openai-compatible', 'off']);
const AGENT_MODES = new Set(['subagent', 'primary', 'all']);
const PERMISSION_VALUES = new Set(['ask', 'allow', 'deny']);
const HISTORIAN_DISALLOWED_TOOLS = new Set(['*', 'read', 'aft_outline', 'aft_zoom', 'aft_search']);
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

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasOwn(input, key) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function mergePreservingUnknown(input, sanitized, knownKeys) {
  if (!isPlainObject(input)) {
    return sanitized && Object.keys(sanitized).length > 0 ? sanitized : undefined;
  }

  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (!knownKeys.has(key)) {
      result[key] = cloneJson(value);
    }
  }

  if (isPlainObject(sanitized)) {
    for (const [key, value] of Object.entries(sanitized)) {
      if (value !== undefined) {
        result[key] = value;
      }
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function getPluginEntryName(entry) {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0];
  return '';
}

function getPackageName(entry) {
  const entryName = getPluginEntryName(entry);
  if (!entryName) return '';
  const trimmed = entryName.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('.') || trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return path.basename(trimmed).replace(/\.(js|mjs|cjs|ts|tgz|tar\.gz)$/i, '');
  }
  if (trimmed.startsWith('@')) {
    const parts = trimmed.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1].split('@')[0]}` : trimmed;
  }
  return trimmed.split('/')[0].split('@')[0];
}

function matchesMagicContextPlugin(entry) {
  const entryName = getPluginEntryName(entry).toLowerCase();
  const packageName = getPackageName(entry);
  return MAGIC_CONTEXT_PLUGIN_NAMES.has(packageName)
    || entryName.includes('opencode-magic-context')
    || entryName.includes('magic-context/packages/plugin');
}

function matchesOmoPlugin(entry) {
  const packageName = getPackageName(entry);
  return OMO_PLUGIN_NAMES.has(packageName);
}

function normalizeFiniteNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  const normalized = normalizeString(value);
  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeNumberInRange(value, min, max) {
  const parsed = normalizeFiniteNumber(value);
  if (parsed === undefined || parsed < min || parsed > max) {
    return undefined;
  }
  return parsed;
}

function normalizeNumberMin(value, min) {
  const parsed = normalizeFiniteNumber(value);
  if (parsed === undefined || parsed < min) {
    return undefined;
  }
  return parsed;
}

function normalizePositiveInteger(value) {
  const parsed = normalizeFiniteNumber(value);
  if (parsed === undefined || parsed <= 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

function normalizeIntegerMin(value, min) {
  const parsed = normalizeNumberMin(value, min);
  if (parsed === undefined) {
    return undefined;
  }
  return Math.floor(parsed);
}

function normalizeIntegerInRange(value, min, max) {
  const parsed = normalizeNumberInRange(value, min, max);
  if (parsed === undefined) {
    return undefined;
  }
  return Math.floor(parsed);
}

function getOpenCodeConfigDir() {
  const envConfigDir = normalizeString(process.env.OPENCODE_CONFIG_DIR);
  if (envConfigDir) {
    return path.resolve(envConfigDir);
  }
  return path.join(getHomeDir(), '.config', 'opencode');
}

function getHomeDir() {
  return normalizeString(process.env.HOME)
    || normalizeString(process.env.USERPROFILE)
    || os.homedir();
}

function getXdgConfigHome() {
  const xdgConfigHome = normalizeString(process.env.XDG_CONFIG_HOME);
  // Match the magic-context plugin: only honor an absolute XDG_CONFIG_HOME.
  // Relative values fall back to HOME/.config so we never write under CWD.
  if (xdgConfigHome && path.isAbsolute(xdgConfigHome)) {
    return xdgConfigHome;
  }
  return path.join(getHomeDir(), '.config');
}

function getCortexKitConfigDir() {
  return path.join(getXdgConfigHome(), 'cortexkit');
}

function detectConfigFile(dir, basename = CONFIG_BASENAME) {
  const jsoncPath = path.join(dir, `${basename}.jsonc`);
  const jsonPath = path.join(dir, `${basename}.json`);

  if (fs.existsSync(jsoncPath)) {
    return { exists: true, format: 'jsonc', path: jsoncPath };
  }
  if (fs.existsSync(jsonPath)) {
    return { exists: true, format: 'json', path: jsonPath };
  }
  return { exists: false, format: 'jsonc', path: jsoncPath };
}

function withSourceMetadata(detection, legacy = false) {
  return {
    path: detection.path,
    exists: detection.exists,
    format: detection.format,
    mtimeMs: getFileMtimeMs(detection.path),
    legacy,
  };
}

function detectUserTargetConfigFile() {
  return detectConfigFile(getCortexKitConfigDir());
}

function detectUserLegacyConfigFile() {
  return detectConfigFile(getOpenCodeConfigDir());
}

function resolveUserConfigSource(targetDetection) {
  if (targetDetection.exists) {
    return { detection: targetDetection, legacy: false };
  }

  const legacyDetection = detectUserLegacyConfigFile();
  if (legacyDetection.exists) {
    return { detection: legacyDetection, legacy: true };
  }

  return { detection: targetDetection, legacy: false };
}

function detectProjectConfigFile(directory) {
  if (!directory) {
    return null;
  }

  const cortexKit = detectConfigFile(path.join(directory, '.cortexkit'));
  if (cortexKit.exists) {
    return { ...cortexKit, legacy: false };
  }

  const root = detectConfigFile(directory);
  if (root.exists) {
    return { ...root, legacy: true };
  }

  const dotOpenCode = detectConfigFile(path.join(directory, '.opencode'));
  if (dotOpenCode.exists) {
    return { ...dotOpenCode, legacy: true };
  }

  return {
    exists: false,
    format: 'jsonc',
    path: path.join(directory, '.cortexkit', 'magic-context.jsonc'),
    legacy: false,
  };
}

function parseJsoncObject(content, filePath) {
  const errors = [];
  const parsed = parseJsonc(content.replace(/^\uFEFF/, ''), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length > 0) {
    const message = errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(', ');
    throw new SyntaxError(`Failed to parse ${filePath}: ${message}`);
  }

  return isPlainObject(parsed) ? parsed : {};
}

function readJsoncFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }

  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.trim()) {
    return {};
  }

  return parseJsoncObject(content, filePath);
}

function getFileMtimeMs(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  return fs.statSync(filePath).mtimeMs;
}

function getOpenCodeConfigCandidates(directory) {
  const configDir = getOpenCodeConfigDir();
  const candidates = [
    path.join(configDir, 'opencode.jsonc'),
    path.join(configDir, 'opencode.json'),
  ];

  if (directory) {
    candidates.push(
      path.join(directory, '.opencode', 'opencode.jsonc'),
      path.join(directory, '.opencode', 'opencode.json'),
      path.join(directory, 'opencode.jsonc'),
      path.join(directory, 'opencode.json'),
    );
  }

  return candidates;
}

function getUserTuiConfigCandidates() {
  const configDir = getOpenCodeConfigDir();
  return [
    path.join(configDir, 'tui.jsonc'),
    path.join(configDir, 'tui.json'),
  ];
}

function getMagicContextRuntimeConfigDir() {
  return getCortexKitConfigDir();
}

function readPluginEntriesFromConfig(configPath) {
  if (!fs.existsSync(configPath)) return [];
  try {
    const config = readJsoncFile(configPath);
    return [
      ...(Array.isArray(config.plugin) ? config.plugin : []),
      ...(Array.isArray(config.plugins) ? config.plugins : []),
    ]
      .map(getPluginEntryName)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function findPluginEntry(directory) {
  for (const configPath of getOpenCodeConfigCandidates(directory)) {
    if (!fs.existsSync(configPath)) {
      continue;
    }

    try {
      const config = readJsoncFile(configPath);
      const pluginEntries = [
        ...(Array.isArray(config.plugin) ? config.plugin : []),
        ...(Array.isArray(config.plugins) ? config.plugins : []),
      ];
      const entry = pluginEntries.find((value) => {
        return matchesMagicContextPlugin(value);
      });

      if (entry) {
        const entryName = getPluginEntryName(entry);
        return {
          detected: true,
          entry: entryName,
          configPath,
        };
      }
    } catch {
      // Ignore malformed OpenCode config here; the dedicated config UI can surface that.
    }
  }

  return {
    detected: false,
    entry: null,
    configPath: null,
  };
}

function findTuiPluginEntry() {
  for (const configPath of getUserTuiConfigCandidates()) {
    for (const entry of readPluginEntriesFromConfig(configPath)) {
      if (matchesMagicContextPlugin(entry) || TUI_PLUGIN_NAMES.has(getPackageName(entry))) {
        return {
          detected: true,
          entry,
          configPath,
        };
      }
    }
  }

  return {
    detected: false,
    entry: null,
    configPath: null,
  };
}

function hasOmoPluginEntry(directory) {
  return getOpenCodeConfigCandidates(directory).some((configPath) => (
    readPluginEntriesFromConfig(configPath).some(matchesOmoPlugin)
  ));
}

function getOmoConfigPaths(directory) {
  const configDir = getOpenCodeConfigDir();
  const dirs = [configDir];
  if (directory) {
    dirs.push(directory, path.join(directory, '.opencode'));
  }
  const paths = [];
  for (const dir of dirs) {
    for (const basename of OMO_CONFIG_BASENAMES) {
      paths.push(path.join(dir, `${basename}.jsonc`), path.join(dir, `${basename}.json`));
    }
  }
  return paths;
}

function readOmoDisabledHooks(directory) {
  const disabledHooks = new Set();
  for (const configPath of getOmoConfigPaths(directory)) {
    if (!fs.existsSync(configPath)) continue;
    try {
      const config = readJsoncFile(configPath);
      if (Array.isArray(config.disabled_hooks)) {
        for (const hook of config.disabled_hooks) {
          const normalized = normalizeString(hook);
          if (normalized) disabledHooks.add(normalized);
        }
      }
    } catch {
      // Diagnostics are best-effort; malformed OMO configs are surfaced by their own settings page.
    }
  }
  return disabledHooks;
}

function buildDiagnostics(directory, projectConfig = {}, metadata = {}) {
  const tui = findTuiPluginEntry();
  const disabledHooks = readOmoDisabledHooks(directory);
  const omoInstalled = hasOmoPluginEntry(directory);
  const activeOmoHooks = omoInstalled
    ? CONFLICTING_OMO_HOOKS.filter((hook) => !disabledHooks.has(hook))
    : [];
  const uiConfigDir = getCortexKitConfigDir();
  const runtimeConfigDir = getMagicContextRuntimeConfigDir();
  const source = metadata.source ?? null;
  const target = metadata.target ?? null;
  const projectSource = metadata.projectSource ?? null;

  return {
    tui,
    omo: {
      detected: omoInstalled,
      activeConflictingHooks: activeOmoHooks,
      disabledConflictingHooks: CONFLICTING_OMO_HOOKS.filter((hook) => disabledHooks.has(hook)),
    },
    configPath: {
      uiConfigDir,
      runtimeConfigDir,
      matchesRuntime: true,
      legacyConfigDir: getOpenCodeConfigDir(),
    },
    source: source ? {
      path: source.path,
      exists: source.exists,
      format: source.format,
      mtimeMs: source.mtimeMs,
      legacy: source.legacy === true,
      targetPath: target?.path ?? null,
      differsFromTarget: Boolean(target?.path && source.path && path.resolve(source.path) !== path.resolve(target.path)),
    } : null,
    project: {
      ignoredUserOnlyKeys: hasOwn(projectConfig, 'auto_update') ? ['auto_update'] : [],
      source: projectSource,
      legacy: projectSource?.legacy === true,
    },
  };
}

function createConfigModifiedError() {
  const error = new Error('Config was modified outside OpenChamber. Reload before saving again.');
  error.code = 'CONFIG_MODIFIED';
  return error;
}

function hasMtimeMismatch(filePath, expectedMtimeMs) {
  if (expectedMtimeMs == null) {
    // The caller has no record of the file's mtime at page load (the target
    // was absent when the UI read the config). If the file now exists, it was
    // created concurrently by another process; reject the save rather than
    // overwriting unrelated state.
    return fs.existsSync(filePath);
  }

  const currentMtimeMs = getFileMtimeMs(filePath);
  if (currentMtimeMs == null) {
    return true;
  }

  return Math.abs(currentMtimeMs - expectedMtimeMs) > 1;
}

function normalizeStringMap(value) {
  if (typeof value === 'string') {
    const normalized = normalizeString(value);
    return normalized || undefined;
  }

  if (!isPlainObject(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .map(([key, entryValue]) => [normalizeString(key), normalizeString(entryValue)])
    .filter(([key, entryValue]) => key && entryValue);

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function normalizeNumberMap(value, min, max) {
  if (typeof value === 'number' || typeof value === 'string') {
    return normalizeNumberInRange(value, min, max);
  }

  if (!isPlainObject(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .map(([key, entryValue]) => [normalizeString(key), normalizeNumberInRange(entryValue, min, max)])
    .filter(([key, entryValue]) => key && entryValue !== undefined);

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function normalizeTokenThresholdMap(value) {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .map(([key, entryValue]) => [normalizeString(key), normalizeIntegerInRange(entryValue, 5000, 2_000_000)])
    .filter(([key, entryValue]) => key && entryValue !== undefined);

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function normalizeFallbackModels(value) {
  if (typeof value === 'string') {
    const model = normalizeString(value);
    return model || undefined;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries = value
    .map((entry) => {
      if (typeof entry === 'string') {
        return normalizeString(entry) || null;
      }
      return isPlainObject(entry) ? normalizeString(entry.model) || null : null;
    })
    .filter(Boolean);

  return entries.length > 0 ? entries : undefined;
}

function normalizeBooleanRecord(value) {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .filter(([key, enabled]) => normalizeString(key) && typeof enabled === 'boolean')
    .map(([key, enabled]) => [normalizeString(key), enabled]);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function windowToCron(schedule) {
  if (typeof schedule !== 'string') return DEFAULT_BASE_CRON;
  const match = /^(\d{1,2}):(\d{2})\s*-/.exec(schedule.trim());
  if (!match) return DEFAULT_BASE_CRON;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour >= 24 || minute >= 60) return DEFAULT_BASE_CRON;
  return `${minute} ${hour} * * *`;
}

function cronIntervalScore(schedule) {
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

function mostFrequentSchedule(schedules) {
  const enabled = schedules.map((schedule) => normalizeString(schedule)).filter(Boolean);
  if (enabled.length === 0) return '';
  return enabled.sort((a, b) => cronIntervalScore(a) - cronIntervalScore(b))[0] ?? '';
}

function withoutBroadInterval(entry) {
  const rest = { ...entry };
  delete rest.broad_interval_days;
  return rest;
}

function isEnabledSchedule(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function reconcileV2TasksObject(rawConfig, dreamer, tasksObject) {
  const hasVerifyBroad = hasOwn(tasksObject, 'verify-broad');
  const hasBroadIntervalAnywhere = Object.values(tasksObject).some((entry) => (
    isPlainObject(entry) && hasOwn(entry, 'broad_interval_days')
  ));
  const hasStaleKeyFiles = hasOwn(tasksObject, 'key-files');
  if (hasVerifyBroad && !hasBroadIntervalAnywhere && !hasStaleKeyFiles) return rawConfig;

  const nextTasks = {};
  for (const [key, value] of Object.entries(tasksObject)) {
    if (key === 'key-files') continue;
    nextTasks[key] = isPlainObject(value) ? withoutBroadInterval(value) : value;
  }
  if (!hasVerifyBroad) {
    const verify = isPlainObject(tasksObject.verify) ? tasksObject.verify : undefined;
    nextTasks['verify-broad'] = {
      schedule: isEnabledSchedule(verify?.schedule) ? DEFAULT_VERIFY_BROAD_CRON : '',
    };
  }
  return { ...rawConfig, dreamer: { ...dreamer, tasks: nextTasks } };
}

function migrateDreamerV2(rawConfig) {
  const dreamer = isPlainObject(rawConfig.dreamer) ? rawConfig.dreamer : undefined;
  if (!dreamer) return rawConfig;

  const tasksObject = isPlainObject(dreamer.tasks) ? dreamer.tasks : undefined;
  const hasRetiredObjectTasks = tasksObject
    ? RETIRED_OBJECT_MEMORY_TASKS.some((task) => hasOwn(tasksObject, task))
    : false;

  if (tasksObject && !hasRetiredObjectTasks) {
    const hasLegacyOutsideTasks = hasOwn(dreamer, 'schedule')
      || hasOwn(dreamer, 'user_memories')
      || hasOwn(dreamer, 'pin_key_files')
      || hasOwn(dreamer, 'task_timeout_minutes')
      || hasOwn(dreamer, 'max_runtime_minutes');
    if (!hasLegacyOutsideTasks) {
      return reconcileV2TasksObject(rawConfig, dreamer, tasksObject);
    }
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
  const timeout = typeof dreamer.task_timeout_minutes === 'number'
    ? dreamer.task_timeout_minutes
    : undefined;
  const withTimeout = (entry) => (timeout !== undefined ? { ...entry, timeout_minutes: timeout } : entry);
  const classifySchedule = dreamer.disable === true ? '' : DEFAULT_CLASSIFY_CRON;
  const retrospectiveSchedule = dreamer.disable === true ? '' : DEFAULT_RETROSPECTIVE_CRON;
  const tasks = {};

  if (tasksObject) {
    for (const [key, value] of Object.entries(tasksObject)) {
      if (RETIRED_OBJECT_MEMORY_TASKS.includes(key)) continue;
      if (isPlainObject(value)) tasks[key] = { ...value };
    }

    const maintainMemoryEntry = isPlainObject(tasksObject['maintain-memory']) ? tasksObject['maintain-memory'] : undefined;
    if (maintainMemoryEntry) {
      const schedule = typeof maintainMemoryEntry.schedule === 'string' ? maintainMemoryEntry.schedule : baseCron;
      tasks.verify = withTimeout({
        ...withoutBroadInterval(maintainMemoryEntry),
        ...(tasks.verify ?? {}),
        schedule: tasks.verify?.schedule ?? schedule,
      });
      tasks.curate = withTimeout({
        ...withoutBroadInterval(maintainMemoryEntry),
        ...(tasks.curate ?? {}),
        schedule: tasks.curate?.schedule ?? schedule,
      });
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
      tasks['verify-broad'] = withTimeout({
        schedule: isEnabledSchedule(tasks.verify?.schedule) ? DEFAULT_VERIFY_BROAD_CRON : '',
      });
    }

    const oldCurateEntries = OLD_CURATE_TASKS
      .map((task) => (isPlainObject(tasksObject[task]) ? tasksObject[task] : null))
      .filter(Boolean);
    if (oldCurateEntries.length > 0) {
      tasks.curate = withTimeout({
        ...(tasks.curate ?? {}),
        schedule: mostFrequentSchedule(oldCurateEntries.map((entry) => (
          typeof entry.schedule === 'string' ? entry.schedule : baseCron
        ))),
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
    const legacyArray = Array.isArray(dreamer.tasks)
      ? dreamer.tasks.filter((task) => typeof task === 'string')
      : null;
    const verifySelected = legacyArray ? legacyArray.includes(OLD_VERIFY_TASK) : true;
    const curateSelected = legacyArray
      ? legacyArray.some((task) => OLD_CURATE_TASKS.includes(task))
      : true;
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
      ...(userMemories && typeof userMemories.promotion_threshold === 'number'
        ? { promotion_threshold: userMemories.promotion_threshold }
        : {}),
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

function coerceToEnabledObject(value) {
  if (typeof value === 'boolean') return { enabled: value };
  if (isPlainObject(value)) return { ...value };
  return undefined;
}

function migrateLegacyExperimental(input) {
  if (!isPlainObject(input)) return input;
  const experimental = isPlainObject(input.experimental) ? input.experimental : undefined;
  if (!experimental) return input;
  const patched = { ...input };
  const memory = isPlainObject(patched.memory) ? { ...patched.memory } : {};
  if (hasOwn(experimental, 'temporal_awareness') && !hasOwn(patched, 'temporal_awareness')) {
    patched.temporal_awareness = experimental.temporal_awareness;
  }
  if (hasOwn(experimental, 'caveman_text_compression') && !hasOwn(patched, 'caveman_text_compression')) {
    patched.caveman_text_compression = experimental.caveman_text_compression;
  }
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

function migrateLegacyAgentEnabled(input) {
  if (!isPlainObject(input)) return input;
  let patched = input;
  for (const agentName of ['dreamer', 'sidekick', 'historian']) {
    const agent = isPlainObject(patched[agentName]) ? { ...patched[agentName] } : undefined;
    if (!agent || !hasOwn(agent, 'enabled')) continue;
    const enabled = agent.enabled;
    delete agent.enabled;
    if (agentName !== 'historian' && agent.disable !== true && enabled === false) {
      agent.disable = true;
    }
    patched = { ...patched, [agentName]: agent };
  }
  return patched;
}

function migrateMagicContextConfigInput(input) {
  return migrateLegacyAgentEnabled(migrateDreamerV2(migrateLegacyExperimental(input)));
}

function normalizePermission(value) {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const result = {};
  for (const key of ['edit', 'webfetch', 'doom_loop', 'external_directory']) {
    const permission = normalizeString(value[key]);
    if (PERMISSION_VALUES.has(permission)) {
      result[key] = permission;
    }
  }

  const bash = value.bash;
  if (typeof bash === 'string') {
    const permission = normalizeString(bash);
    if (PERMISSION_VALUES.has(permission)) {
      result.bash = permission;
    }
  } else if (isPlainObject(bash)) {
    const entries = Object.entries(bash)
      .map(([command, permission]) => [normalizeString(command), normalizeString(permission)])
      .filter(([command, permission]) => command && PERMISSION_VALUES.has(permission));
    if (entries.length > 0) {
      result.bash = Object.fromEntries(entries);
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function assignStringField(target, input, key) {
  if (!hasOwn(input, key)) return;
  const value = normalizeString(input[key]);
  if (value) target[key] = value;
}

function assignNumberField(target, input, key, min, max) {
  if (!hasOwn(input, key)) return;
  const value = normalizeNumberInRange(input[key], min, max);
  if (value !== undefined) target[key] = value;
}

function assignPositiveIntegerField(target, input, key) {
  if (!hasOwn(input, key)) return;
  const value = normalizePositiveInteger(input[key]);
  if (value !== undefined) target[key] = value;
}

function normalizeAgentConfig(input, extra = {}) {
  if (!isPlainObject(input)) {
    return undefined;
  }

  const result = {};
  assignStringField(result, input, 'model');
  assignStringField(result, input, 'variant');
  assignStringField(result, input, 'thinking_level');
  assignStringField(result, input, 'prompt');
  assignStringField(result, input, 'description');
  assignNumberField(result, input, 'temperature', 0, 2);
  assignNumberField(result, input, 'top_p', 0, 1);
  assignPositiveIntegerField(result, input, 'maxTokens');
  assignPositiveIntegerField(result, input, 'maxSteps');

  const fallbackModels = normalizeFallbackModels(input.fallback_models);
  if (fallbackModels !== undefined) result.fallback_models = fallbackModels;

  const tools = normalizeBooleanRecord(input.tools);
  if (tools) result.tools = tools;

  const permission = normalizePermission(input.permission);
  if (permission) result.permission = permission;

  const mode = normalizeString(input.mode);
  if (AGENT_MODES.has(mode)) result.mode = mode;

  const color = normalizeString(input.color);
  if (/^#[0-9A-Fa-f]{6}$/.test(color)) result.color = color;

  if (typeof input.disable === 'boolean') result.disable = input.disable;

  extra(result, input);

  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeHistorianConfig(value) {
  const normalized = normalizeAgentConfig(value, (result, input) => {
    if (typeof input.two_pass === 'boolean') result.two_pass = input.two_pass;
    if (Array.isArray(input.disallowed_tools)) {
      const disallowedTools = input.disallowed_tools
        .map(normalizeString)
        .filter((tool) => HISTORIAN_DISALLOWED_TOOLS.has(tool));
      if (disallowedTools.length > 0) result.disallowed_tools = Array.from(new Set(disallowedTools));
    }
  });
  return mergePreservingUnknown(value, normalized, HISTORIAN_KNOWN_KEYS);
}

function normalizeDreamTaskConfig(value) {
  if (!isPlainObject(value)) return undefined;
  const result = {};
  if (hasOwn(value, 'schedule')) result.schedule = normalizeString(value.schedule);
  assignStringField(result, value, 'model');
  const fallbackModels = normalizeFallbackModels(value.fallback_models);
  if (fallbackModels !== undefined) result.fallback_models = fallbackModels;
  assignStringField(result, value, 'thinking_level');
  const timeout = normalizeIntegerMin(value.timeout_minutes, 5);
  if (timeout !== undefined) result.timeout_minutes = timeout;
  const promotionThreshold = normalizeIntegerInRange(value.promotion_threshold, 2, 20);
  if (promotionThreshold !== undefined) result.promotion_threshold = promotionThreshold;
  return mergePreservingUnknown(value, result, DREAM_TASK_CONFIG_KNOWN_KEYS);
}

function normalizeDreamerTasks(value) {
  if (!isPlainObject(value)) return undefined;
  const result = {};
  for (const [taskName, taskConfig] of Object.entries(value)) {
    if (taskName === 'key-files') continue;
    const normalized = normalizeDreamTaskConfig(taskConfig);
    if (normalized && (CANONICAL_DREAMER_TASK_SET.has(taskName) || isPlainObject(taskConfig))) {
      result[taskName] = normalized;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeDreamerConfig(value) {
  const normalized = normalizeAgentConfig(value, (result, input) => {
    if (typeof input.inject_docs === 'boolean') result.inject_docs = input.inject_docs;
    const tasks = normalizeDreamerTasks(input.tasks);
    if (tasks) result.tasks = tasks;
  });
  return mergePreservingUnknown(value, normalized, DREAMER_KNOWN_KEYS);
}

function normalizeSidekickConfig(value) {
  const normalized = normalizeAgentConfig(value, (result, input) => {
    const timeout = normalizeIntegerMin(input.timeout_ms, 1);
    if (timeout !== undefined) result.timeout_ms = timeout;
    assignStringField(result, input, 'system_prompt');
  });
  return mergePreservingUnknown(value, normalized, SIDEKICK_KNOWN_KEYS);
}

function normalizeCommitClusterTrigger(value) {
  if (!isPlainObject(value)) return undefined;
  const result = {};
  if (typeof value.enabled === 'boolean') result.enabled = value.enabled;
  const minClusters = normalizeIntegerMin(value.min_clusters, 1);
  if (minClusters !== undefined) result.min_clusters = minClusters;
  return mergePreservingUnknown(value, result, COMMIT_CLUSTER_KNOWN_KEYS);
}

function normalizeSqlite(value) {
  if (!isPlainObject(value)) return undefined;
  const result = {};
  const cacheSize = normalizeIntegerInRange(value.cache_size_mb, 2, 2048);
  if (cacheSize !== undefined) result.cache_size_mb = cacheSize;
  const mmapSize = normalizeIntegerInRange(value.mmap_size_mb, 0, 8192);
  if (mmapSize !== undefined) result.mmap_size_mb = mmapSize;
  return mergePreservingUnknown(value, result, SQLITE_KNOWN_KEYS);
}

function normalizeCavemanTextCompression(value) {
  if (!isPlainObject(value)) return undefined;
  const result = {};
  if (typeof value.enabled === 'boolean') result.enabled = value.enabled;
  const minChars = normalizeIntegerInRange(value.min_chars, 100, 10000);
  if (minChars !== undefined) result.min_chars = minChars;
  return mergePreservingUnknown(value, result, CAVEMAN_TEXT_COMPRESSION_KNOWN_KEYS);
}

function normalizeSystemPromptInjection(value) {
  if (!isPlainObject(value)) return undefined;
  const result = {};
  if (typeof value.enabled === 'boolean') result.enabled = value.enabled;
  if (Array.isArray(value.skip_signatures)) {
    const signatures = value.skip_signatures
      .map(normalizeString)
      .filter(Boolean);
    if (signatures.length > 0) {
      result.skip_signatures = Array.from(new Set(signatures));
    }
  }
  return mergePreservingUnknown(value, result, SYSTEM_PROMPT_INJECTION_KNOWN_KEYS);
}

function normalizeEmbedding(value) {
  if (!isPlainObject(value)) return undefined;
  const provider = normalizeString(value.provider);
  const result = {};
  if (EMBEDDING_PROVIDERS.has(provider)) result.provider = provider;
  const model = normalizeString(value.model);
  const endpoint = normalizeString(value.endpoint);
  const apiKey = normalizeString(value.api_key);
  const inputType = normalizeString(value.input_type);
  const queryInputType = normalizeString(value.query_input_type);
  const truncate = normalizeString(value.truncate);

  if (model) result.model = model;
  if (endpoint) result.endpoint = endpoint;
  if (apiKey) result.api_key = apiKey;
  if (inputType) result.input_type = inputType;
  if (queryInputType) result.query_input_type = queryInputType;
  if (truncate) result.truncate = truncate;
  const maxInputTokens = normalizePositiveInteger(value.max_input_tokens);
  if (maxInputTokens !== undefined) result.max_input_tokens = maxInputTokens;

  if (provider === 'openai-compatible' && (!result.model || !result.endpoint)) {
    const error = new Error('embedding.model and embedding.endpoint are required when provider is openai-compatible.');
    error.code = 'INVALID_MAGIC_CONTEXT_CONFIG';
    throw error;
  }

  return mergePreservingUnknown(value, result, EMBEDDING_KNOWN_KEYS);
}

function normalizeAutoSearch(value) {
  if (!isPlainObject(value)) return undefined;
  const result = {};
  if (typeof value.enabled === 'boolean') result.enabled = value.enabled;
  const threshold = normalizeNumberInRange(value.score_threshold, 0.3, 0.95);
  if (threshold !== undefined) result.score_threshold = threshold;
  const minChars = normalizeIntegerInRange(value.min_prompt_chars, 5, 500);
  if (minChars !== undefined) result.min_prompt_chars = minChars;
  return mergePreservingUnknown(value, result, AUTO_SEARCH_KNOWN_KEYS);
}

function normalizeGitCommitIndexing(value) {
  if (!isPlainObject(value)) return undefined;
  const result = {};
  if (typeof value.enabled === 'boolean') result.enabled = value.enabled;
  const sinceDays = normalizeIntegerInRange(value.since_days, 7, 3650);
  if (sinceDays !== undefined) result.since_days = sinceDays;
  const maxCommits = normalizeIntegerInRange(value.max_commits, 100, 20000);
  if (maxCommits !== undefined) result.max_commits = maxCommits;
  return mergePreservingUnknown(value, result, GIT_COMMIT_INDEXING_KNOWN_KEYS);
}

function normalizeMemory(value) {
  if (!isPlainObject(value)) return undefined;
  const result = {};
  if (typeof value.enabled === 'boolean') result.enabled = value.enabled;
  if (typeof value.auto_promote === 'boolean') result.auto_promote = value.auto_promote;
  const budget = normalizeIntegerInRange(value.injection_budget_tokens, 500, 20000);
  if (budget !== undefined) result.injection_budget_tokens = budget;
  const threshold = normalizeIntegerMin(value.retrieval_count_promotion_threshold, 1);
  if (threshold !== undefined) result.retrieval_count_promotion_threshold = threshold;
  const autoSearch = normalizeAutoSearch(value.auto_search);
  if (autoSearch) result.auto_search = autoSearch;
  const gitCommitIndexing = normalizeGitCommitIndexing(value.git_commit_indexing);
  if (gitCommitIndexing) result.git_commit_indexing = gitCommitIndexing;
  return mergePreservingUnknown(value, result, MEMORY_KNOWN_KEYS);
}

function normalizeCommand(value) {
  return isPlainObject(value) ? cloneJson(value) : undefined;
}

function normalizeDisabledHooks(value) {
  if (!Array.isArray(value)) return undefined;
  const hooks = value.map(normalizeString).filter(Boolean);
  return hooks.length > 0 ? Array.from(new Set(hooks)) : undefined;
}

function sanitizeMagicContextConfig(input) {
  if (!isPlainObject(input)) return {};
  const migratedInput = migrateMagicContextConfigInput(input);
  if (!isPlainObject(migratedInput)) return {};
  const result = {};

  if (hasOwn(migratedInput, '$schema')) {
    const schema = normalizeString(migratedInput.$schema);
    if (schema) result.$schema = SCHEMA_URL;
  }
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

  const commitClusterTrigger = normalizeCommitClusterTrigger(migratedInput.commit_cluster_trigger);
  if (commitClusterTrigger) result.commit_cluster_trigger = commitClusterTrigger;
  const sqlite = normalizeSqlite(migratedInput.sqlite);
  if (sqlite) result.sqlite = sqlite;
  const systemPromptInjection = normalizeSystemPromptInjection(migratedInput.system_prompt_injection);
  if (systemPromptInjection) result.system_prompt_injection = systemPromptInjection;
  const caveman = normalizeCavemanTextCompression(migratedInput.caveman_text_compression);
  if (caveman) result.caveman_text_compression = caveman;
  const historian = normalizeHistorianConfig(migratedInput.historian);
  if (historian) result.historian = historian;
  const dreamer = normalizeDreamerConfig(migratedInput.dreamer);
  if (dreamer) result.dreamer = dreamer;
  const sidekick = normalizeSidekickConfig(migratedInput.sidekick);
  if (sidekick) result.sidekick = sidekick;
  const embedding = normalizeEmbedding(migratedInput.embedding);
  if (embedding) result.embedding = embedding;
  const memory = normalizeMemory(migratedInput.memory);
  if (memory) result.memory = memory;
  const command = normalizeCommand(migratedInput.command);
  if (command) result.command = command;
  const disabledHooks = normalizeDisabledHooks(migratedInput.disabled_hooks);
  if (disabledHooks) result.disabled_hooks = disabledHooks;

  for (const [key, value] of Object.entries(migratedInput)) {
    if (!CURRENT_TOP_LEVEL_KEY_SET.has(key) && !RETIRED_TOP_LEVEL_KEYS.has(key)) {
      result[key] = cloneJson(value);
    }
  }

  return result;
}

function updateJsoncProperty(content, key, shouldUpdate, value) {
  if (!shouldUpdate) {
    return content;
  }

  const nextValue = value === undefined ? undefined : value;
  const edits = modifyJsonc(content, [key], nextValue, {
    formattingOptions: JSONC_FORMATTING_OPTIONS,
  });
  return applyEdits(content, edits);
}

function readMagicContextConfig(options = {}) {
  const directory = normalizeString(options.directory);
  const targetDetection = detectUserTargetConfigFile();
  const sourceDetection = resolveUserConfigSource(targetDetection);
  const targetMetadata = withSourceMetadata(targetDetection, false);
  const sourceMetadata = withSourceMetadata(sourceDetection.detection, sourceDetection.legacy);
  const targetConfig = sourceMetadata.exists ? readJsoncFile(sourceMetadata.path) : {};
  const projectDetection = detectProjectConfigFile(directory);
  const projectConfig = projectDetection?.exists ? readJsoncFile(projectDetection.path) : {};
  const projectSource = projectDetection ? withSourceMetadata(projectDetection, projectDetection.legacy === true) : null;

  return {
    plugin: findPluginEntry(directory),
    target: {
      scope: 'user',
      path: targetMetadata.path,
      exists: targetMetadata.exists,
      format: targetMetadata.format,
      mtimeMs: targetMetadata.mtimeMs,
    },
    source: sourceMetadata,
    project: {
      path: projectDetection?.exists ? projectDetection.path : null,
      exists: Boolean(projectDetection?.exists),
      overriddenKeys: Object.keys(projectConfig).sort(),
      source: projectSource,
      legacy: projectSource?.legacy === true,
    },
    diagnostics: buildDiagnostics(directory, projectConfig, {
      source: sourceMetadata,
      target: targetMetadata,
      projectSource,
    }),
    schemaUrl: SCHEMA_URL,
    raw: targetConfig,
    projectRaw: projectConfig,
  };
}

function saveMagicContextConfig(input = {}) {
  const directory = normalizeString(input.directory);
  const targetDetection = detectUserTargetConfigFile();
  const targetPath = targetDetection.path;

  if (hasMtimeMismatch(targetPath, input.expectedMtimeMs)) {
    throw createConfigModifiedError();
  }

  const sourcePath = normalizeString(input.sourcePath);
  const sourceMtimeMs = input.sourceMtimeMs ?? null;
  if (sourcePath && path.resolve(sourcePath) !== path.resolve(targetPath) && hasMtimeMismatch(sourcePath, sourceMtimeMs)) {
    throw createConfigModifiedError();
  }

  const originalConfig = isPlainObject(input.config) ? input.config : {};
  const sanitized = sanitizeMagicContextConfig(originalConfig);
  const requestedKeys = new Set(Object.keys(sanitized).filter((key) => TOP_LEVEL_KEYS.includes(key)));
  for (const key of Object.keys(sanitized)) {
    if (!RETIRED_TOP_LEVEL_KEYS.has(key)) requestedKeys.add(key);
  }
  for (const key of Object.keys(originalConfig)) {
    if (TOP_LEVEL_KEYS.includes(key) && !RETIRED_TOP_LEVEL_KEYS.has(key)) requestedKeys.add(key);
  }
  if (!requestedKeys.has('$schema') && !targetDetection.exists) {
    sanitized.$schema = SCHEMA_URL;
    requestedKeys.add('$schema');
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const sourceDiffersFromTarget = Boolean(sourcePath)
    && path.resolve(sourcePath) !== path.resolve(targetPath);
  const useSourceContentAsSeed = sourceDiffersFromTarget
    && !targetDetection.exists
    && fs.existsSync(sourcePath);

  let content;
  if (targetDetection.exists) {
    content = fs.readFileSync(targetPath, 'utf8');
  } else if (useSourceContentAsSeed) {
    // Seed the new CortexKit target with the legacy file content so JSONC
    // comments carry over. The legacy file itself is never mutated; the save
    // loop below rewrites current keys and removes retired top-level keys.
    content = fs.readFileSync(sourcePath, 'utf8');
  } else {
    content = '{\n}\n';
  }
  if (!content.trim()) {
    content = '{\n}\n';
  }

  const keysToUpdate = [
    ...TOP_LEVEL_KEYS,
    ...Object.keys(sanitized).filter((key) => !TOP_LEVEL_KEYS.includes(key) && !RETIRED_TOP_LEVEL_KEYS.has(key)).sort(),
  ];
  for (const key of keysToUpdate) {
    content = updateJsoncProperty(content, key, requestedKeys.has(key), sanitized[key]);
  }

  // Existing targets (or seeded legacy content) may still carry retired
  // top-level keys that sanitize dropped; remove them explicitly so the saved
  // file reflects the current schema while preserving comments and unknown
  // future fields.
  for (const key of RETIRED_TOP_LEVEL_KEYS) {
    content = updateJsoncProperty(content, key, true, undefined);
  }

  parseJsoncObject(content, targetPath);

  if (targetDetection.exists) {
    try {
      fs.copyFileSync(targetPath, `${targetPath}.openchamber.backup`);
    } catch {
      // Backup failure should not prevent the requested config write.
    }
  }

  fs.writeFileSync(targetPath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');

  return readMagicContextConfig({ directory });
}

export {
  matchesMagicContextPlugin,
  readMagicContextConfig,
  saveMagicContextConfig,
  sanitizeMagicContextConfig,
};
