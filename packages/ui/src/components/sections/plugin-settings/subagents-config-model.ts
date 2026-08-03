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

export function subagentsSettingsDraftIssue(draft: JsonObject): SubagentsDraftIssue | null {
  const rawAllow = readJsonPath(draft, ['modelScope', 'allow']);
  const allow = validStringArray(rawAllow)
    ?.map((entry) => entry.trim())
    .filter(Boolean);
  if (rawAllow !== undefined && !allow?.length) {
    return { code: 'model-scope-allow-required', field: 'modelScope.allow' };
  }
  return readJsonPath(draft, ['modelScope', 'enforce']) === true && !allow?.length
    ? { code: 'model-scope-allow-required', field: 'modelScope.allow' }
    : null;
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

  const toolBudget = asObject(readJsonPath(draft, ['toolBudget']));
  if (toolBudget) {
    const issue = limitGroupIssue(toolBudget, 'toolBudget', true);
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
