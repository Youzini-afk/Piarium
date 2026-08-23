import type { JsonValue } from '@piarium/protocol';
import {
  readJsonPath,
  validStringArray,
  type JsonObject,
} from './plugin-config-model';

export type SubagentsDraftIssue =
  | { code: 'model-scope-allow-required'; field: string }
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

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function modelScopeRuleIssue(
  rule: JsonObject,
  field: string,
): SubagentsDraftIssue | null {
  for (const key of ['enforce', 'strict'] as const) {
    if (rule[key] !== undefined && typeof rule[key] !== 'boolean') {
      return { code: 'invalid-value', field: `${field}.${key}` };
    }
  }
  if (rule.allow !== undefined) {
    const allow = validStringArray(rule.allow)?.map((entry) => entry.trim()).filter(Boolean);
    if (!allow?.length) return { code: 'model-scope-allow-required', field: `${field}.allow` };
  }
  return null;
}

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
  const defaultProvider = readJsonPath(draft, ['defaultProvider']);
  if (defaultProvider !== undefined && (typeof defaultProvider !== 'string' || !defaultProvider.trim())) {
    return { code: 'invalid-value', field: 'defaultProvider' };
  }
  const maxThinking = readJsonPath(draft, ['maxThinking']);
  if (maxThinking !== undefined && (typeof maxThinking !== 'string' || !THINKING_LEVELS.has(maxThinking))) {
    return { code: 'invalid-value', field: 'maxThinking' };
  }

  const rawModelScope = readJsonPath(draft, ['modelScope']);
  if (rawModelScope !== undefined) {
    const modelScope = asObject(rawModelScope);
    if (!modelScope) return { code: 'invalid-value', field: 'modelScope' };
    const issue = modelScopeRuleIssue(modelScope, 'modelScope');
    if (issue) return issue;
    const rawAgents = modelScope.agents;
    let hasAgentAllow = false;
    if (rawAgents !== undefined) {
      const agents = asObject(rawAgents);
      if (!agents) return { code: 'invalid-value', field: 'modelScope.agents' };
      for (const [name, rawRule] of Object.entries(agents)) {
        const rule = asObject(rawRule);
        if (!name.trim() || !rule || rule.agents !== undefined) {
          return { code: 'invalid-value', field: `modelScope.agents.${name || '?'}` };
        }
        const agentIssue = modelScopeRuleIssue(rule, `modelScope.agents.${name}`);
        if (agentIssue) return agentIssue;
        hasAgentAllow ||= validStringArray(rule.allow)?.some((entry) => Boolean(entry.trim())) === true;
      }
    }
    const hasGlobalAllow = validStringArray(modelScope.allow)?.some((entry) => Boolean(entry.trim())) === true;
    if (modelScope.enforce === true && !hasGlobalAllow && !hasAgentAllow) {
      return { code: 'model-scope-allow-required', field: 'modelScope.allow' };
    }
  }

  const rawOverrides = readJsonPath(draft, ['agentOverrides']);
  if (rawOverrides === undefined) return null;
  const overrides = asObject(rawOverrides);
  if (!overrides) return { code: 'invalid-value', field: 'agentOverrides' };

  const stringOrFalseFields = ['defaultProvider', 'model', 'output', 'thinking'] as const;
  const stringArrayOrFalseFields = [
    'defaultReads',
    'fallbackModels',
    'skills',
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
    for (const field of stringOrFalseFields) {
      const value = override[field];
      if (value !== undefined && value !== false && typeof value !== 'string') {
        return { code: 'invalid-value', field: `agentOverrides.${name}.${field}` };
      }
      if ((field === 'defaultProvider' || field === 'output') && typeof value === 'string' && !value.trim()) {
        return { code: 'invalid-value', field: `agentOverrides.${name}.${field}` };
      }
    }
    if (
      override.tools !== undefined
      && override.tools !== false
      && override.tools !== 'inherit'
      && !validStringArray(override.tools)
    ) {
      return { code: 'invalid-value', field: `agentOverrides.${name}.tools` };
    }
    if (
      override.outputMode !== undefined
      && override.outputMode !== 'inline'
      && override.outputMode !== 'file-only'
    ) {
      return { code: 'invalid-value', field: `agentOverrides.${name}.outputMode` };
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
