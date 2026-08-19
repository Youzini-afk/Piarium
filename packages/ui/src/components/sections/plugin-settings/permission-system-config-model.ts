import { parse, type ParseError } from 'jsonc-parser';
import type { JsonObject } from './plugin-config-model';

export type PermissionSystemDraftIssueCode =
  | 'invalid-boolean'
  | 'invalid-number'
  | 'invalid-value'
  | 'trailing-comma';

export interface PermissionSystemDraftIssue {
  code: PermissionSystemDraftIssueCode;
  field: string;
}

const PERMISSION_STATES = new Set(['allow', 'ask', 'deny']);
const BOOLEAN_FIELDS = [
  'debugLog',
  'permissionReviewLog',
  'yoloMode',
  'doublePressToConfirm',
] as const;
const POSITIVE_INTEGER_FIELDS = [
  'forwardingTimeoutMs',
  'promptMaxRows',
  'promptFieldMaxWidth',
  'reviewLogFieldMaxWidth',
  'toolInputPreviewMaxLength',
  'toolTextSummaryMaxLength',
] as const;
const STRING_ARRAY_FIELDS = [
  'piInfrastructureReadPaths',
  'authorizerChain',
] as const;
const KNOWN_TOP_LEVEL_FIELDS = new Set([
  '$schema',
  ...BOOLEAN_FIELDS,
  ...POSITIVE_INTEGER_FIELDS,
  ...STRING_ARRAY_FIELDS,
  'permission',
  'shellTools',
]);

const owns = (source: JsonObject, key: string): boolean => (
  Object.prototype.hasOwnProperty.call(source, key)
);

const isObject = (value: unknown): value is JsonObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isPermissionState = (value: unknown): boolean => (
  typeof value === 'string' && PERMISSION_STATES.has(value)
);

const push = (
  issues: PermissionSystemDraftIssue[],
  code: PermissionSystemDraftIssueCode,
  field: string,
): void => {
  if (!issues.some((issue) => issue.code === code && issue.field === field)) {
    issues.push({ code, field });
  }
};

const validatePermission = (
  draft: JsonObject,
  issues: PermissionSystemDraftIssue[],
): void => {
  if (!owns(draft, 'permission')) return;
  const permission = draft.permission;
  if (!isObject(permission)) {
    push(issues, 'invalid-value', 'permission');
    return;
  }

  for (const [surface, surfaceValue] of Object.entries(permission)) {
    const field = `permission.${surface}`;
    if (!surface) {
      push(issues, 'invalid-value', 'permission');
      continue;
    }
    if (isPermissionState(surfaceValue)) continue;
    if (!isObject(surfaceValue)) {
      push(issues, 'invalid-value', field);
      continue;
    }

    for (const [pattern, patternValue] of Object.entries(surfaceValue)) {
      if (!pattern) {
        push(issues, 'invalid-value', field);
        continue;
      }
      if (isPermissionState(patternValue)) continue;
      if (!isObject(patternValue)) {
        push(issues, 'invalid-value', field);
        continue;
      }
      const keys = Object.keys(patternValue);
      const reason = patternValue.reason;
      if (
        patternValue.action !== 'deny'
        || keys.some((key) => key !== 'action' && key !== 'reason')
        || (reason !== undefined && (typeof reason !== 'string' || reason.length > 500))
      ) {
        push(issues, 'invalid-value', field);
      }
    }
  }
};

const validateShellTools = (
  draft: JsonObject,
  issues: PermissionSystemDraftIssue[],
): void => {
  if (!owns(draft, 'shellTools')) return;
  const shellTools = draft.shellTools;
  if (!isObject(shellTools)) {
    push(issues, 'invalid-value', 'shellTools');
    return;
  }

  for (const [toolName, rawAlias] of Object.entries(shellTools)) {
    const field = toolName ? `shellTools.${toolName}` : 'shellTools';
    if (!toolName || !isObject(rawAlias)) {
      push(issues, 'invalid-value', field);
      continue;
    }
    const keys = Object.keys(rawAlias);
    if (
      typeof rawAlias.commandArgument !== 'string'
      || rawAlias.commandArgument.length === 0
      || keys.some((key) => key !== 'commandArgument' && key !== 'workdirArgument')
      || (rawAlias.workdirArgument !== undefined
        && (typeof rawAlias.workdirArgument !== 'string' || rawAlias.workdirArgument.length === 0))
    ) {
      push(issues, 'invalid-value', field);
    }
  }
};

const validateStrictJsonc = (
  rawContent: string,
  issues: PermissionSystemDraftIssue[],
): void => {
  const relaxedErrors: ParseError[] = [];
  parse(rawContent.replace(/^\uFEFF/, ''), relaxedErrors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (relaxedErrors.length > 0) return;
  const parseErrors: ParseError[] = [];
  parse(rawContent.replace(/^\uFEFF/, ''), parseErrors, {
    allowTrailingComma: false,
    disallowComments: false,
  });
  if (parseErrors.length > 0) push(issues, 'trailing-comma', '$document');
};

export const permissionSystemDraftIssues = (
  draft: JsonObject,
  rawContent: string,
): PermissionSystemDraftIssue[] => {
  const issues: PermissionSystemDraftIssue[] = [];
  validateStrictJsonc(rawContent, issues);

  for (const field of Object.keys(draft)) {
    if (!KNOWN_TOP_LEVEL_FIELDS.has(field)) {
      push(issues, 'invalid-value', field);
    }
  }

  if (owns(draft, '$schema') && typeof draft.$schema !== 'string') {
    push(issues, 'invalid-value', '$schema');
  }
  for (const field of BOOLEAN_FIELDS) {
    if (owns(draft, field) && typeof draft[field] !== 'boolean') {
      push(issues, 'invalid-boolean', field);
    }
  }
  for (const field of POSITIVE_INTEGER_FIELDS) {
    if (!owns(draft, field)) continue;
    const value = draft[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      push(issues, 'invalid-number', field);
    }
  }
  for (const field of STRING_ARRAY_FIELDS) {
    if (!owns(draft, field)) continue;
    const value = draft[field];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
      push(issues, 'invalid-value', field);
    }
  }

  validatePermission(draft, issues);
  validateShellTools(draft, issues);
  return issues;
};
