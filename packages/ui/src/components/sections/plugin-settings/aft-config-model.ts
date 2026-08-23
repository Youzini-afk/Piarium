import type { PiConfigScope } from '@piarium/protocol';
import { type JsonObject } from './plugin-config-model';

export type AftDraftIssueCode =
  | 'ignored-project'
  | 'invalid-boolean'
  | 'invalid-number'
  | 'invalid-value'
  | 'unknown-field';

export interface AftDraftIssue {
  blocking: boolean;
  code: AftDraftIssueCode;
  field: string;
}

export type AftBashDraftMode = 'custom' | 'false' | 'true' | 'unset';

const FORMATTERS = new Set([
  'biome',
  'oxfmt',
  'prettier',
  'deno',
  'ruff',
  'black',
  'rustfmt',
  'goimports',
  'gofmt',
  'none',
]);
const CHECKERS = new Set([
  'tsc',
  'tsgo',
  'biome',
  'pyright',
  'ruff',
  'cargo',
  'go',
  'staticcheck',
  'none',
]);

const KNOWN_TOP_LEVEL_FIELDS = new Set([
  '$schema',
  'enabled',
  'edit_mode',
  'format_on_edit',
  'formatter_timeout_secs',
  'validate_on_edit',
  'formatter',
  'checker',
  'configure_warnings_delivery',
  'tool_surface',
  'disabled_tools',
  'restrict_to_project_root',
  'search_index',
  'semantic_search',
  'callgraph_store',
  'callgraph_chunk_size',
  'inspect',
  'gh_shim',
  'backup',
  'worktree',
  'sandbox',
  'bash',
  'experimental',
  'lsp',
  'url_fetch_allow_private',
  'semantic',
  'bridge',
  'subc',
]);

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const isInteger = (value: unknown): value is number => Number.isInteger(value);

const nonEmptyString = (value: unknown): boolean => (
  typeof value === 'string' && value.trim().length > 0
);

const stringArray = (value: unknown, nonEmpty = false): boolean => (
  Array.isArray(value)
  && value.every((entry) => typeof entry === 'string' && (!nonEmpty || entry.trim().length > 0))
);

const issue = (
  issues: AftDraftIssue[],
  code: AftDraftIssueCode,
  field: string,
  blocking = code !== 'ignored-project' && code !== 'unknown-field',
): void => {
  if (!issues.some((candidate) => candidate.code === code && candidate.field === field)) {
    issues.push({ blocking, code, field });
  }
};

const validateBoolean = (
  value: unknown,
  field: string,
  issues: AftDraftIssue[],
): void => {
  if (typeof value !== 'boolean') issue(issues, 'invalid-boolean', field);
};

const validateNumber = (
  value: unknown,
  field: string,
  issues: AftDraftIssue[],
  options: { integer?: boolean; max?: number; min?: number } = {},
): void => {
  if (
    !isFiniteNumber(value)
    || (options.integer === true && !isInteger(value))
    || (options.min !== undefined && value < options.min)
    || (options.max !== undefined && value > options.max)
  ) issue(issues, 'invalid-number', field);
};

const validateEnum = (
  value: unknown,
  field: string,
  allowed: ReadonlySet<string>,
  issues: AftDraftIssue[],
): void => {
  if (typeof value !== 'string' || !allowed.has(value)) issue(issues, 'invalid-value', field);
};

const validateStringRecord = (
  value: unknown,
  field: string,
  issues: AftDraftIssue[],
  allowedValues?: ReadonlySet<string>,
): void => {
  if (!isObject(value)) {
    issue(issues, 'invalid-value', field);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' || (allowedValues && !allowedValues.has(entry))) {
      issue(issues, 'invalid-value', `${field}.${key}`);
    }
  }
};

const validateInspect = (value: unknown, issues: AftDraftIssue[]): void => {
  if (!isObject(value)) {
    issue(issues, 'invalid-value', 'inspect');
    return;
  }
  if ('enabled' in value) validateBoolean(value.enabled, 'inspect.enabled', issues);
  if ('tier2_idle_minutes' in value) validateNumber(value.tier2_idle_minutes, 'inspect.tier2_idle_minutes', issues, { min: 0 });
  if ('tier2_soft_deadline_ms' in value) validateNumber(value.tier2_soft_deadline_ms, 'inspect.tier2_soft_deadline_ms', issues, { integer: true, min: 1 });
  if ('diagnostics_timeout_ms' in value) validateNumber(value.diagnostics_timeout_ms, 'inspect.diagnostics_timeout_ms', issues, { integer: true, min: 10_000, max: 600_000 });
  if ('max_drill_down_items' in value) validateNumber(value.max_drill_down_items, 'inspect.max_drill_down_items', issues, { integer: true, min: 1, max: 100 });
  if ('categories' in value) {
    if (!isObject(value.categories)) issue(issues, 'invalid-value', 'inspect.categories');
    else for (const [key, entry] of Object.entries(value.categories)) validateBoolean(entry, `inspect.categories.${key}`, issues);
  }
  if ('duplicates' in value) {
    if (!isObject(value.duplicates)) issue(issues, 'invalid-value', 'inspect.duplicates');
    else if ('expected_mirrors' in value.duplicates) {
      const mirrors = value.duplicates.expected_mirrors;
      if (
        !Array.isArray(mirrors)
        || mirrors.some((entry) => (
          !Array.isArray(entry)
          || entry.length !== 2
          || entry.some((part) => !nonEmptyString(part))
        ))
      ) issue(issues, 'invalid-value', 'inspect.duplicates.expected_mirrors');
    }
  }
};

const validateBackup = (value: unknown, issues: AftDraftIssue[]): void => {
  if (!isObject(value)) {
    issue(issues, 'invalid-value', 'backup');
    return;
  }
  if ('enabled' in value) validateBoolean(value.enabled, 'backup.enabled', issues);
  if ('max_depth' in value) validateNumber(value.max_depth, 'backup.max_depth', issues, { integer: true, min: 1 });
  if ('max_file_size' in value) validateNumber(value.max_file_size, 'backup.max_file_size', issues, { integer: true, min: 1 });
};

const validateSandbox = (value: unknown, issues: AftDraftIssue[]): void => {
  if (!isObject(value)) {
    issue(issues, 'invalid-value', 'sandbox');
    return;
  }
  if ('enabled' in value) validateBoolean(value.enabled, 'sandbox.enabled', issues);
  for (const key of ['write_allow', 'read_deny'] as const) {
    if (key in value && !stringArray(value[key])) issue(issues, 'invalid-value', `sandbox.${key}`);
  }
};

const validateBashObject = (
  value: Record<string, unknown>,
  field: 'bash' | 'experimental.bash',
  issues: AftDraftIssue[],
): void => {
  for (const key of ['rewrite', 'compress', 'background'] as const) {
    if (key in value) validateBoolean(value[key], `${field}.${key}`, issues);
  }
  if (field === 'bash' && 'host_fallback' in value) validateBoolean(value.host_fallback, `${field}.host_fallback`, issues);
  if ('long_running_reminder_enabled' in value) validateBoolean(value.long_running_reminder_enabled, `${field}.long_running_reminder_enabled`, issues);
  if ('long_running_reminder_interval_ms' in value) validateNumber(value.long_running_reminder_interval_ms, `${field}.long_running_reminder_interval_ms`, issues, { integer: true, min: 1 });
  if (field === 'bash' && 'foreground_wait_window_ms' in value) validateNumber(value.foreground_wait_window_ms, `${field}.foreground_wait_window_ms`, issues, { integer: true, min: 1 });
};

const validateBash = (value: unknown, issues: AftDraftIssue[]): void => {
  if (typeof value === 'boolean') return;
  if (!isObject(value)) {
    issue(issues, 'invalid-value', 'bash');
    return;
  }
  validateBashObject(value, 'bash', issues);
};

const validateExperimental = (value: unknown, issues: AftDraftIssue[]): void => {
  if (!isObject(value)) {
    issue(issues, 'invalid-value', 'experimental');
    return;
  }
  if ('lsp_ty' in value) validateBoolean(value.lsp_ty, 'experimental.lsp_ty', issues);
  if ('bash' in value) {
    if (!isObject(value.bash)) issue(issues, 'invalid-value', 'experimental.bash');
    else validateBashObject(value.bash, 'experimental.bash', issues);
  }
};

const validateLspServer = (
  value: unknown,
  field: string,
  issues: AftDraftIssue[],
): void => {
  if (!isObject(value)) {
    issue(issues, 'invalid-value', field);
    return;
  }
  if ('extensions' in value) {
    if (
      !Array.isArray(value.extensions)
      || value.extensions.length === 0
      || value.extensions.some((entry) => (
        typeof entry !== 'string'
        || entry.trim().length === 0
        || entry.trim().replace(/^\.+/, '').length === 0
      ))
    ) issue(issues, 'invalid-value', `${field}.extensions`);
  }
  if ('binary' in value && !nonEmptyString(value.binary)) issue(issues, 'invalid-value', `${field}.binary`);
  if ('args' in value && !stringArray(value.args)) issue(issues, 'invalid-value', `${field}.args`);
  if ('root_markers' in value && !stringArray(value.root_markers, true)) issue(issues, 'invalid-value', `${field}.root_markers`);
  if ('disabled' in value) validateBoolean(value.disabled, `${field}.disabled`, issues);
  if ('env' in value) {
    if (!isObject(value.env)) issue(issues, 'invalid-value', `${field}.env`);
    else for (const [key, entry] of Object.entries(value.env)) {
      if (!key || typeof entry !== 'string') issue(issues, 'invalid-value', `${field}.env`);
    }
  }
};

const validateLsp = (value: unknown, issues: AftDraftIssue[]): void => {
  if (!isObject(value)) {
    issue(issues, 'invalid-value', 'lsp');
    return;
  }
  if ('servers' in value) {
    if (!isObject(value.servers)) issue(issues, 'invalid-value', 'lsp.servers');
    else for (const [serverId, server] of Object.entries(value.servers)) {
      if (!serverId.trim()) issue(issues, 'invalid-value', 'lsp.servers');
      else validateLspServer(server, `lsp.servers.${serverId}`, issues);
    }
  }
  if ('disabled' in value && !stringArray(value.disabled, true)) issue(issues, 'invalid-value', 'lsp.disabled');
  if ('python' in value) validateEnum(value.python, 'lsp.python', new Set(['pyright', 'ty', 'auto']), issues);
  if ('diagnostics_on_edit' in value) validateBoolean(value.diagnostics_on_edit, 'lsp.diagnostics_on_edit', issues);
  if ('auto_install' in value) validateBoolean(value.auto_install, 'lsp.auto_install', issues);
  if ('grace_days' in value) validateNumber(value.grace_days, 'lsp.grace_days', issues, { integer: true, min: 1 });
  if ('versions' in value) {
    if (!isObject(value.versions)) issue(issues, 'invalid-value', 'lsp.versions');
    else for (const [key, entry] of Object.entries(value.versions)) {
      if (!key.trim() || !nonEmptyString(entry)) issue(issues, 'invalid-value', 'lsp.versions');
    }
  }
};

const validateSemantic = (value: unknown, issues: AftDraftIssue[]): void => {
  if (!isObject(value)) {
    issue(issues, 'invalid-value', 'semantic');
    return;
  }
  if ('backend' in value) validateEnum(value.backend, 'semantic.backend', new Set(['fastembed', 'openai_compatible', 'ollama']), issues);
  for (const key of ['model', 'base_url', 'api_key_env'] as const) {
    if (key in value && !nonEmptyString(value[key])) issue(issues, 'invalid-value', `semantic.${key}`);
  }
  for (const key of ['timeout_ms', 'query_timeout_ms', 'max_batch_size', 'max_files'] as const) {
    if (key in value) validateNumber(value[key], `semantic.${key}`, issues, { integer: true, min: 1 });
  }
};

const validateBridge = (value: unknown, issues: AftDraftIssue[]): void => {
  if (!isObject(value)) {
    issue(issues, 'invalid-value', 'bridge');
    return;
  }
  if ('request_timeout_ms' in value) validateNumber(value.request_timeout_ms, 'bridge.request_timeout_ms', issues, { integer: true, min: 1000 });
  if ('hang_threshold' in value) validateNumber(value.hang_threshold, 'bridge.hang_threshold', issues, { integer: true, min: 1 });
};

const validateSubc = (value: unknown, issues: AftDraftIssue[]): void => {
  if (!isObject(value)) {
    issue(issues, 'invalid-value', 'subc');
    return;
  }
  if ('client_reaper' in value) validateBoolean(value.client_reaper, 'subc.client_reaper', issues);
  if ('connection_file' in value && typeof value.connection_file !== 'string') issue(issues, 'invalid-value', 'subc.connection_file');
};

const validateKnownFields = (draft: JsonObject, issues: AftDraftIssue[]): void => {
  for (const key of ['$schema'] as const) {
    if (key in draft && typeof draft[key] !== 'string') issue(issues, 'invalid-value', key);
  }
  for (const key of [
    'enabled',
    'format_on_edit',
    'restrict_to_project_root',
    'search_index',
    'semantic_search',
    'callgraph_store',
    'url_fetch_allow_private',
  ] as const) {
    if (key in draft) validateBoolean(draft[key], key, issues);
  }
  if ('edit_mode' in draft) validateEnum(draft.edit_mode, 'edit_mode', new Set(['default', 'hashline']), issues);
  if ('validate_on_edit' in draft) validateEnum(draft.validate_on_edit, 'validate_on_edit', new Set(['syntax', 'full']), issues);
  if ('configure_warnings_delivery' in draft) validateEnum(draft.configure_warnings_delivery, 'configure_warnings_delivery', new Set(['toast', 'log', 'chat']), issues);
  if ('tool_surface' in draft) validateEnum(draft.tool_surface, 'tool_surface', new Set(['minimal', 'recommended', 'all']), issues);
  if ('formatter_timeout_secs' in draft) validateNumber(draft.formatter_timeout_secs, 'formatter_timeout_secs', issues, { integer: true, min: 1, max: 600 });
  if ('callgraph_chunk_size' in draft) validateNumber(draft.callgraph_chunk_size, 'callgraph_chunk_size', issues);
  if ('formatter' in draft) validateStringRecord(draft.formatter, 'formatter', issues, FORMATTERS);
  if ('checker' in draft) validateStringRecord(draft.checker, 'checker', issues, CHECKERS);
  if ('disabled_tools' in draft && !stringArray(draft.disabled_tools)) issue(issues, 'invalid-value', 'disabled_tools');
  if ('inspect' in draft) validateInspect(draft.inspect, issues);
  if ('gh_shim' in draft) {
    if (!isObject(draft.gh_shim)) issue(issues, 'invalid-value', 'gh_shim');
    else if ('enabled' in draft.gh_shim) validateBoolean(draft.gh_shim.enabled, 'gh_shim.enabled', issues);
  }
  if ('backup' in draft) validateBackup(draft.backup, issues);
  if ('worktree' in draft) {
    if (!isObject(draft.worktree)) issue(issues, 'invalid-value', 'worktree');
    else if ('ram_overlay' in draft.worktree) validateBoolean(draft.worktree.ram_overlay, 'worktree.ram_overlay', issues);
  }
  if ('sandbox' in draft) validateSandbox(draft.sandbox, issues);
  if ('bash' in draft) validateBash(draft.bash, issues);
  if ('experimental' in draft) validateExperimental(draft.experimental, issues);
  if ('lsp' in draft) validateLsp(draft.lsp, issues);
  if ('semantic' in draft) validateSemantic(draft.semantic, issues);
  if ('bridge' in draft) validateBridge(draft.bridge, issues);
  if ('subc' in draft) validateSubc(draft.subc, issues);
};

const diagnoseUnknownTopLevel = (draft: JsonObject, issues: AftDraftIssue[]): void => {
  for (const key of Object.keys(draft)) {
    if (!KNOWN_TOP_LEVEL_FIELDS.has(key)) issue(issues, 'unknown-field', key, false);
  }
};

const diagnoseIgnoredProjectFields = (draft: JsonObject, issues: AftDraftIssue[]): void => {
  for (const field of [
    'restrict_to_project_root',
    'url_fetch_allow_private',
    'bridge',
    'backup',
    'subc',
    'formatter_timeout_secs',
    'gh_shim',
  ]) {
    if (field in draft) issue(issues, 'ignored-project', field, false);
  }
  if (Array.isArray(draft.disabled_tools) && draft.disabled_tools.includes('aft_safety')) {
    issue(issues, 'ignored-project', 'disabled_tools.aft_safety', false);
  }
  if (isObject(draft.semantic)) {
    for (const key of ['backend', 'base_url', 'api_key_env', 'query_timeout_ms']) {
      if (key in draft.semantic) issue(issues, 'ignored-project', `semantic.${key}`, false);
    }
  }
  if (isObject(draft.lsp)) {
    for (const key of ['servers', 'disabled', 'auto_install', 'grace_days', 'versions']) {
      if (key in draft.lsp) issue(issues, 'ignored-project', `lsp.${key}`, false);
    }
  }
  if (isObject(draft.sandbox)) {
    if (draft.sandbox.enabled === false) issue(issues, 'ignored-project', 'sandbox.enabled', false);
    if ('write_allow' in draft.sandbox) issue(issues, 'ignored-project', 'sandbox.write_allow', false);
  }
};

export const aftDraftIssues = (
  draft: JsonObject,
  scope: PiConfigScope,
): AftDraftIssue[] => {
  const issues: AftDraftIssue[] = [];
  validateKnownFields(draft, issues);
  diagnoseUnknownTopLevel(draft, issues);
  if (scope === 'project') diagnoseIgnoredProjectFields(draft, issues);
  return issues;
};

export const aftBashDraftMode = (draft: JsonObject): AftBashDraftMode => {
  if (!Object.prototype.hasOwnProperty.call(draft, 'bash')) return 'unset';
  if (draft.bash === true) return 'true';
  if (draft.bash === false) return 'false';
  return 'custom';
};

export const AFT_TOOL_SURFACES = ['minimal', 'recommended', 'all'] as const;
export const AFT_EDIT_MODES = ['default', 'hashline'] as const;
export const AFT_VALIDATION_MODES = ['syntax', 'full'] as const;
export const AFT_WARNING_DELIVERY = ['toast', 'log', 'chat'] as const;
export const AFT_PYTHON_LSP = ['pyright', 'ty', 'auto'] as const;
export const AFT_SEMANTIC_BACKENDS = ['fastembed', 'openai_compatible', 'ollama'] as const;
