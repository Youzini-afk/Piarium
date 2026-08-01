import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  applyEdits,
  modify as modifyJsonc,
  parse as parseJsonc,
  printParseErrorCode,
} from 'jsonc-parser';

const PLUGIN_NAME = 'oh-my-opencode-slim';
const CONFIG_BASENAME = 'oh-my-opencode-slim';
const SCHEMA_URL = 'https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json';

const JSONC_FORMATTING_OPTIONS = {
  insertSpaces: true,
  tabSize: 2,
  eol: '\n',
};

const AGENT_DEFINITIONS = [
  ['orchestrator', 'Orchestrator', '主编排者', 'primary', { model: 'openai/gpt-5.5' }],
  ['oracle', 'Oracle', '架构顾问与深度审查', 'sub', { model: 'openai/gpt-5.5', variant: 'high' }],
  ['librarian', 'Librarian', '外部文档与资料检索', 'sub', { model: 'openai/gpt-5.4-mini', variant: 'low' }],
  ['explorer', 'Explorer', '代码库搜索与侦察', 'sub', { model: 'openai/gpt-5.4-mini', variant: 'low' }],
  ['designer', 'Designer', 'UI/UX 设计与前端体验', 'sub', { model: 'openai/gpt-5.4-mini', variant: 'medium' }],
  ['fixer', 'Fixer', '明确范围内的快速实现', 'sub', { model: 'openai/gpt-5.4-mini', variant: 'low' }],
  ['observer', 'Observer', '图像/PDF/视觉分析', 'optional', { model: 'openai/gpt-5.4-mini' }],
  ['council', 'Council', '多模型共识与高风险决策', 'optional', { model: 'openai/gpt-5.4-mini' }],
];

const BUILT_IN_AGENTS = new Set(AGENT_DEFINITIONS.map(([id]) => id));
const PROTECTED_AGENTS = new Set(['orchestrator', 'councillor']);
const VARIANTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MULTIPLEXER_TYPES = new Set(['auto', 'tmux', 'zellij', 'none']);
const MULTIPLEXER_LAYOUTS = new Set([
  'main-horizontal',
  'main-vertical',
  'tiled',
  'even-horizontal',
  'even-vertical',
]);
const COUNCILLOR_MODES = new Set(['parallel', 'serial']);
const TOP_LEVEL_KEYS = [
  '$schema',
  'preset',
  'presets',
  'agents',
  'disabled_agents',
  'autoUpdate',
  'multiplexer',
  'tmux',
  'fallback',
  'council',
  'divoom',
  'interview',
  'disabled_mcps',
  'sessionManager',
  'todoContinuation',
];

const STARTER_CONFIG = {
  $schema: SCHEMA_URL,
  preset: 'openai',
  disabled_agents: ['observer'],
  multiplexer: { type: 'none' },
  autoUpdate: false,
  presets: {
    openai: {
      orchestrator: { model: 'openai/gpt-5.5', skills: ['*'], mcps: ['*', '!context7'] },
      oracle: { model: 'openai/gpt-5.5', variant: 'high', skills: ['simplify'], mcps: [] },
      librarian: { model: 'openai/gpt-5.4-mini', variant: 'low', skills: [], mcps: ['websearch', 'context7', 'grep_app'] },
      explorer: { model: 'openai/gpt-5.4-mini', variant: 'low', skills: [], mcps: [] },
      designer: { model: 'openai/gpt-5.4-mini', variant: 'medium', skills: ['agent-browser'], mcps: [] },
      fixer: { model: 'openai/gpt-5.4-mini', variant: 'low', skills: [], mcps: [] },
    },
  },
};

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeFiniteNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  const normalized = normalizeString(value);
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeIntegerInRange(value, min, max) {
  const parsed = normalizeFiniteNumber(value);
  if (parsed === undefined || parsed < min || parsed > max) return undefined;
  return Math.floor(parsed);
}

function normalizeIntegerMin(value, min) {
  const parsed = normalizeFiniteNumber(value);
  if (parsed === undefined || parsed < min) return undefined;
  return Math.floor(parsed);
}

function normalizeNumberInRange(value, min, max) {
  const parsed = normalizeFiniteNumber(value);
  if (parsed === undefined || parsed < min || parsed > max) return undefined;
  return parsed;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function deepMerge(base, override) {
  if (!isPlainObject(base)) return isPlainObject(override) ? cloneJson(override) : override;
  if (!isPlainObject(override)) return cloneJson(base);
  const result = cloneJson(base);
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(result[key]) && isPlainObject(value)) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = cloneJson(value);
    }
  }
  return result;
}

function getOpenCodeConfigDir() {
  const envConfigDir = normalizeString(process.env.OPENCODE_CONFIG_DIR);
  if (envConfigDir) {
    return path.resolve(envConfigDir);
  }
  return path.join(os.homedir(), '.config', 'opencode');
}

function detectConfigFile(dir, basename = CONFIG_BASENAME) {
  const jsoncPath = path.join(dir, `${basename}.jsonc`);
  const jsonPath = path.join(dir, `${basename}.json`);
  if (fs.existsSync(jsoncPath)) return { exists: true, format: 'jsonc', path: jsoncPath };
  if (fs.existsSync(jsonPath)) return { exists: true, format: 'json', path: jsonPath };
  return { exists: false, format: 'jsonc', path: jsoncPath };
}

function detectProjectConfigFile(directory) {
  if (!directory) return null;
  const dotOpenCode = detectConfigFile(path.join(directory, '.opencode'));
  if (dotOpenCode.exists) return dotOpenCode;
  return {
    exists: false,
    format: 'jsonc',
    path: path.join(directory, '.opencode', `${CONFIG_BASENAME}.jsonc`),
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
  if (!filePath || !fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.trim()) return {};
  return parseJsoncObject(content, filePath);
}

function getFileMtimeMs(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
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

function isSlimPluginEntry(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? normalized;
  return basename === PLUGIN_NAME || basename.startsWith(`${PLUGIN_NAME}@`);
}

function findPluginEntry(directory) {
  for (const configPath of getOpenCodeConfigCandidates(directory)) {
    if (!fs.existsSync(configPath)) continue;
    try {
      const config = readJsoncFile(configPath);
      for (const key of ['plugin', 'plugins']) {
        const entries = Array.isArray(config[key]) ? config[key] : [];
        const entry = entries.find((value) => isSlimPluginEntry(value));
        if (entry) {
          return {
            detected: true,
            enabled: true,
            entry,
            configPath,
            mtimeMs: getFileMtimeMs(configPath),
          };
        }
      }
    } catch {
      // Let dedicated config pages surface malformed OpenCode config errors.
    }
  }
  return {
    detected: false,
    enabled: false,
    entry: null,
    configPath: null,
    mtimeMs: null,
  };
}

function createConfigModifiedError() {
  const error = new Error('Config was modified outside OpenChamber. Reload before saving again.');
  error.code = 'CONFIG_MODIFIED';
  return error;
}

function hasMtimeMismatch(filePath, expectedMtimeMs) {
  if (expectedMtimeMs == null) return false;
  const currentMtimeMs = getFileMtimeMs(filePath);
  if (currentMtimeMs == null) return true;
  return Math.abs(currentMtimeMs - expectedMtimeMs) > 1;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return undefined;
  const entries = value.map((entry) => normalizeString(entry)).filter(Boolean);
  return entries.length > 0 ? entries : [];
}

function normalizeModelEntry(value) {
  if (typeof value === 'string') {
    return normalizeString(value) || null;
  }
  if (!isPlainObject(value)) return null;
  const id = normalizeString(value.id);
  if (!id) return null;
  const result = { id };
  const variant = normalizeString(value.variant);
  if (variant) result.variant = variant;
  return result;
}

function normalizeModel(value) {
  if (typeof value === 'string') {
    return normalizeString(value) || undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const entries = value.map(normalizeModelEntry).filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

function normalizeAgentOverride(input, agentName = '') {
  if (!isPlainObject(input)) return {};
  const result = {};
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
  if (isPlainObject(input.options) && Object.keys(input.options).length > 0) {
    result.options = input.options;
  }
  if (!BUILT_IN_AGENTS.has(agentName)) {
    const prompt = normalizeString(input.prompt);
    if (prompt) result.prompt = prompt;
    const orchestratorPrompt = normalizeString(input.orchestratorPrompt);
    if (orchestratorPrompt) result.orchestratorPrompt = orchestratorPrompt;
  }
  return result;
}

function normalizeAgentRecord(value) {
  if (!isPlainObject(value)) return {};
  const result = {};
  for (const [rawName, rawOverride] of Object.entries(value)) {
    const name = normalizeString(rawName);
    if (!name) continue;
    const override = normalizeAgentOverride(rawOverride, name);
    if (Object.keys(override).length > 0) result[name] = override;
  }
  return result;
}

function normalizePresets(value) {
  if (!isPlainObject(value)) return undefined;
  const result = {};
  for (const [rawPreset, rawAgents] of Object.entries(value)) {
    const preset = normalizeString(rawPreset);
    if (!preset) continue;
    const agents = normalizeAgentRecord(rawAgents);
    if (Object.keys(agents).length > 0) result[preset] = agents;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeDisabledAgents(value) {
  if (!Array.isArray(value)) return undefined;
  const entries = Array.from(new Set(
    value
      .map((entry) => normalizeString(entry))
      .filter((entry) => entry && !PROTECTED_AGENTS.has(entry)),
  ));
  return entries;
}

function normalizeFallbackConfig(value) {
  if (!isPlainObject(value)) return undefined;
  const result = {};
  if (typeof value.enabled === 'boolean') result.enabled = value.enabled;
  const timeoutMs = normalizeIntegerMin(value.timeoutMs, 0);
  if (timeoutMs !== undefined) result.timeoutMs = timeoutMs;
  const retryDelayMs = normalizeIntegerMin(value.retryDelayMs, 0);
  if (retryDelayMs !== undefined) result.retryDelayMs = retryDelayMs;
  if (typeof value.retry_on_empty === 'boolean') result.retry_on_empty = value.retry_on_empty;
  if (isPlainObject(value.chains)) {
    const chains = {};
    for (const [rawAgent, rawModels] of Object.entries(value.chains)) {
      const agent = normalizeString(rawAgent);
      const models = normalizeStringArray(rawModels);
      if (agent && models && models.length > 0) chains[agent] = models;
    }
    if (Object.keys(chains).length > 0) result.chains = chains;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeMultiplexerConfig(value) {
  if (!isPlainObject(value)) return undefined;
  const result = {};
  const type = normalizeString(value.type);
  if (MULTIPLEXER_TYPES.has(type)) result.type = type;
  const layout = normalizeString(value.layout);
  if (MULTIPLEXER_LAYOUTS.has(layout)) result.layout = layout;
  const mainPaneSize = normalizeIntegerInRange(value.main_pane_size, 20, 80);
  if (mainPaneSize !== undefined) result.main_pane_size = mainPaneSize;
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeDivoomConfig(value) {
  if (!isPlainObject(value)) return undefined;
  const result = {};
  if (typeof value.enabled === 'boolean') result.enabled = value.enabled;
  for (const key of ['python', 'script']) {
    const normalized = normalizeString(value[key]);
    if (normalized) result[key] = normalized;
  }
  for (const [key, min, max] of [
    ['size', 1, 1024],
    ['fps', 1, 60],
    ['speed', 1, 10000],
    ['maxFrames', 1, 500],
    ['posterizeBits', 1, 8],
  ]) {
    const parsed = normalizeIntegerInRange(value[key], min, max);
    if (parsed !== undefined) result[key] = parsed;
  }
  if (isPlainObject(value.gifs)) {
    const gifs = {};
    for (const [rawKey, rawPath] of Object.entries(value.gifs)) {
      const key = normalizeString(rawKey);
      const gifPath = normalizeString(rawPath);
      if (key && gifPath) gifs[key] = gifPath;
    }
    if (Object.keys(gifs).length > 0) result.gifs = gifs;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeInterviewConfig(value) {
  if (!isPlainObject(value)) return undefined;
  const result = {};
  const maxQuestions = normalizeIntegerInRange(value.maxQuestions, 1, 10);
  if (maxQuestions !== undefined) result.maxQuestions = maxQuestions;
  const outputFolder = normalizeString(value.outputFolder);
  if (outputFolder) result.outputFolder = outputFolder;
  if (typeof value.autoOpenBrowser === 'boolean') result.autoOpenBrowser = value.autoOpenBrowser;
  const port = normalizeIntegerInRange(value.port, 0, 65535);
  if (port !== undefined) result.port = port;
  if (typeof value.dashboard === 'boolean') result.dashboard = value.dashboard;
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeSessionManagerConfig(value) {
  if (!isPlainObject(value)) return undefined;
  const result = {};
  const maxSessions = normalizeIntegerInRange(value.maxSessionsPerAgent, 1, 10);
  if (maxSessions !== undefined) result.maxSessionsPerAgent = maxSessions;
  const minLines = normalizeIntegerInRange(value.readContextMinLines, 0, 1000);
  if (minLines !== undefined) result.readContextMinLines = minLines;
  const maxFiles = normalizeIntegerInRange(value.readContextMaxFiles, 0, 50);
  if (maxFiles !== undefined) result.readContextMaxFiles = maxFiles;
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeTodoContinuationConfig(value) {
  if (!isPlainObject(value)) return undefined;
  const result = {};
  const maxContinuations = normalizeIntegerInRange(value.maxContinuations, 1, 50);
  if (maxContinuations !== undefined) result.maxContinuations = maxContinuations;
  const cooldownMs = normalizeIntegerInRange(value.cooldownMs, 0, 30000);
  if (cooldownMs !== undefined) result.cooldownMs = cooldownMs;
  if (typeof value.autoEnable === 'boolean') result.autoEnable = value.autoEnable;
  const threshold = normalizeIntegerInRange(value.autoEnableThreshold, 1, 50);
  if (threshold !== undefined) result.autoEnableThreshold = threshold;
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeCouncilConfig(value) {
  if (!isPlainObject(value)) return undefined;
  const result = cloneJson(value);
  const defaultPreset = normalizeString(result.default_preset);
  if (defaultPreset) result.default_preset = defaultPreset;
  const timeout = normalizeIntegerMin(result.timeout, 1);
  if (timeout !== undefined) result.timeout = timeout;
  const mode = normalizeString(result.councillor_execution_mode);
  if (mode && !COUNCILLOR_MODES.has(mode)) delete result.councillor_execution_mode;
  const retries = normalizeIntegerInRange(result.councillor_retries, 0, 5);
  if (retries !== undefined) result.councillor_retries = retries;
  return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeSlimConfig(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const result = {};
  const schema = normalizeString(source.$schema);
  if (schema) result.$schema = schema;
  const preset = normalizeString(source.preset);
  if (preset) result.preset = preset;
  const presets = normalizePresets(source.presets);
  if (presets) result.presets = presets;
  const agents = normalizeAgentRecord(source.agents);
  if (Object.keys(agents).length > 0) result.agents = agents;
  const disabledAgents = normalizeDisabledAgents(source.disabled_agents);
  if (disabledAgents !== undefined) result.disabled_agents = disabledAgents;
  if (typeof source.autoUpdate === 'boolean') result.autoUpdate = source.autoUpdate;
  const disabledMcps = normalizeStringArray(source.disabled_mcps);
  if (disabledMcps !== undefined) result.disabled_mcps = disabledMcps;
  const fallback = normalizeFallbackConfig(source.fallback);
  if (fallback) result.fallback = fallback;
  const multiplexer = normalizeMultiplexerConfig(source.multiplexer);
  if (multiplexer) result.multiplexer = multiplexer;
  const council = normalizeCouncilConfig(source.council);
  if (council) result.council = council;
  const divoom = normalizeDivoomConfig(source.divoom);
  if (divoom) result.divoom = divoom;
  const interview = normalizeInterviewConfig(source.interview);
  if (interview) result.interview = interview;
  const sessionManager = normalizeSessionManagerConfig(source.sessionManager);
  if (sessionManager) result.sessionManager = sessionManager;
  const todoContinuation = normalizeTodoContinuationConfig(source.todoContinuation);
  if (todoContinuation) result.todoContinuation = todoContinuation;
  return result;
}

function getEffectiveConfig(userConfig, projectConfig) {
  return deepMerge(userConfig, projectConfig);
}

function getActivePresetName(config) {
  const preset = normalizeString(config.preset);
  if (preset) return preset;
  const names = isPlainObject(config.presets) ? Object.keys(config.presets) : [];
  return names[0] ?? '';
}

function getEffectiveAgents(config) {
  const presetName = getActivePresetName(config);
  const presetAgents = isPlainObject(config.presets?.[presetName]) ? config.presets[presetName] : {};
  return deepMerge(presetAgents, isPlainObject(config.agents) ? config.agents : {}) ?? {};
}

function buildAgentItems(userConfig, projectConfig) {
  const userAgents = getEffectiveAgents(userConfig);
  const projectAgents = getEffectiveAgents(projectConfig);
  const disabled = new Set(Array.isArray(userConfig.disabled_agents) ? userConfig.disabled_agents : ['observer']);
  const projectDisabled = new Set(Array.isArray(projectConfig.disabled_agents) ? projectConfig.disabled_agents : []);
  const knownIds = new Set();
  const items = [];
  for (const [id, label, description, group, defaults] of AGENT_DEFINITIONS) {
    knownIds.add(id);
    items.push({
      id,
      label,
      description,
      group,
      defaultModel: defaults.model ?? null,
      defaultVariant: defaults.variant ?? null,
      disabled: disabled.has(id),
      projectDisabled: projectDisabled.has(id),
      override: isPlainObject(userAgents[id]) ? userAgents[id] : null,
      projectOverride: Boolean(projectAgents[id]),
    });
  }
  const customIds = Array.from(new Set([
    ...Object.keys(userAgents),
    ...Object.keys(projectAgents),
  ])).filter((id) => !knownIds.has(id)).sort();
  for (const id of customIds) {
    items.push({
      id,
      label: id,
      description: 'Custom / Unknown',
      group: 'custom',
      defaultModel: null,
      defaultVariant: null,
      disabled: disabled.has(id),
      projectDisabled: projectDisabled.has(id),
      override: isPlainObject(userAgents[id]) ? userAgents[id] : null,
      projectOverride: Boolean(projectAgents[id]),
    });
  }
  return items;
}

function updateJsoncProperty(content, key, shouldUpdate, value) {
  if (!shouldUpdate) return content;
  const nextValue = value === undefined ? undefined : value;
  const edits = modifyJsonc(content, [key], nextValue, {
    formattingOptions: JSONC_FORMATTING_OPTIONS,
  });
  return applyEdits(content, edits);
}

function readSlimConfig(options = {}) {
  const directory = normalizeString(options.directory);
  const configDir = getOpenCodeConfigDir();
  const targetDetection = detectConfigFile(configDir);
  const targetConfig = readJsoncFile(targetDetection.path);
  const projectDetection = detectProjectConfigFile(directory);
  const projectConfig = projectDetection?.exists ? readJsoncFile(projectDetection.path) : {};
  const effective = getEffectiveConfig(targetConfig, projectConfig);
  return {
    plugin: findPluginEntry(directory),
    target: {
      scope: 'user',
      path: targetDetection.path,
      exists: targetDetection.exists,
      format: targetDetection.format,
      mtimeMs: getFileMtimeMs(targetDetection.path),
    },
    project: {
      path: projectDetection?.exists ? projectDetection.path : null,
      exists: Boolean(projectDetection?.exists),
      overriddenKeys: Object.keys(projectConfig).sort(),
    },
    raw: targetConfig,
    projectRaw: projectConfig,
    effective,
    presets: Object.keys(isPlainObject(targetConfig.presets) ? targetConfig.presets : {}).sort(),
    agents: buildAgentItems(targetConfig, projectConfig),
  };
}

function saveSlimConfig(input = {}) {
  const configDir = getOpenCodeConfigDir();
  const targetDetection = detectConfigFile(configDir);
  const targetPath = targetDetection.path;
  if (hasMtimeMismatch(targetPath, input.expectedMtimeMs)) {
    throw createConfigModifiedError();
  }

  const originalConfig = isPlainObject(input.config) ? input.config : {};
  const sanitized = sanitizeSlimConfig(originalConfig);
  const requestedKeys = new Set(Object.keys(originalConfig).filter((key) => TOP_LEVEL_KEYS.includes(key)));
  if (!requestedKeys.has('$schema') && !targetDetection.exists) {
    sanitized.$schema = SCHEMA_URL;
    requestedKeys.add('$schema');
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  let content = targetDetection.exists ? fs.readFileSync(targetPath, 'utf8') : '{\n}\n';
  if (!content.trim()) content = '{\n}\n';

  for (const key of TOP_LEVEL_KEYS) {
    content = updateJsoncProperty(content, key, requestedKeys.has(key), sanitized[key]);
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
  return readSlimConfig();
}

function ensureSlimStarterConfig() {
  const configDir = getOpenCodeConfigDir();
  const targetDetection = detectConfigFile(configDir);
  if (targetDetection.exists) return readSlimConfig();
  fs.mkdirSync(path.dirname(targetDetection.path), { recursive: true });
  fs.writeFileSync(targetDetection.path, `${JSON.stringify(STARTER_CONFIG, null, 2)}\n`, 'utf8');
  return readSlimConfig();
}

export {
  CONFIG_BASENAME,
  PLUGIN_NAME,
  SCHEMA_URL,
  STARTER_CONFIG,
  readSlimConfig,
  saveSlimConfig,
  sanitizeSlimConfig,
  ensureSlimStarterConfig,
};
