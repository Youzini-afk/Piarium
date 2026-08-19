import { type JsonObject } from './plugin-config-model';

export type HermesMemoryDraftIssueCode =
  | 'invalid-boolean'
  | 'invalid-number'
  | 'invalid-value'
  | 'modern-overrides-legacy'
  | 'unknown-field';

export interface HermesMemoryDraftIssue {
  blocking: boolean;
  code: HermesMemoryDraftIssueCode;
  field: string;
}

const MEMORY_MODES = new Set(['policy-only', 'legacy-inject']);
const POLICY_STYLES = new Set(['full', 'compact', 'custom', 'none']);
const REVIEW_TRANSPORTS = new Set(['direct', 'subprocess']);
const OVERFLOW_STRATEGIES = new Set(['auto-consolidate', 'reject', 'fifo-evict']);
const SESSION_SEARCH_VARIANTS = new Set(['legacy', 'anchors']);
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

const KNOWN_TOP_LEVEL_FIELDS = new Set([
  'memoryMode',
  'memoryPolicyStyle',
  'memoryPolicyCustomText',
  'memoryCharLimit',
  'userCharLimit',
  'projectCharLimit',
  'nudgeInterval',
  'reviewRecentMessages',
  'reviewEnabled',
  'reviewTransport',
  'flushOnCompact',
  'flushOnShutdown',
  'flushMinTurns',
  'flushRecentMessages',
  'memoryDir',
  'projectsMemoryDir',
  'sessionSearch',
  'llmModelOverride',
  'llmThinkingOverride',
  'childExtensionPaths',
  'memoryOverflowStrategy',
  'overflowGraceMs',
  'autoConsolidate',
  'correctionDetection',
  'correctionStrongPatterns',
  'correctionWeakPatterns',
  'correctionNegativePatterns',
  'correctionDirectiveWords',
  'failureInjectionEnabled',
  'failureInjectionMaxAgeDays',
  'failureInjectionMaxEntries',
  'nudgeToolCalls',
  'consolidationTimeoutMs',
  'autoConsolidationWarnOnFailure',
  'standingInstructionsEnabled',
]);

const BOOLEAN_FIELDS = [
  'reviewEnabled',
  'flushOnCompact',
  'flushOnShutdown',
  'autoConsolidate',
  'correctionDetection',
  'failureInjectionEnabled',
  'autoConsolidationWarnOnFailure',
  'standingInstructionsEnabled',
] as const;

const FINITE_NUMBER_FIELDS = [
  'memoryCharLimit',
  'userCharLimit',
  'projectCharLimit',
  'nudgeInterval',
  'nudgeToolCalls',
  'flushMinTurns',
  'consolidationTimeoutMs',
  'failureInjectionMaxAgeDays',
  'failureInjectionMaxEntries',
] as const;

const NON_NEGATIVE_NUMBER_FIELDS = [
  'reviewRecentMessages',
  'flushRecentMessages',
  'overflowGraceMs',
] as const;

const STRING_ARRAY_FIELDS = [
  'childExtensionPaths',
  'correctionStrongPatterns',
  'correctionWeakPatterns',
  'correctionNegativePatterns',
  'correctionDirectiveWords',
] as const;

interface HermesMemoryDraftIssueOptions {
  agentRoot?: string;
}

type HermesPathStyle = 'posix' | 'win32';

interface HermesParsedPath {
  absolute: boolean;
  drive: string;
  segments: string[];
  style: HermesPathStyle;
}

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const hermesPathStyleFor = (samplePath: string): HermesPathStyle => (
  /^[A-Za-z]:[\\/]/.test(samplePath) || samplePath.includes('\\') ? 'win32' : 'posix'
);

const collapseHermesPathSegments = (absolute: boolean, parts: readonly string[]): string[] => {
  const segments: string[] = [];
  for (const part of parts) {
    if (part.length === 0 || part === '.') continue;
    if (part === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') {
        segments.pop();
        continue;
      }
      if (!absolute) segments.push('..');
      continue;
    }
    segments.push(part);
  }
  return segments;
};

const parseHermesPath = (input: string, style: HermesPathStyle): HermesParsedPath => {
  if (style === 'win32') {
    const driveMatch = /^[A-Za-z]:/.exec(input);
    const rest = driveMatch ? input.slice(driveMatch[0].length) : input;
    const absolute = Boolean(driveMatch && /^[\\/]/.test(rest));
    return {
      absolute,
      drive: driveMatch ? driveMatch[0].toUpperCase() : '',
      segments: collapseHermesPathSegments(absolute, rest.split(/[\\/]+/)),
      style,
    };
  }
  const absolute = input.startsWith('/');
  return {
    absolute,
    drive: '',
    segments: collapseHermesPathSegments(absolute, input.split('/')),
    style,
  };
};

const hermesSegmentsEqual = (style: HermesPathStyle, left: string, right: string): boolean => (
  style === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
);

const hermesPathHasPrefix = (
  style: HermesPathStyle,
  root: readonly string[],
  value: readonly string[],
): boolean => (
  value.length >= root.length
  && root.every((segment, index) => hermesSegmentsEqual(style, segment, value[index]!))
);

const formatHermesParentPath = (parsed: HermesParsedPath): string | undefined => {
  const parent = parsed.segments.slice(0, -1);
  if (parsed.style === 'win32') {
    const body = parent.join('\\');
    if (parsed.absolute) return `${parsed.drive}\\${body}`;
    return body.length > 0 ? body : undefined;
  }
  if (parsed.absolute) return parent.length === 0 ? '/' : `/${parent.join('/')}`;
  return parent.length > 0 ? parent.join('/') : undefined;
};

const isSafeRelativeDirectory = (segments: readonly string[]): boolean => (
  segments.length === 1 && segments[0] !== '.' && segments[0] !== '..'
);

const isTildeSpelling = (value: string): boolean => (
  value === '~' || value.startsWith('~/') || value.startsWith('~\\')
);

export const hermesAgentRootFromAuthorityPath = (authorityPath: string): string | undefined => {
  const trimmed = authorityPath.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = parseHermesPath(trimmed, hermesPathStyleFor(trimmed));
  if (parsed.segments.length === 0) return parsed.absolute && parsed.style === 'posix' ? '/' : undefined;
  return formatHermesParentPath(parsed);
};

const issue = (
  issues: HermesMemoryDraftIssue[],
  code: HermesMemoryDraftIssueCode,
  field: string,
  blocking = code !== 'modern-overrides-legacy' && code !== 'unknown-field',
): void => {
  if (!issues.some((candidate) => candidate.code === code && candidate.field === field)) {
    issues.push({ blocking, code, field });
  }
};

const validateEnum = (
  value: unknown,
  field: string,
  allowed: ReadonlySet<string>,
  issues: HermesMemoryDraftIssue[],
): void => {
  if (typeof value !== 'string' || !allowed.has(value)) issue(issues, 'invalid-value', field);
};

const validateKnownFields = (
  draft: JsonObject,
  issues: HermesMemoryDraftIssue[],
  options: HermesMemoryDraftIssueOptions,
): void => {
  if ('memoryMode' in draft) validateEnum(draft.memoryMode, 'memoryMode', MEMORY_MODES, issues);
  if ('memoryPolicyStyle' in draft) validateEnum(draft.memoryPolicyStyle, 'memoryPolicyStyle', POLICY_STYLES, issues);
  if ('reviewTransport' in draft) validateEnum(draft.reviewTransport, 'reviewTransport', REVIEW_TRANSPORTS, issues);
  if ('memoryOverflowStrategy' in draft) {
    validateEnum(draft.memoryOverflowStrategy, 'memoryOverflowStrategy', OVERFLOW_STRATEGIES, issues);
  }
  if ('llmThinkingOverride' in draft) {
    validateEnum(draft.llmThinkingOverride, 'llmThinkingOverride', THINKING_LEVELS, issues);
  }

  for (const field of BOOLEAN_FIELDS) {
    if (field in draft && typeof draft[field] !== 'boolean') issue(issues, 'invalid-boolean', field);
  }
  for (const field of FINITE_NUMBER_FIELDS) {
    if (field in draft && (typeof draft[field] !== 'number' || !Number.isFinite(draft[field]))) {
      issue(issues, 'invalid-number', field);
    }
  }
  for (const field of NON_NEGATIVE_NUMBER_FIELDS) {
    const value = draft[field];
    if (field in draft && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      issue(issues, 'invalid-number', field);
    }
  }

  if ('memoryPolicyCustomText' in draft && typeof draft.memoryPolicyCustomText !== 'string') {
    issue(issues, 'invalid-value', 'memoryPolicyCustomText');
  }
  if ('memoryDir' in draft && typeof draft.memoryDir !== 'string') {
    issue(issues, 'invalid-value', 'memoryDir');
  }
  if ('llmModelOverride' in draft && (
    typeof draft.llmModelOverride !== 'string' || draft.llmModelOverride.trim().length === 0
  )) {
    issue(issues, 'invalid-value', 'llmModelOverride');
  }
  if ('projectsMemoryDir' in draft && !validHermesProjectsMemoryDir(draft.projectsMemoryDir, options.agentRoot)) {
    issue(issues, 'invalid-value', 'projectsMemoryDir');
  }

  for (const field of STRING_ARRAY_FIELDS) {
    const value = draft[field];
    if (field in draft && (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))) {
      issue(issues, 'invalid-value', field);
    }
  }

  if ('sessionSearch' in draft) {
    if (!isObject(draft.sessionSearch)) {
      issue(issues, 'invalid-value', 'sessionSearch');
    } else {
      validateEnum(
        draft.sessionSearch.variant,
        'sessionSearch.variant',
        SESSION_SEARCH_VARIANTS,
        issues,
      );
    }
  }
};

export const validHermesProjectsMemoryDir = (value: unknown, agentRoot?: string): boolean => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes('\0')) return false;
  if (isTildeSpelling(trimmed)) return true;

  const style = hermesPathStyleFor(agentRoot ?? trimmed);
  const parsed = parseHermesPath(trimmed, style);
  if (parsed.absolute) {
    if (!agentRoot) return true;
    const root = parseHermesPath(agentRoot, style);
    if (!root.absolute) return false;
    if (style === 'win32' && parsed.drive !== root.drive) return false;
    return parsed.segments.length === root.segments.length + 1
      && hermesPathHasPrefix(style, root.segments, parsed.segments)
      && isSafeRelativeDirectory(parsed.segments.slice(-1));
  }
  return isSafeRelativeDirectory(parsed.segments);
};

export const hermesMemoryDraftIssues = (
  draft: JsonObject,
  options: HermesMemoryDraftIssueOptions = {},
): HermesMemoryDraftIssue[] => {
  const issues: HermesMemoryDraftIssue[] = [];
  validateKnownFields(draft, issues, options);
  for (const field of Object.keys(draft)) {
    if (!KNOWN_TOP_LEVEL_FIELDS.has(field)) issue(issues, 'unknown-field', field, false);
  }
  if ('memoryOverflowStrategy' in draft && 'autoConsolidate' in draft) {
    issue(issues, 'modern-overrides-legacy', 'autoConsolidate', false);
  }
  return issues;
};

export const HERMES_MEMORY_MODES = ['policy-only', 'legacy-inject'] as const;
export const HERMES_POLICY_STYLES = ['full', 'compact', 'custom', 'none'] as const;
export const HERMES_REVIEW_TRANSPORTS = ['direct', 'subprocess'] as const;
export const HERMES_OVERFLOW_STRATEGIES = ['auto-consolidate', 'reject', 'fifo-evict'] as const;
export const HERMES_SESSION_SEARCH_VARIANTS = ['legacy', 'anchors'] as const;
export const HERMES_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
