import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  applyEdits,
  modify as modifyJsonc,
  parse as parseJsonc,
  printParseErrorCode,
} from 'jsonc-parser';

const PLUGIN_NAME = 'oh-my-openagent';
const LEGACY_PLUGIN_NAME = 'oh-my-opencode';
const DEFAULT_PLUGIN_ENTRY = PLUGIN_NAME;
const CONFIG_BASENAME = 'oh-my-openagent';
const LEGACY_CONFIG_BASENAME = 'oh-my-opencode';

const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const TEXT_VERBOSITIES = new Set(['low', 'medium', 'high']);
const MODES = new Set(['subagent', 'primary', 'all']);
const THINKING_TYPES = new Set(['enabled', 'disabled']);
const TOP_LEVEL_ARRAY_KEYS = [
  'disabled_skills',
  'disabled_commands',
  'disabled_tools',
  'disabled_mcps',
  'disabled_providers',
  'mcp_env_allowlist',
];
const TOP_LEVEL_OBJECT_KEYS = [
  'background_task',
  'team_mode',
  'model_capabilities',
  'experimental',
  'skills',
  'tmux',
];
const TOP_LEVEL_SCALAR_KEYS = [
  'default_mode',
  'hashline_edit',
  'model_fallback',
  'runtime_fallback',
];
const KNOWN_HOOKS = new Set([
  'todo-continuation-enforcer',
  'context-window-monitor',
  'session-recovery',
  'session-notification',
  'comment-checker',
  'tool-output-truncator',
  'question-label-truncator',
  'directory-agents-injector',
  'directory-readme-injector',
  'empty-task-response-detector',
  'think-mode',
  'model-fallback',
  'anthropic-context-window-limit-recovery',
  'preemptive-compaction',
  'rules-injector',
  'background-notification',
  'auto-update-checker',
  'startup-toast',
  'keyword-detector',
  'agent-usage-reminder',
  'non-interactive-env',
  'interactive-bash-session',
  'thinking-block-validator',
  'tool-pair-validator',
  'ralph-loop',
  'category-skill-reminder',
  'compaction-context-injector',
  'compaction-todo-preserver',
  'claude-code-hooks',
  'auto-slash-command',
  'edit-error-recovery',
  'json-error-recovery',
  'delegate-task-retry',
  'prometheus-md-only',
  'sisyphus-junior-notepad',
  'team-tool-gating',
  'no-sisyphus-gpt',
  'no-hephaestus-non-gpt',
  'start-work',
  'atlas',
  'unstable-agent-babysitter',
  'task-resume-info',
  'stop-continuation-guard',
  'tasks-todowrite-disabler',
  'runtime-fallback',
  'write-existing-file-guard',
  'bash-file-read-guard',
  'anthropic-effort',
  'hashline-read-enhancer',
  'read-image-resizer',
  'todo-description-override',
  'webfetch-redirect-guard',
  'fsync-skip-warning',
  'legacy-plugin-toast',
]);

const JSONC_FORMATTING_OPTIONS = {
  insertSpaces: true,
  tabSize: 2,
  eol: '\n',
};

const MAIN_AGENTS = [
  ['sisyphus', 'Sisyphus - Ultraworker', '主编排者'],
  ['hephaestus', 'Hephaestus - Deep Agent', '自主深度工作者'],
  ['prometheus', 'Prometheus - Plan Builder', '战略规划者'],
  ['atlas', 'Atlas - Plan Executor', '任务管理者'],
];

const SUB_AGENTS = [
  ['oracle', 'Oracle', '战略顾问'],
  ['librarian', 'Librarian', '多仓库研究员'],
  ['explore', 'Explore', '快速代码搜索'],
  ['multimodal-looker', 'Multimodal-Looker', '媒体分析器'],
  ['metis', 'Metis - Plan Consultant', '规划前分析顾问'],
  ['momus', 'Momus - Plan Critic', '计划审查者'],
  ['sisyphus-junior', 'Sisyphus-Junior', '委托任务执行器'],
];

const CATEGORY_DEFAULTS = [
  ['visual-engineering', 'Visual Engineering', '视觉/前端工程', { model: 'google/gemini-3.1-pro', variant: 'high' }],
  ['ultrabrain', 'Ultrabrain', '超级思考', { model: 'openai/gpt-5.5', variant: 'xhigh' }],
  ['deep', 'Deep', '深度工作', { model: 'openai/gpt-5.5', variant: 'medium' }],
  ['artistry', 'Artistry', '创意/文艺', { model: 'google/gemini-3.1-pro', variant: 'high' }],
  ['quick', 'Quick', '快速响应', { model: 'openai/gpt-5.4-mini' }],
  ['unspecified-low', 'Unspecified Low', '通用低配', { model: 'anthropic/claude-sonnet-4-6' }],
  ['unspecified-high', 'Unspecified High', '通用高配', { model: 'anthropic/claude-opus-4-7', variant: 'max' }],
  ['writing', 'Writing', '写作', { model: 'kimi-for-coding/k2p5' }],
];

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeDisabledHooks(input) {
  if (!Array.isArray(input)) return [];
  return Array.from(new Set(input
    .map(normalizeString)
    .filter((hook) => hook && KNOWN_HOOKS.has(hook))))
    .sort();
}

function sanitizeStringList(input) {
  if (!Array.isArray(input)) return undefined;
  const entries = Array.from(new Set(input
    .map(normalizeString)
    .filter(Boolean)))
    .sort();
  return entries.length > 0 ? entries : undefined;
}

function sanitizePlainObject(input) {
  if (!isPlainObject(input)) return undefined;
  return Object.keys(input).length > 0 ? input : undefined;
}

function sanitizeRuntimeFallback(input) {
  if (typeof input === 'boolean') return input;
  return sanitizePlainObject(input);
}

function getGlobalRawFields(config) {
  const result = {};
  for (const key of TOP_LEVEL_ARRAY_KEYS) {
    const value = sanitizeStringList(config?.[key]);
    if (value) result[key] = value;
  }
  for (const key of TOP_LEVEL_OBJECT_KEYS) {
    const value = sanitizePlainObject(config?.[key]);
    if (value) result[key] = value;
  }
  const defaultMode = normalizeString(config?.default_mode);
  if (defaultMode) result.default_mode = defaultMode;
  if (typeof config?.hashline_edit === 'boolean') result.hashline_edit = config.hashline_edit;
  if (typeof config?.model_fallback === 'boolean') result.model_fallback = config.model_fallback;
  const runtimeFallback = sanitizeRuntimeFallback(config?.runtime_fallback);
  if (runtimeFallback !== undefined) result.runtime_fallback = runtimeFallback;
  return result;
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

function normalizePositiveInteger(value) {
  const parsed = normalizeFiniteNumber(value);
  if (parsed === undefined || parsed <= 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

function normalizeNumberInRange(value, min, max) {
  const parsed = normalizeFiniteNumber(value);
  if (parsed === undefined || parsed < min || parsed > max) {
    return undefined;
  }
  return parsed;
}

function getOpenCodeConfigDir() {
  const envConfigDir = normalizeString(process.env.OPENCODE_CONFIG_DIR);
  if (envConfigDir) {
    return path.resolve(envConfigDir);
  }
  return path.join(os.homedir(), '.config', 'opencode');
}

function detectConfigFile(dir, basename) {
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

function detectOpenAgentConfigFile(dir) {
  const canonical = detectConfigFile(dir, CONFIG_BASENAME);
  const legacy = detectConfigFile(dir, LEGACY_CONFIG_BASENAME);

  if (canonical.exists) {
    return {
      ...canonical,
      isLegacy: false,
      legacyPath: legacy.exists ? legacy.path : null,
    };
  }

  if (legacy.exists) {
    return {
      ...legacy,
      isLegacy: true,
      legacyPath: legacy.path,
    };
  }

  return {
    exists: false,
    format: 'jsonc',
    path: path.join(dir, `${CONFIG_BASENAME}.jsonc`),
    isLegacy: false,
    legacyPath: null,
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
  const userCandidates = [
    { path: path.join(configDir, 'opencode.jsonc'), scope: 'user' },
    { path: path.join(configDir, 'opencode.json'), scope: 'user' },
  ];
  const candidates = [...userCandidates];

  if (directory) {
    candidates.push(
      { path: path.join(directory, '.opencode', 'opencode.jsonc'), scope: 'project' },
      { path: path.join(directory, '.opencode', 'opencode.json'), scope: 'project' },
      { path: path.join(directory, 'opencode.jsonc'), scope: 'project' },
      { path: path.join(directory, 'opencode.json'), scope: 'project' },
    );
  }

  return candidates;
}

function getLegacyOpenCodeConfigCandidates() {
  const configDir = getOpenCodeConfigDir();
  return [
    { path: path.join(configDir, 'config.json'), scope: 'user' },
  ];
}

function getAllOpenCodeConfigCandidates(directory) {
  return [
    ...getOpenCodeConfigCandidates(directory),
    ...getLegacyOpenCodeConfigCandidates(),
  ];
}

function getPrimaryUserOpenCodeConfigPath() {
  const configDir = getOpenCodeConfigDir();
  const candidates = [
    path.join(configDir, 'opencode.jsonc'),
    path.join(configDir, 'opencode.json'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? path.join(configDir, 'opencode.jsonc');
}

function isOpenAgentPluginEntry(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? normalized;
  return (
    basename === PLUGIN_NAME ||
    basename.startsWith(`${PLUGIN_NAME}@`) ||
    basename === LEGACY_PLUGIN_NAME ||
    basename.startsWith(`${LEGACY_PLUGIN_NAME}@`)
  );
}

function normalizePluginEntry(value) {
  const entry = normalizeString(value);
  return entry && isOpenAgentPluginEntry(entry) ? entry : DEFAULT_PLUGIN_ENTRY;
}

function getPluginEntries(config, key) {
  if (!Array.isArray(config?.[key])) {
    return [];
  }
  return config[key]
    .map((entry) => normalizeString(entry))
    .filter(Boolean);
}

function getPreferredPluginArrayKey(config) {
  if (Array.isArray(config?.plugin)) {
    return 'plugin';
  }
  if (Array.isArray(config?.plugins)) {
    return 'plugins';
  }
  return 'plugin';
}

function findPluginEntry(directory) {
  const writeTargetPath = getPrimaryUserOpenCodeConfigPath();

  for (const candidate of getOpenCodeConfigCandidates(directory)) {
    const configPath = candidate.path;
    if (!fs.existsSync(configPath)) {
      continue;
    }

    try {
      const config = readJsoncFile(configPath);
      for (const key of ['plugin', 'plugins']) {
        const entry = getPluginEntries(config, key).find(isOpenAgentPluginEntry);
        if (entry) {
          return {
            detected: true,
            enabled: true,
            entry,
            configPath,
            configKey: key,
            scope: candidate.scope,
            writeTargetPath,
            mtimeMs: getFileMtimeMs(configPath),
          };
        }
      }
    } catch {
      // Ignore malformed OpenCode config here; the dedicated config UI can surface that.
    }
  }

  return {
    detected: false,
    enabled: false,
    entry: null,
    configPath: null,
    configKey: 'plugin',
    scope: 'user',
    writeTargetPath,
    mtimeMs: getFileMtimeMs(writeTargetPath),
  };
}

function updateJsoncRawProperty(content, key, value) {
  const edits = modifyJsonc(content, [key], value, {
    formattingOptions: JSONC_FORMATTING_OPTIONS,
  });
  return applyEdits(content, edits);
}

function writeJsoncContent(filePath, content) {
  parseJsoncObject(content, filePath);
  if (fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, `${filePath}.openchamber.backup`);
    } catch {
      // Backup failure should not prevent the requested config write.
    }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
}

function updateOpenCodePluginEntries(filePath, updater) {
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '{\n}\n';
  if (!content.trim()) {
    content = '{\n}\n';
  }

  const config = parseJsoncObject(content, filePath);
  const keys = Array.from(new Set([
    getPreferredPluginArrayKey(config),
    'plugin',
    'plugins',
  ]));
  let nextContent = content;
  let changed = false;

  for (const key of keys) {
    const existingEntries = getPluginEntries(config, key);
    if (existingEntries.length === 0 && key !== getPreferredPluginArrayKey(config)) {
      continue;
    }

    const nextEntries = updater(existingEntries, key);
    if (nextEntries === null) {
      continue;
    }

    const normalizedNext = Array.from(new Set(
      nextEntries.map((entry) => normalizeString(entry)).filter(Boolean),
    ));

    const equal = existingEntries.length === normalizedNext.length
      && existingEntries.every((entry, index) => entry === normalizedNext[index]);
    if (equal && Array.isArray(config?.[key])) {
      continue;
    }

    nextContent = updateJsoncRawProperty(
      nextContent,
      key,
      normalizedNext.length > 0 ? normalizedNext : undefined,
    );
    changed = true;
  }

  if (changed) {
    writeJsoncContent(filePath, nextContent);
  }

  return changed;
}

function setOpenAgentPluginEnabled(input = {}) {
  const directory = normalizeString(input.directory);
  const enabled = input.enabled === true;
  const pluginInfo = findPluginEntry(directory);

  const mtimePath = pluginInfo.configPath ?? pluginInfo.writeTargetPath;
  if (hasMtimeMismatch(mtimePath, input.expectedMtimeMs)) {
    throw createConfigModifiedError();
  }

  if (enabled) {
    if (pluginInfo.enabled) {
      return readOpenAgentConfig({ directory });
    }

    const targetPath = pluginInfo.writeTargetPath ?? getPrimaryUserOpenCodeConfigPath();
    const entry = normalizePluginEntry(input.entry);

    for (const candidate of getAllOpenCodeConfigCandidates(directory)) {
      if (!fs.existsSync(candidate.path)) {
        continue;
      }
      updateOpenCodePluginEntries(candidate.path, (entries) => {
        const nextEntries = entries.filter((item) => !isOpenAgentPluginEntry(item));
        return nextEntries.length === entries.length ? null : nextEntries;
      });
    }

    updateOpenCodePluginEntries(targetPath, (entries, key) => {
      if (key !== getPreferredPluginArrayKey(readJsoncFile(targetPath))) {
        return entries.length > 0 ? entries : null;
      }
      const withoutOpenAgent = entries.filter((item) => !isOpenAgentPluginEntry(item));
      return [...withoutOpenAgent, entry];
    });

    return readOpenAgentConfig({ directory });
  }

  if (!pluginInfo.enabled) {
    return readOpenAgentConfig({ directory });
  }

  for (const candidate of getAllOpenCodeConfigCandidates(directory)) {
    if (!fs.existsSync(candidate.path)) {
      continue;
    }
    updateOpenCodePluginEntries(candidate.path, (entries) => {
      const nextEntries = entries.filter((entry) => !isOpenAgentPluginEntry(entry));
      return nextEntries.length === entries.length ? null : nextEntries;
    });
  }

  return readOpenAgentConfig({ directory });
}

function getSection(config, key) {
  return isPlainObject(config?.[key]) ? config[key] : {};
}

function createConfigModifiedError() {
  const error = new Error('Config was modified outside OpenChamber. Reload before saving again.');
  error.code = 'CONFIG_MODIFIED';
  return error;
}

function hasMtimeMismatch(filePath, expectedMtimeMs) {
  if (expectedMtimeMs == null) {
    return false;
  }

  const currentMtimeMs = getFileMtimeMs(filePath);
  if (currentMtimeMs == null) {
    return true;
  }

  return Math.abs(currentMtimeMs - expectedMtimeMs) > 1;
}

function normalizeFallbackModelObject(value) {
  if (!isPlainObject(value)) {
    return null;
  }

  const model = normalizeString(value.model);
  if (!model) {
    return null;
  }

  const normalized = { model };
  const variant = normalizeString(value.variant);
  if (variant) normalized.variant = variant;
  const reasoningEffort = normalizeString(value.reasoningEffort);
  if (REASONING_EFFORTS.has(reasoningEffort)) normalized.reasoningEffort = reasoningEffort;
  const temperature = normalizeNumberInRange(value.temperature, 0, 2);
  if (temperature !== undefined) normalized.temperature = temperature;
  const topP = normalizeNumberInRange(value.top_p, 0, 1);
  if (topP !== undefined) normalized.top_p = topP;
  const maxTokens = normalizePositiveInteger(value.maxTokens);
  if (maxTokens !== undefined) normalized.maxTokens = maxTokens;
  const thinking = normalizeThinking(value.thinking);
  if (thinking) normalized.thinking = thinking;

  return normalized;
}

function normalizeFallbackModels(value) {
  if (typeof value === 'string') {
    const model = normalizeString(value);
    return model || undefined;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const models = value
    .map((entry) => {
      if (typeof entry === 'string') {
        return normalizeString(entry) || null;
      }
      return normalizeFallbackModelObject(entry);
    })
    .filter(Boolean);

  return models.length > 0 ? models : undefined;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries = value
    .map((entry) => normalizeString(entry))
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

function normalizeThinking(value) {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const type = normalizeString(value.type);
  if (!THINKING_TYPES.has(type)) {
    return undefined;
  }

  const budgetTokens = normalizePositiveInteger(value.budgetTokens);
  return {
    type,
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
  };
}

function assignStringField(target, input, key, outputKey = key) {
  if (!Object.prototype.hasOwnProperty.call(input, key)) {
    return;
  }
  const value = normalizeString(input[key]);
  if (value) {
    target[outputKey] = value;
  }
}

function assignNumberField(target, input, key, min, max, outputKey = key) {
  if (!Object.prototype.hasOwnProperty.call(input, key)) {
    return;
  }
  const value = normalizeNumberInRange(input[key], min, max);
  if (value !== undefined) {
    target[outputKey] = value;
  }
}

function assignPositiveIntegerField(target, input, key, outputKey = key) {
  if (!Object.prototype.hasOwnProperty.call(input, key)) {
    return;
  }
  const value = normalizePositiveInteger(input[key]);
  if (value !== undefined) {
    target[outputKey] = value;
  }
}

function sanitizeOverride(input, kind) {
  if (!isPlainObject(input)) {
    return {};
  }

  const result = {};

  assignStringField(result, input, 'model');
  assignStringField(result, input, 'variant');
  assignNumberField(result, input, 'temperature', 0, 2);
  assignNumberField(result, input, 'top_p', 0, 1);
  assignPositiveIntegerField(result, input, 'maxTokens');
  assignStringField(result, input, 'prompt_append');

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
    assignStringField(result, input, 'category');
    assignStringField(result, input, 'prompt');
    assignStringField(result, input, 'description');

    const skills = normalizeStringArray(input.skills);
    if (skills) result.skills = skills;

    const mode = normalizeString(input.mode);
    if (MODES.has(mode)) result.mode = mode;

    const color = normalizeString(input.color);
    if (/^#[0-9A-Fa-f]{6}$/.test(color)) result.color = color;

    if (isPlainObject(input.permission) && Object.keys(input.permission).length > 0) {
      result.permission = input.permission;
    }
    if (isPlainObject(input.providerOptions) && Object.keys(input.providerOptions).length > 0) {
      result.providerOptions = input.providerOptions;
    }
    if (isPlainObject(input.ultrawork) && Object.keys(input.ultrawork).length > 0) {
      result.ultrawork = sanitizeOverride(input.ultrawork, 'category');
    }
    if (isPlainObject(input.compaction) && Object.keys(input.compaction).length > 0) {
      result.compaction = sanitizeOverride(input.compaction, 'category');
    }
    if (typeof input.allow_non_gpt_model === 'boolean') {
      result.allow_non_gpt_model = input.allow_non_gpt_model;
    }
  } else {
    assignStringField(result, input, 'description');
    assignPositiveIntegerField(result, input, 'max_prompt_tokens');
    if (typeof input.is_unstable_agent === 'boolean') result.is_unstable_agent = input.is_unstable_agent;
  }

  return Object.fromEntries(Object.entries(result).filter(([, value]) => {
    if (value === undefined || value === null) return false;
    if (isPlainObject(value) && Object.keys(value).length === 0) return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
  }));
}

function sanitizeOverrideRecord(input, kind) {
  if (!isPlainObject(input)) {
    return {};
  }

  const result = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = normalizeString(rawKey);
    if (!key) {
      continue;
    }

    const override = sanitizeOverride(rawValue, kind);
    if (Object.keys(override).length > 0) {
      result[key] = override;
    }
  }
  return result;
}

function makeItem(id, label, description, group, override, projectOverride, defaults = {}) {
  return {
    id,
    label,
    description,
    group,
    defaultModel: defaults.model ?? null,
    defaultVariant: defaults.variant ?? null,
    override: override ?? null,
    projectOverride: Boolean(projectOverride),
  };
}

function buildAgentItems(userAgents, projectAgents) {
  const knownIds = new Set();
  const items = [];
  for (const [id, label, description] of MAIN_AGENTS) {
    knownIds.add(id);
    items.push(makeItem(id, label, description, 'main', userAgents[id], projectAgents[id]));
  }
  for (const [id, label, description] of SUB_AGENTS) {
    knownIds.add(id);
    items.push(makeItem(id, label, description, 'sub', userAgents[id], projectAgents[id]));
  }

  for (const id of Array.from(new Set([...Object.keys(userAgents), ...Object.keys(projectAgents)])).sort()) {
    if (!knownIds.has(id)) {
      items.push(makeItem(id, id, 'Custom / Unknown', 'custom', userAgents[id], projectAgents[id]));
    }
  }

  return items;
}

function buildCategoryItems(userCategories, projectCategories) {
  const knownIds = new Set();
  const items = [];
  for (const [id, label, description, defaults] of CATEGORY_DEFAULTS) {
    knownIds.add(id);
    items.push(makeItem(id, label, description, 'category', userCategories[id], projectCategories[id], defaults));
  }

  for (const id of Array.from(new Set([...Object.keys(userCategories), ...Object.keys(projectCategories)])).sort()) {
    if (!knownIds.has(id)) {
      items.push(makeItem(id, id, 'Custom / Unknown', 'custom', userCategories[id], projectCategories[id]));
    }
  }

  return items;
}

function updateJsoncProperty(content, key, value) {
  let nextValue;
  if (isPlainObject(value)) {
    nextValue = Object.keys(value).length > 0 ? value : undefined;
  } else if (Array.isArray(value)) {
    nextValue = value.length > 0 ? value : undefined;
  } else if (typeof value === 'string') {
    nextValue = value.trim() ? value.trim() : undefined;
  } else if (typeof value === 'boolean' || typeof value === 'number') {
    nextValue = value;
  }
  const edits = modifyJsonc(content, [key], nextValue, {
    formattingOptions: JSONC_FORMATTING_OPTIONS,
  });
  return applyEdits(content, edits);
}

function readOpenAgentConfig(options = {}) {
  const directory = normalizeString(options.directory);
  const configDir = getOpenCodeConfigDir();
  const targetDetection = detectOpenAgentConfigFile(configDir);
  const targetConfig = readJsoncFile(targetDetection.path);
  const userAgents = getSection(targetConfig, 'agents');
  const userCategories = getSection(targetConfig, 'categories');
  const disabledHooks = sanitizeDisabledHooks(targetConfig.disabled_hooks);

  const projectBaseDir = directory ? path.join(directory, '.opencode') : null;
  const projectDetection = projectBaseDir ? detectOpenAgentConfigFile(projectBaseDir) : null;
  const projectConfig = projectDetection?.exists ? readJsoncFile(projectDetection.path) : {};
  const projectAgents = getSection(projectConfig, 'agents');
  const projectCategories = getSection(projectConfig, 'categories');

  return {
    plugin: findPluginEntry(directory),
    target: {
      scope: 'user',
      path: targetDetection.path,
      exists: targetDetection.exists,
      format: targetDetection.format,
      isLegacy: targetDetection.isLegacy,
      legacyPath: targetDetection.legacyPath,
      mtimeMs: getFileMtimeMs(targetDetection.path),
    },
    project: {
      path: projectDetection?.exists ? projectDetection.path : null,
      exists: Boolean(projectDetection?.exists),
      overriddenAgents: Object.keys(projectAgents).sort(),
      overriddenCategories: Object.keys(projectCategories).sort(),
    },
    agents: buildAgentItems(userAgents, projectAgents),
    categories: buildCategoryItems(userCategories, projectCategories),
    raw: {
      agents: userAgents,
      categories: userCategories,
      disabled_hooks: disabledHooks,
      ...getGlobalRawFields(targetConfig),
    },
  };
}

function saveOpenAgentConfig(input = {}) {
  const configDir = getOpenCodeConfigDir();
  const targetDetection = detectOpenAgentConfigFile(configDir);
  const targetPath = targetDetection.path;

  if (hasMtimeMismatch(targetPath, input.expectedMtimeMs)) {
    throw createConfigModifiedError();
  }

  const agents = sanitizeOverrideRecord(input.agents, 'agent');
  const categories = sanitizeOverrideRecord(input.categories, 'category');
  const disabledHooks = sanitizeDisabledHooks(input.disabled_hooks);
  const globalFields = getGlobalRawFields(input);

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  let content = targetDetection.exists ? fs.readFileSync(targetPath, 'utf8') : '{\n}\n';
  if (!content.trim()) {
    content = '{\n}\n';
  }

  content = updateJsoncProperty(content, 'agents', agents);
  content = updateJsoncProperty(content, 'categories', categories);
  content = updateJsoncProperty(content, 'disabled_hooks', disabledHooks);
  for (const key of TOP_LEVEL_ARRAY_KEYS) {
    content = updateJsoncProperty(content, key, globalFields[key]);
  }
  for (const key of TOP_LEVEL_OBJECT_KEYS) {
    content = updateJsoncProperty(content, key, globalFields[key]);
  }
  content = updateJsoncProperty(content, 'default_mode', globalFields.default_mode);
  content = updateJsoncProperty(content, 'hashline_edit', globalFields.hashline_edit);
  content = updateJsoncProperty(content, 'model_fallback', globalFields.model_fallback);
  content = updateJsoncProperty(content, 'runtime_fallback', globalFields.runtime_fallback);

  parseJsoncObject(content, targetPath);

  if (targetDetection.exists) {
    try {
      fs.copyFileSync(targetPath, `${targetPath}.openchamber.backup`);
    } catch {
      // Backup failure should not prevent the requested config write.
    }
  }

  fs.writeFileSync(targetPath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');

  return readOpenAgentConfig();
}

export {
  TOP_LEVEL_ARRAY_KEYS as OPEN_AGENT_TOP_LEVEL_ARRAY_KEYS,
  TOP_LEVEL_OBJECT_KEYS as OPEN_AGENT_TOP_LEVEL_OBJECT_KEYS,
  TOP_LEVEL_SCALAR_KEYS as OPEN_AGENT_TOP_LEVEL_SCALAR_KEYS,
  readOpenAgentConfig,
  saveOpenAgentConfig,
  setOpenAgentPluginEnabled,
  sanitizeOverride,
  sanitizeOverrideRecord,
};
