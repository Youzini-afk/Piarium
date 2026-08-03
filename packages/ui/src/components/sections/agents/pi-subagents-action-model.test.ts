import { describe, expect, test } from 'bun:test';
import type { PiAgentDescriptor } from '@piarium/protocol';
import {
  buildPiSubagentsDefinitionConfig,
  createPiSubagentsDefinitionDraft,
} from './pi-subagents-action-model';

const AGENT: PiAgentDescriptor = {
  actions: [],
  aliases: ['helper'],
  description: 'Existing role',
  fallbackModels: ['test/fallback'],
  id: 'agent-id',
  kind: 'delegatable',
  model: 'test/model',
  name: 'existing',
  providerId: 'pi-subagents',
  source: { scope: 'user' },
  status: 'available',
  thinking: 'medium',
};

describe('pi-subagents action model', () => {
  test('builds a structured create-agent config without writing blank defaults', () => {
    const draft = createPiSubagentsDefinitionDraft();
    Object.assign(draft, {
      advancedJson: '{"inheritSkills":false}',
      description: 'Review changes',
      fallbackModels: 'test/fallback\ntest/fallback',
      maxSubagentDepth: '0',
      model: 'test/model',
      name: 'reviewer',
      tools: 'read, grep',
    });
    expect(buildPiSubagentsDefinitionConfig('create-agent', draft)).toEqual({
      config: {
        description: 'Review changes',
        fallbackModels: ['test/fallback'],
        inheritSkills: false,
        maxSubagentDepth: 0,
        model: 'test/model',
        name: 'reviewer',
        tools: 'read, grep',
      },
    });
  });

  test('requires every create-workflow step to name an agent', () => {
    const draft = createPiSubagentsDefinitionDraft();
    Object.assign(draft, {
      description: 'Verify a change',
      name: 'verify',
      workflowSteps: [{ agent: 'scout', task: 'Map it' }, { agent: '', task: 'Review it' }],
    });
    expect(buildPiSubagentsDefinitionConfig('create-workflow', draft)).toEqual({
      issue: { code: 'workflow-step-agent', index: 1 },
    });
  });

  test('builds only changed update fields and can clear inherited values', () => {
    const draft = createPiSubagentsDefinitionDraft(AGENT);
    draft.description = 'Updated role';
    draft.model = '';
    draft.fallbackModels = '';
    expect(buildPiSubagentsDefinitionConfig('update-agent', draft, AGENT)).toEqual({
      config: {
        description: 'Updated role',
        fallbackModels: false,
        model: false,
      },
    });
  });
});
