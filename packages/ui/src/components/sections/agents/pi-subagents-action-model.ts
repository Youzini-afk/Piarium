import type { JsonValue, PiAgentDescriptor } from '@piarium/protocol';

export type PiSubagentsDefinitionMode =
  | 'create-agent'
  | 'create-workflow'
  | 'update-agent'
  | 'update-workflow';

export interface PiSubagentsWorkflowStepDraft {
  agent: string;
  task: string;
}

export interface PiSubagentsDefinitionDraft {
  advancedJson: string;
  aliases: string;
  defaultContext: '' | 'fresh' | 'fork';
  description: string;
  extensions: string;
  fallbackModels: string;
  maxSubagentDepth: string;
  model: string;
  name: string;
  skills: string;
  systemPrompt: string;
  thinking: string;
  timeoutMs: string;
  tools: string;
  workflowSteps: PiSubagentsWorkflowStepDraft[];
}

export type PiSubagentsDefinitionIssue =
  | { code: 'invalid-integer'; field: 'maxSubagentDepth' | 'timeoutMs' }
  | { code: 'invalid-json' }
  | { code: 'json-object' }
  | { code: 'name-description-required' }
  | { code: 'no-changes' }
  | { code: 'workflow-step-agent'; index: number };

export type PiSubagentsDefinitionBuildResult =
  | { config: Record<string, JsonValue>; issue?: never }
  | { config?: never; issue: PiSubagentsDefinitionIssue };

function stringList(value: string): string[] {
  return [...new Set(value
    .split(/[\r\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean))];
}

function sameStringList(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return (left ?? []).join('\0') === right.join('\0');
}

function parseAdvanced(value: string): PiSubagentsDefinitionBuildResult {
  if (!value.trim()) return { config: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { issue: { code: 'invalid-json' } };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { issue: { code: 'json-object' } };
  }
  return { config: parsed as Record<string, JsonValue> };
}

function optionalInteger(
  value: string,
  field: 'maxSubagentDepth' | 'timeoutMs',
  minimum: number,
): { issue?: PiSubagentsDefinitionIssue; value?: number } {
  if (!value.trim()) return {};
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum
    ? { value: parsed }
    : { issue: { code: 'invalid-integer', field } };
}

export function createPiSubagentsDefinitionDraft(
  agent?: PiAgentDescriptor,
): PiSubagentsDefinitionDraft {
  return {
    advancedJson: '{}',
    aliases: (agent?.aliases ?? []).join('\n'),
    defaultContext: '',
    description: agent?.description ?? '',
    extensions: '',
    fallbackModels: (agent?.fallbackModels ?? []).join('\n'),
    maxSubagentDepth: '',
    model: agent?.model ?? '',
    name: agent?.name ?? '',
    skills: '',
    systemPrompt: '',
    thinking: agent?.thinking ?? '',
    timeoutMs: '',
    tools: '',
    workflowSteps: [{ agent: '', task: '' }],
  };
}

export function buildPiSubagentsDefinitionConfig(
  mode: PiSubagentsDefinitionMode,
  draft: PiSubagentsDefinitionDraft,
  original?: PiAgentDescriptor,
): PiSubagentsDefinitionBuildResult {
  const advanced = parseAdvanced(draft.advancedJson);
  if (advanced.issue) return advanced;
  const config = { ...advanced.config };
  const name = draft.name.trim();
  const description = draft.description.trim();
  if ((mode === 'create-agent' || mode === 'create-workflow') && (!name || !description)) {
    return { issue: { code: 'name-description-required' } };
  }

  if (mode === 'create-agent' || mode === 'create-workflow') {
    config.name = name;
    config.description = description;
  } else if (original) {
    if (!name || !description) return { issue: { code: 'name-description-required' } };
    if (name !== original.name) config.name = name;
    if (description !== original.description) config.description = description;
  }

  if (mode === 'create-workflow') {
    const steps: Array<Record<string, JsonValue>> = [];
    for (let index = 0; index < draft.workflowSteps.length; index += 1) {
      const step = draft.workflowSteps[index];
      const agent = step?.agent.trim() ?? '';
      if (!agent) return { issue: { code: 'workflow-step-agent', index } };
      steps.push({ agent, task: step?.task ?? '' });
    }
    config.steps = steps;
  }

  if (mode === 'create-agent') {
    const aliases = stringList(draft.aliases);
    const fallbackModels = stringList(draft.fallbackModels);
    const extensions = stringList(draft.extensions);
    const skills = stringList(draft.skills);
    const tools = stringList(draft.tools);
    if (aliases.length) config.aliases = aliases;
    if (draft.model.trim()) config.model = draft.model.trim();
    if (fallbackModels.length) config.fallbackModels = fallbackModels;
    if (draft.thinking.trim()) config.thinking = draft.thinking.trim();
    if (draft.systemPrompt.trim()) config.systemPrompt = draft.systemPrompt;
    if (draft.defaultContext) config.defaultContext = draft.defaultContext;
    if (tools.length) config.tools = tools.join(', ');
    if (skills.length) config.skills = skills.join(', ');
    if (extensions.length) config.extensions = extensions.join(', ');
    const timeout = optionalInteger(draft.timeoutMs, 'timeoutMs', 1);
    if (timeout.issue) return { issue: timeout.issue };
    if (timeout.value !== undefined) config.timeoutMs = timeout.value;
    const maxDepth = optionalInteger(draft.maxSubagentDepth, 'maxSubagentDepth', 0);
    if (maxDepth.issue) return { issue: maxDepth.issue };
    if (maxDepth.value !== undefined) config.maxSubagentDepth = maxDepth.value;
  }

  if (mode === 'update-agent' && original) {
    const aliases = stringList(draft.aliases);
    const fallbackModels = stringList(draft.fallbackModels);
    if (!sameStringList(original.aliases, aliases)) config.aliases = aliases.length ? aliases : false;
    if (draft.model.trim() !== (original.model ?? '')) config.model = draft.model.trim() || false;
    if (!sameStringList(original.fallbackModels, fallbackModels)) {
      config.fallbackModels = fallbackModels.length ? fallbackModels : false;
    }
    if (draft.thinking.trim() !== (original.thinking ?? '')) {
      config.thinking = draft.thinking.trim() || false;
    }
  }

  return Object.keys(config).length > 0
    ? { config }
    : { issue: { code: 'no-changes' } };
}
