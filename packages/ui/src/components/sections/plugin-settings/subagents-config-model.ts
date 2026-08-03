import type { JsonValue } from '@piarium/protocol';
import {
  readJsonPath,
  validStringArray,
  type JsonObject,
} from './plugin-config-model';

export type SubagentsDraftIssue =
  | { code: 'model-scope-allow-required'; field: 'modelScope.allow' }
  | { code: 'required'; field: string }
  | { code: 'invalid-number'; field: string }
  | { code: 'invalid-value'; field: string }
  | { code: 'soft-exceeds-hard'; field: string };

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function positiveNumber(value: JsonValue | undefined, integer: boolean): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return !integer || Number.isInteger(value) ? value : undefined;
}

const UNSUPPORTED_AGENT_OVERRIDE_FIELDS = new Set([
  'acceptance',
  'maxRuntimeMs',
  'mcpDirectTools',
  'memory',
  'output',
  'outputSchema',
  'skillPath',
  'timeoutMs',
  'turnBudget',
  'usageBudget',
  'worktree',
]);

function toolBudgetIssue(
  raw: JsonValue | undefined,
  field: string,
  allowClear: boolean,
): SubagentsDraftIssue | null {
  if (raw === undefined || (allowClear && raw === false)) return null;
  const budget = asObject(raw);
  if (!budget) return { code: 'invalid-value', field };
  const hardIssue = requiredPositive(budget, 'hard', `${field}.hard`, true);
  if (hardIssue) return hardIssue;
  const softIssue = optionalPositive(budget, 'soft', `${field}.soft`, true);
  if (softIssue) return softIssue;
  const hard = budget.hard as number;
  const soft = budget.soft;
  if (typeof soft === 'number' && soft > hard) {
    return { code: 'soft-exceeds-hard', field: `${field}.soft` };
  }
  const block = budget.block;
  if (block !== undefined && block !== '*') {
    const names = validStringArray(block);
    if (!names?.length || names.some((name) => !name.trim())) {
      return { code: 'invalid-value', field: `${field}.block` };
    }
  }
  return null;
}

export function subagentsSettingsDraftIssue(draft: JsonObject): SubagentsDraftIssue | null {
  const rawAllow = readJsonPath(draft, ['modelScope', 'allow']);
  const allow = validStringArray(rawAllow)
    ?.map((entry) => entry.trim())
    .filter(Boolean);
  if (rawAllow !== undefined && !allow?.length) {
    return { code: 'model-scope-allow-required', field: 'modelScope.allow' };
  }
  if (readJsonPath(draft, ['modelScope', 'enforce']) === true && !allow?.length) {
    return { code: 'model-scope-allow-required', field: 'modelScope.allow' };
  }

  const rawOverrides = readJsonPath(draft, ['agentOverrides']);
  if (rawOverrides === undefined) return null;
  const overrides = asObject(rawOverrides);
  if (!overrides) return { code: 'invalid-value', field: 'agentOverrides' };

  const stringOrFalseFields = ['model', 'thinking'] as const;
  const stringArrayOrFalseFields = [
    'fallbackModels',
    'skills',
    'tools',
    'extensions',
    'subagentOnlyExtensions',
  ] as const;
  const booleanFields = [
    'inheritProjectContext',
    'inheritSkills',
    'disabled',
    'completionGuard',
  ] as const;

  for (const [name, rawOverride] of Object.entries(overrides)) {
    const override = asObject(rawOverride);
    if (!override) return { code: 'invalid-value', field: `agentOverrides.${name}` };
    const unsupported = Object.keys(override).find((field) => (
      UNSUPPORTED_AGENT_OVERRIDE_FIELDS.has(field)
    ));
    if (unsupported) {
      return { code: 'invalid-value', field: `agentOverrides.${name}.${unsupported}` };
    }

    for (const field of stringOrFalseFields) {
      const value = override[field];
      if (value !== undefined && value !== false && typeof value !== 'string') {
        return { code: 'invalid-value', field: `agentOverrides.${name}.${field}` };
      }
    }
    for (const field of stringArrayOrFalseFields) {
      const value = override[field];
      if (value !== undefined && value !== false && !validStringArray(value)) {
        return { code: 'invalid-value', field: `agentOverrides.${name}.${field}` };
      }
    }
    for (const field of booleanFields) {
      const value = override[field];
      if (value !== undefined && typeof value !== 'boolean') {
        return { code: 'invalid-value', field: `agentOverrides.${name}.${field}` };
      }
    }
    if (
      override.systemPromptMode !== undefined
      && override.systemPromptMode !== 'append'
      && override.systemPromptMode !== 'replace'
    ) {
      return { code: 'invalid-value', field: `agentOverrides.${name}.systemPromptMode` };
    }
    if (
      override.defaultContext !== undefined
      && override.defaultContext !== false
      && override.defaultContext !== 'fresh'
      && override.defaultContext !== 'fork'
    ) {
      return { code: 'invalid-value', field: `agentOverrides.${name}.defaultContext` };
    }
    if (
      override.acceptanceRole !== undefined
      && override.acceptanceRole !== false
      && override.acceptanceRole !== 'read-only'
      && override.acceptanceRole !== 'writer'
    ) {
      return { code: 'invalid-value', field: `agentOverrides.${name}.acceptanceRole` };
    }
    if (override.systemPrompt !== undefined && typeof override.systemPrompt !== 'string') {
      return { code: 'invalid-value', field: `agentOverrides.${name}.systemPrompt` };
    }
    const budgetIssue = toolBudgetIssue(
      override.toolBudget,
      `agentOverrides.${name}.toolBudget`,
      true,
    );
    if (budgetIssue) return budgetIssue;
  }
  return null;
}

function requiredPositive(
  group: JsonObject,
  key: string,
  field: string,
  integer: boolean,
): SubagentsDraftIssue | null {
  const value = group[key];
  if (value === undefined) return { code: 'required', field };
  return positiveNumber(value, integer) === undefined ? { code: 'invalid-number', field } : null;
}

function optionalPositive(
  group: JsonObject,
  key: string,
  field: string,
  integer: boolean,
): SubagentsDraftIssue | null {
  const value = group[key];
  if (value === undefined) return null;
  return positiveNumber(value, integer) === undefined ? { code: 'invalid-number', field } : null;
}

function optionalNonNegativeInteger(
  group: JsonObject,
  key: string,
  field: string,
): SubagentsDraftIssue | null {
  const value = group[key];
  if (value === undefined) return null;
  return typeof value !== 'number' || !Number.isInteger(value) || value < 0
    ? { code: 'invalid-number', field }
    : null;
}

function limitGroupIssue(
  group: JsonObject,
  field: string,
  integer: boolean,
): SubagentsDraftIssue | null {
  const hardIssue = requiredPositive(group, 'hard', `${field}.hard`, integer);
  if (hardIssue) return hardIssue;
  const softIssue = optionalPositive(group, 'soft', `${field}.soft`, integer);
  if (softIssue) return softIssue;
  const hard = group.hard as number;
  const soft = group.soft;
  return typeof soft === 'number' && soft > hard
    ? { code: 'soft-exceeds-hard', field: `${field}.soft` }
    : null;
}

export function subagentsRuntimeDraftIssue(draft: JsonObject): SubagentsDraftIssue | null {
  const turnBudget = asObject(readJsonPath(draft, ['turnBudget']));
  if (turnBudget) {
    const issue = requiredPositive(turnBudget, 'maxTurns', 'turnBudget.maxTurns', true)
      ?? optionalNonNegativeInteger(turnBudget, 'graceTurns', 'turnBudget.graceTurns');
    if (issue) return issue;
  }

  const rawToolBudget = readJsonPath(draft, ['toolBudget']);
  if (rawToolBudget !== undefined) {
    const issue = toolBudgetIssue(rawToolBudget, 'toolBudget', false);
    if (issue) return issue;
  }

  const usageBudget = asObject(readJsonPath(draft, ['usageBudget']));
  if (!usageBudget) return null;
  const tokens = asObject(usageBudget.tokens);
  const costUsd = asObject(usageBudget.costUsd);
  if (!tokens && !costUsd) {
    return { code: 'required', field: 'usageBudget.tokens / usageBudget.costUsd' };
  }
  if (tokens) {
    const issue = limitGroupIssue(tokens, 'usageBudget.tokens', false);
    if (issue) return issue;
  }
  if (costUsd) {
    const issue = limitGroupIssue(costUsd, 'usageBudget.costUsd', false);
    if (issue) return issue;
  }
  return null;
}
