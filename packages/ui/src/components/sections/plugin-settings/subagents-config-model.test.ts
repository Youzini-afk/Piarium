import { describe, expect, test } from 'bun:test';
import {
  subagentsRuntimeDraftIssue,
  subagentsSettingsDraftIssue,
} from './subagents-config-model';

describe('subagents config model', () => {
  test('requires an allow list when model scope enforcement is enabled', () => {
    expect(subagentsSettingsDraftIssue({ modelScope: { enforce: true } })).toEqual({
      code: 'model-scope-allow-required',
      field: 'modelScope.allow',
    });
    expect(subagentsSettingsDraftIssue({
      modelScope: { allow: ['openai/*'], enforce: true },
    })).toBeNull();
    expect(subagentsSettingsDraftIssue({ modelScope: { allow: [] } })).toEqual({
      code: 'model-scope-allow-required',
      field: 'modelScope.allow',
    });
  });

  test('accepts the current pi-subagents override contract and rejects malformed known fields', () => {
    expect(subagentsSettingsDraftIssue({
      agentOverrides: {
        reviewer: {
          acceptanceRole: false,
          completionGuard: true,
          defaultContext: 'fork',
          extensions: false,
          fallbackModels: ['anthropic/claude-sonnet-4-5'],
          inheritProjectContext: true,
          model: 'openai/gpt-5.2',
          systemPromptMode: 'append',
          thinking: false,
          toolBudget: { hard: 20, soft: 10 },
          tools: [],
          unknownFutureField: { preserved: true },
        },
      },
    })).toBeNull();
    expect(subagentsSettingsDraftIssue({
      agentOverrides: { reviewer: { fallbackModels: 'not-an-array' } },
    })).toEqual({
      code: 'invalid-value',
      field: 'agentOverrides.reviewer.fallbackModels',
    });
    expect(subagentsSettingsDraftIssue({
      agentOverrides: { reviewer: { defaultContext: 'ambient' } },
    })).toEqual({
      code: 'invalid-value',
      field: 'agentOverrides.reviewer.defaultContext',
    });
  });

  test('requires complete turn and tool budget objects', () => {
    expect(subagentsRuntimeDraftIssue({ turnBudget: { graceTurns: 1 } })).toEqual({
      code: 'required',
      field: 'turnBudget.maxTurns',
    });
    expect(subagentsRuntimeDraftIssue({ toolBudget: { hard: 10, soft: 11 } })).toEqual({
      code: 'soft-exceeds-hard',
      field: 'toolBudget.soft',
    });
    expect(subagentsRuntimeDraftIssue({ turnBudget: { graceTurns: 0, maxTurns: 1 } })).toBeNull();
  });

  test('validates independently optional usage budget metrics', () => {
    expect(subagentsRuntimeDraftIssue({ usageBudget: {} })).toEqual({
      code: 'required',
      field: 'usageBudget.tokens / usageBudget.costUsd',
    });
    expect(subagentsRuntimeDraftIssue({ usageBudget: { tokens: { hard: 1000 } } })).toBeNull();
    expect(subagentsRuntimeDraftIssue({
      usageBudget: { costUsd: { hard: 1, soft: 2 } },
    })).toEqual({
      code: 'soft-exceeds-hard',
      field: 'usageBudget.costUsd.soft',
    });
  });
});
