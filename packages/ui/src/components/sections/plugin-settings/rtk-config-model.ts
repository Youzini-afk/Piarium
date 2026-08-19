import type { JsonObject } from './plugin-config-model';

export type RtkDraftIssueCode =
  | 'invalid-boolean'
  | 'invalid-number'
  | 'invalid-value'
  | 'unknown-field';

export interface RtkDraftIssue {
  blocking: boolean;
  code: RtkDraftIssueCode;
  field: string;
}

const RTK_MODE_SET = new Set(['rewrite', 'suggest']);
const RTK_SOURCE_FILTER_LEVEL_SET = new Set(['none', 'minimal', 'aggressive']);

const KNOWN_TOP_LEVEL_FIELDS = new Set([
  'enabled',
  'mode',
  'guardWhenRtkMissing',
  'showRewriteNotifications',
  'outputCompaction',
]);

const KNOWN_OUTPUT_COMPACTION_FIELDS = new Set([
  'enabled',
  'stripAnsi',
  'readCompaction',
  'sourceCodeFilteringEnabled',
  'preserveExactSkillReads',
  'sourceCodeFiltering',
  'smartTruncate',
  'truncate',
  'aggregateTestOutput',
  'filterBuildOutput',
  'compactGitOutput',
  'aggregateLinterOutput',
  'groupSearchOutput',
  'trackSavings',
]);

const isObject = (value: unknown): value is JsonObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const owns = (source: JsonObject, key: string): boolean => (
  Object.prototype.hasOwnProperty.call(source, key)
);

const issue = (
  issues: RtkDraftIssue[],
  code: RtkDraftIssueCode,
  field: string,
  blocking = code !== 'unknown-field',
): void => {
  if (!issues.some((candidate) => candidate.code === code && candidate.field === field)) {
    issues.push({ blocking, code, field });
  }
};

const validateBoolean = (
  source: JsonObject,
  key: string,
  field: string,
  issues: RtkDraftIssue[],
): void => {
  if (owns(source, key) && typeof source[key] !== 'boolean') {
    issue(issues, 'invalid-boolean', field);
  }
};

const diagnoseUnknown = (
  source: JsonObject,
  known: ReadonlySet<string>,
  prefix: string,
  issues: RtkDraftIssue[],
): void => {
  for (const key of Object.keys(source)) {
    if (!known.has(key)) {
      issue(issues, 'unknown-field', prefix ? `${prefix}.${key}` : key, false);
    }
  }
};

const validateEnabledObject = (
  parent: JsonObject,
  key: 'readCompaction',
  prefix: string,
  issues: RtkDraftIssue[],
): void => {
  if (!owns(parent, key)) return;
  const value = parent[key];
  if (!isObject(value)) {
    issue(issues, 'invalid-value', prefix);
    return;
  }
  validateBoolean(value, 'enabled', `${prefix}.enabled`, issues);
  diagnoseUnknown(value, new Set(['enabled']), prefix, issues);
};

const validateBoundedObject = (
  parent: JsonObject,
  key: 'smartTruncate' | 'truncate',
  numberKey: 'maxChars' | 'maxLines',
  min: number,
  max: number,
  prefix: string,
  issues: RtkDraftIssue[],
): void => {
  if (!owns(parent, key)) return;
  const value = parent[key];
  if (!isObject(value)) {
    issue(issues, 'invalid-value', prefix);
    return;
  }
  validateBoolean(value, 'enabled', `${prefix}.enabled`, issues);
  if (owns(value, numberKey)) {
    const number = value[numberKey];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max) {
      issue(issues, 'invalid-number', `${prefix}.${numberKey}`);
    }
  }
  diagnoseUnknown(value, new Set(['enabled', numberKey]), prefix, issues);
};

const validateOutputCompaction = (
  draft: JsonObject,
  issues: RtkDraftIssue[],
): void => {
  if (!owns(draft, 'outputCompaction')) return;
  const output = draft.outputCompaction;
  if (!isObject(output)) {
    issue(issues, 'invalid-value', 'outputCompaction');
    return;
  }

  for (const key of [
    'enabled',
    'stripAnsi',
    'sourceCodeFilteringEnabled',
    'preserveExactSkillReads',
    'aggregateTestOutput',
    'filterBuildOutput',
    'compactGitOutput',
    'aggregateLinterOutput',
    'groupSearchOutput',
    'trackSavings',
  ]) {
    validateBoolean(output, key, `outputCompaction.${key}`, issues);
  }

  if (owns(output, 'sourceCodeFiltering') && (
    typeof output.sourceCodeFiltering !== 'string'
    || !RTK_SOURCE_FILTER_LEVEL_SET.has(output.sourceCodeFiltering)
  )) {
    issue(issues, 'invalid-value', 'outputCompaction.sourceCodeFiltering');
  }

  validateEnabledObject(output, 'readCompaction', 'outputCompaction.readCompaction', issues);
  validateBoundedObject(
    output,
    'smartTruncate',
    'maxLines',
    40,
    4_000,
    'outputCompaction.smartTruncate',
    issues,
  );
  validateBoundedObject(
    output,
    'truncate',
    'maxChars',
    1_000,
    200_000,
    'outputCompaction.truncate',
    issues,
  );
  diagnoseUnknown(output, KNOWN_OUTPUT_COMPACTION_FIELDS, 'outputCompaction', issues);
};

export const rtkDraftIssues = (draft: JsonObject): RtkDraftIssue[] => {
  const issues: RtkDraftIssue[] = [];
  for (const key of ['enabled', 'guardWhenRtkMissing', 'showRewriteNotifications']) {
    validateBoolean(draft, key, key, issues);
  }
  if (owns(draft, 'mode') && (
    typeof draft.mode !== 'string' || !RTK_MODE_SET.has(draft.mode)
  )) {
    issue(issues, 'invalid-value', 'mode');
  }
  validateOutputCompaction(draft, issues);
  diagnoseUnknown(draft, KNOWN_TOP_LEVEL_FIELDS, '', issues);
  return issues;
};

export const RTK_MODES = ['rewrite', 'suggest'] as const;
export const RTK_SOURCE_FILTER_LEVELS = ['none', 'minimal', 'aggressive'] as const;
