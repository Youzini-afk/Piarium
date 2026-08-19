import type { PiConfigScope } from '@piarium/protocol';
import {
  hasJsonPath,
  readJsonPath,
  type JsonObject,
} from './plugin-config-model';

export type PiLensDraftIssueCode =
  | 'invalid-boolean'
  | 'invalid-number'
  | 'invalid-value'
  | 'project-global-only';

export interface PiLensDraftIssue {
  code: PiLensDraftIssueCode;
  field: string;
}

const GLOBAL_BOOLEAN_PATHS = [
  ['lens', 'enabled'],
  ['lsp', 'enabled'],
  ['tests', 'enabled'],
  ['delta', 'enabled'],
  ['opengrep', 'enabled'],
  ['readGuard', 'enabled'],
  ['turnEnd', 'madge', 'enabled'],
  ['format', 'enabled'],
  ['autofix', 'enabled'],
  ['contextInjection', 'enabled'],
  ['turnSummary', 'enabled'],
  ['actionableWarnings', 'enabled'],
  ['actionableWarnings', 'includeLspCodeActions'],
  ['actionableWarnings', 'deltaOnly'],
  ['actionableWarnings', 'autoFix', 'enabled'],
  ['tools', 'lazy'],
  ['ui', 'compactToolLine'],
  ['widget', 'visible'],
  ['guard', 'enabled'],
] as const;

const PROJECT_BOOLEAN_PATHS = [
  ['format', 'enabled'],
  ['autofix', 'enabled'],
  ['actionableWarnings', 'autoFix', 'enabled'],
  ['trivy', 'enabled'],
  ['helm', 'renderValidation', 'enabled'],
] as const;

const GLOBAL_ONLY_PROJECT_PATHS = [
  ['lens', 'enabled'],
  ['lsp', 'enabled'],
  ['tests', 'enabled'],
  ['delta', 'enabled'],
  ['opengrep', 'enabled'],
  ['readGuard', 'enabled'],
  ['contextInjection', 'enabled'],
  ['turnSummary', 'enabled'],
  ['turnEnd', 'madge', 'enabled'],
  ['guard', 'enabled'],
  ['tools', 'lazy'],
  ['ui', 'compactToolLine'],
  ['widget', 'visible'],
  ['dispatch', 'runnerTimeoutFloorMs'],
  ['format', 'mode'],
  ['actionableWarnings', 'enabled'],
  ['actionableWarnings', 'includeLspCodeActions'],
  ['actionableWarnings', 'deltaOnly'],
  ['actionableWarnings', 'autoFix', 'maxFixes'],
] as const;

const TRIVY_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

const isObject = (value: unknown): value is JsonObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const pathLabel = (path: readonly string[]): string => path.join('.');

const issueForBoolean = (draft: JsonObject, path: readonly string[]): PiLensDraftIssue | null => (
  hasJsonPath(draft, path) && typeof readJsonPath(draft, path) !== 'boolean'
    ? { code: 'invalid-boolean', field: pathLabel(path) }
    : null
);

const issueForPositiveNumber = (draft: JsonObject, path: readonly string[]): PiLensDraftIssue | null => {
  if (!hasJsonPath(draft, path)) return null;
  const value = readJsonPath(draft, path);
  return typeof value !== 'number' || !Number.isFinite(value) || value <= 0
    ? { code: 'invalid-number', field: pathLabel(path) }
    : null;
};

const issueForPositiveNumericValue = (
  draft: JsonObject,
  path: readonly string[],
): PiLensDraftIssue | null => {
  if (!hasJsonPath(draft, path)) return null;
  const raw = readJsonPath(draft, path);
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof value !== 'number' || !Number.isFinite(value) || value <= 0
    ? { code: 'invalid-number', field: pathLabel(path) }
    : null;
};

const issueForNonNegativeNumber = (draft: JsonObject, path: readonly string[]): PiLensDraftIssue | null => {
  if (!hasJsonPath(draft, path)) return null;
  const value = readJsonPath(draft, path);
  return typeof value !== 'number' || !Number.isFinite(value) || value < 0
    ? { code: 'invalid-number', field: pathLabel(path) }
    : null;
};

const issueForStringArray = (draft: JsonObject, path: readonly string[]): PiLensDraftIssue | null => {
  if (!hasJsonPath(draft, path)) return null;
  const value = readJsonPath(draft, path);
  return !Array.isArray(value) || value.some((entry) => typeof entry !== 'string')
    ? { code: 'invalid-value', field: pathLabel(path) }
    : null;
};

const issueForObject = (draft: JsonObject, path: readonly string[]): PiLensDraftIssue | null => {
  if (!hasJsonPath(draft, path)) return null;
  return isObject(readJsonPath(draft, path))
    ? null
    : { code: 'invalid-value', field: pathLabel(path) };
};

const firstIssue = (...issues: Array<PiLensDraftIssue | null>): PiLensDraftIssue | null => (
  issues.find((issue): issue is PiLensDraftIssue => issue !== null) ?? null
);

const pushIssue = (issues: PiLensDraftIssue[], issue: PiLensDraftIssue | null): void => {
  if (issue && !issues.some((candidate) => candidate.code === issue.code && candidate.field === issue.field)) {
    issues.push(issue);
  }
};

const validateRules = (draft: JsonObject, issues: PiLensDraftIssue[]): void => {
  if (!hasJsonPath(draft, ['rules'])) return;
  const rules = readJsonPath(draft, ['rules']);
  if (!isObject(rules)) {
    issues.push({ code: 'invalid-value', field: 'rules' });
    return;
  }
  for (const [ruleId, rawRule] of Object.entries(rules)) {
    if (!isObject(rawRule)) {
      pushIssue(issues, { code: 'invalid-value', field: `rules.${ruleId}` });
      continue;
    }
    if ('threshold' in rawRule) {
      const threshold = rawRule.threshold;
      if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0) {
        pushIssue(issues, { code: 'invalid-number', field: `rules.${ruleId}.threshold` });
      }
    }
    for (const key of ['disable', 'select'] as const) {
      if (!(key in rawRule)) continue;
      const value = rawRule[key];
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        pushIssue(issues, { code: 'invalid-value', field: `rules.${ruleId}.${key}` });
      }
    }
  }
};

const validateGlobal = (draft: JsonObject): PiLensDraftIssue[] => {
  const issues: PiLensDraftIssue[] = [];
  for (const path of GLOBAL_BOOLEAN_PATHS) pushIssue(issues, issueForBoolean(draft, path));
  pushIssue(issues, firstIssue(
    issueForObject(draft, ['format']),
    issueForObject(draft, ['autofix']),
  ));
  if (hasJsonPath(draft, ['format', 'mode'])) {
    const mode = readJsonPath(draft, ['format', 'mode']);
    if (mode !== 'deferred' && mode !== 'immediate') {
      issues.push({ code: 'invalid-value', field: 'format.mode' });
    }
  }
  pushIssue(issues, issueForPositiveNumber(draft, ['dispatch', 'runnerTimeoutFloorMs']));
  pushIssue(issues, issueForNonNegativeNumber(draft, ['actionableWarnings', 'autoFix', 'maxFixes']));
  pushIssue(issues, issueForStringArray(draft, ['ignore']));
  return issues;
};

const validateProject = (draft: JsonObject): PiLensDraftIssue[] => {
  const issues: PiLensDraftIssue[] = [];
  for (const path of PROJECT_BOOLEAN_PATHS) pushIssue(issues, issueForBoolean(draft, path));
  pushIssue(issues, issueForObject(draft, ['format']));
  pushIssue(issues, issueForObject(draft, ['autofix']));
  pushIssue(issues, issueForObject(draft, ['actionableWarnings']));
  pushIssue(issues, issueForObject(draft, ['actionableWarnings', 'autoFix']));
  pushIssue(issues, issueForStringArray(draft, ['ignore']));
  pushIssue(issues, issueForPositiveNumber(draft, ['maxProjectFiles']));
  pushIssue(issues, issueForObject(draft, ['reviewGraph']));
  pushIssue(issues, issueForPositiveNumericValue(draft, ['reviewGraph', 'maxFiles']));
  pushIssue(issues, issueForObject(draft, ['trivy']));
  if (hasJsonPath(draft, ['trivy', 'minSeverity'])) {
    const severity = readJsonPath(draft, ['trivy', 'minSeverity']);
    if (typeof severity !== 'string' || !(TRIVY_SEVERITIES as readonly string[]).includes(severity.toUpperCase())) {
      issues.push({ code: 'invalid-value', field: 'trivy.minSeverity' });
    }
  }
  pushIssue(issues, issueForObject(draft, ['helm']));
  pushIssue(issues, issueForObject(draft, ['helm', 'renderValidation']));
  validateRules(draft, issues);
  for (const path of GLOBAL_ONLY_PROJECT_PATHS) {
    if (!hasJsonPath(draft, path)) continue;
    pushIssue(issues, { code: 'project-global-only', field: pathLabel(path) });
  }
  return issues;
};

export const piLensDraftIssues = (
  draft: JsonObject,
  scope: PiConfigScope,
): PiLensDraftIssue[] => scope === 'project' ? validateProject(draft) : validateGlobal(draft);

export const piLensDraftIssue = (
  draft: JsonObject,
  scope: PiConfigScope,
): PiLensDraftIssue | null => piLensDraftIssues(draft, scope)[0] ?? null;

export const PI_LENS_TRIVY_SEVERITIES = TRIVY_SEVERITIES;
