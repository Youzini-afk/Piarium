import type {
  JsonValue,
  PiAgentDescriptor,
  RuntimeContextTarget,
} from '@piarium/protocol';

export type PiSubagentsDefinitionMode =
  | 'create-agent'
  | 'create-workflow'
  | 'update-agent'
  | 'update-workflow';

export interface PiSubagentsWorkflowStepDraft {
  agent: string;
  config: Record<string, JsonValue>;
  task: string;
}

export const PI_SUBAGENTS_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type PiSubagentsThinkingLevel = typeof PI_SUBAGENTS_THINKING_LEVELS[number];

export function isSupportedPiSubagentsThinking(
  value: string,
): value is PiSubagentsThinkingLevel {
  return (PI_SUBAGENTS_THINKING_LEVELS as readonly string[]).includes(value);
}

export interface PiSubagentsDefinitionDraft {
  advancedJson: string;
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
  | { code: 'unsupported-advanced-field'; field: string }
  | { code: 'unsupported-workflow-step-field'; field: string; index: number }
  | { code: 'workflow-step-agent'; index: number };

export type PiSubagentsDefinitionBuildResult =
  | { config: Record<string, JsonValue>; issue?: never }
  | { config?: never; issue: PiSubagentsDefinitionIssue };

export interface PiSubagentsDefinitionActionResult {
  message?: string;
  success: boolean;
}

interface PiSubagentsDefinitionActionInput {
  agent?: PiAgentDescriptor;
  config: Record<string, JsonValue>;
  mode: PiSubagentsDefinitionMode;
  runtimeTarget: RuntimeContextTarget;
  scope: 'user' | 'project';
}

interface PiSubagentsDefinitionActionDependencies {
  refreshCatalog: () => Promise<void>;
  runAction: (
    target: RuntimeContextTarget,
    providerId: string,
    action: string,
    agentId?: string,
    input?: JsonValue,
  ) => Promise<PiSubagentsDefinitionActionResult>;
}

/** Keeps the provider mutation and its required post-mutation catalog refresh testable. */
export async function runPiSubagentsDefinitionAction(
  input: PiSubagentsDefinitionActionInput,
  dependencies: PiSubagentsDefinitionActionDependencies,
): Promise<PiSubagentsDefinitionActionResult> {
  const creating = input.mode === 'create-agent' || input.mode === 'create-workflow';
  const action = creating ? input.mode : 'update';
  if (!creating && !input.agent) {
    return { message: 'No agent selected', success: false };
  }
  const result = await dependencies.runAction(
    input.runtimeTarget,
    input.agent?.providerId ?? 'pi-subagents',
    action,
    creating ? undefined : input.agent?.id,
    { config: input.config, scope: input.scope },
  );
  if (result.success) await dependencies.refreshCatalog();
  return result;
}

function stringList(value: string): string[] {
  return [...new Set(value
    .split(/[\r\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean))];
}

function configStringList(value: JsonValue | undefined): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return typeof value === 'string' ? stringList(value) : [];
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.join('\0') === right.join('\0');
}

function jsonEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key]));
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

const FORM_FIELDS = new Set([
  'defaultContext',
  'description',
  'extensions',
  'fallbackModels',
  'maxSubagentDepth',
  'model',
  'name',
  'skills',
  'steps',
  'systemPrompt',
  'thinking',
  'timeoutMs',
  'tools',
]);

const AGENT_ADVANCED_FIELDS = new Set([
  'acceptance',
  'acceptanceRole',
  'async',
  'completionGuard',
  'inheritProjectContext',
  'inheritSkills',
  'output',
  'package',
  'progress',
  'reads',
  'skillPath',
  'subagentOnlyExtensions',
  'systemPromptMode',
  'toolBudget',
  'turnBudget',
]);

const WORKFLOW_STEP_FIELDS = new Set([
  'as',
  'label',
  'model',
  'output',
  'outputMode',
  'outputSchema',
  'phase',
  'progress',
  'reads',
  'skills',
  'toolBudget',
]);

function descriptorConfig(agent?: PiAgentDescriptor): Record<string, JsonValue> {
  if (!agent) return {};
  if (agent.definition) return agent.definition.config;
  return {
    description: agent.description,
    ...(agent.fallbackModels === undefined ? {} : { fallbackModels: agent.fallbackModels }),
    ...(agent.model === undefined ? {} : { model: agent.model }),
    name: agent.name,
    ...(agent.thinking === undefined ? {} : { thinking: agent.thinking }),
  };
}

function actionableAdvancedConfig(
  config: Record<string, JsonValue>,
  mode: PiSubagentsDefinitionMode,
): Record<string, JsonValue> {
  const workflow = mode === 'create-workflow' || mode === 'update-workflow';
  return Object.fromEntries(Object.entries(config).filter(([key]) => (
    !FORM_FIELDS.has(key) && (key === 'package' || (!workflow && AGENT_ADVANCED_FIELDS.has(key)))
  )));
}

function advancedConfig(
  config: Record<string, JsonValue>,
  workflow: boolean,
): Record<string, JsonValue> {
  return actionableAdvancedConfig(config, workflow ? 'update-workflow' : 'update-agent');
}

function unsupportedAdvancedField(
  config: Record<string, JsonValue>,
  mode: PiSubagentsDefinitionMode,
): string | undefined {
  const workflow = mode === 'create-workflow' || mode === 'update-workflow';
  return Object.keys(config).find((key) => (
    FORM_FIELDS.has(key) || (key !== 'package' && (workflow || !AGENT_ADVANCED_FIELDS.has(key)))
  ));
}

function localDefinitionName(value: string): string {
  const name = value.trim();
  const separator = name.lastIndexOf('.');
  return separator >= 0 ? name.slice(separator + 1) : name;
}

function clearedAdvancedValue(
  key: string,
  draft: PiSubagentsDefinitionDraft,
): JsonValue {
  switch (key) {
    case 'acceptance':
    case 'async':
      return '';
    case 'completionGuard':
      return true;
    case 'inheritProjectContext':
      return localDefinitionName(draft.name) === 'delegate';
    case 'inheritSkills':
    case 'progress':
      return false;
    case 'systemPromptMode':
      return localDefinitionName(draft.name) === 'delegate' ? 'append' : 'replace';
    default:
      return false;
  }
}

function configString(config: Record<string, JsonValue>, key: string): string {
  const value = config[key];
  return typeof value === 'string' ? value : '';
}

function createWorkflowStepDraft(value: JsonValue): PiSubagentsWorkflowStepDraft | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const agent = typeof value.agent === 'string' ? value.agent : '';
  const task = typeof value.task === 'string' ? value.task : '';
  const config = Object.fromEntries(Object.entries(value).filter(([key]) => (
    WORKFLOW_STEP_FIELDS.has(key)
  )));
  return { agent, config, task };
}

function buildWorkflowSteps(
  draft: PiSubagentsDefinitionDraft,
): { issue?: PiSubagentsDefinitionIssue; steps?: Array<Record<string, JsonValue>> } {
  const steps: Array<Record<string, JsonValue>> = [];
  for (let index = 0; index < draft.workflowSteps.length; index += 1) {
    const step = draft.workflowSteps[index];
    const agent = step?.agent.trim() ?? '';
    if (!agent) return { issue: { code: 'workflow-step-agent', index } };
    const unsupportedField = Object.keys(step?.config ?? {}).find((key) => !WORKFLOW_STEP_FIELDS.has(key));
    if (unsupportedField) {
      return { issue: { code: 'unsupported-workflow-step-field', field: unsupportedField, index } };
    }
    steps.push({ ...(step?.config ?? {}), agent, task: step?.task ?? '' });
  }
  return { steps };
}

function normalizedWorkflowSteps(value: JsonValue | undefined): Array<Record<string, JsonValue>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps = value.map(createWorkflowStepDraft)
    .filter((step): step is PiSubagentsWorkflowStepDraft => step !== undefined);
  return steps.map((step) => ({ ...step.config, agent: step.agent, task: step.task }));
}

function nonRoundTrippableWorkflowIssue(
  mode: PiSubagentsDefinitionMode,
  original?: PiAgentDescriptor,
): PiSubagentsDefinitionIssue | undefined {
  if (mode !== 'update-workflow' || !original) return undefined;
  const config = descriptorConfig(original);
  const steps = config.steps;
  if (Array.isArray(steps)) {
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (typeof step !== 'object' || step === null || Array.isArray(step)) continue;
      const field = Object.keys(step).find((key) => (
        key !== 'agent' && key !== 'task' && !WORKFLOW_STEP_FIELDS.has(key)
      ));
      if (field) return { code: 'unsupported-workflow-step-field', field, index };
    }
  }
  if (original.source.path?.endsWith('.chain.json')) {
    const field = Object.entries(config).find(([key, value]) => (
      key !== 'description'
      && key !== 'name'
      && key !== 'package'
      && key !== 'steps'
      && typeof value !== 'string'
    ))?.[0];
    if (field) return { code: 'unsupported-advanced-field', field };
  }
  return undefined;
}

export function createPiSubagentsDefinitionDraft(
  agent?: PiAgentDescriptor,
): PiSubagentsDefinitionDraft {
  const config = descriptorConfig(agent);
  const steps = Array.isArray(config.steps)
    ? config.steps.map(createWorkflowStepDraft).filter((step): step is PiSubagentsWorkflowStepDraft => step !== undefined)
    : [];
  return {
    advancedJson: JSON.stringify(advancedConfig(config, agent?.kind === 'workflow'), null, 2),
    defaultContext: config.defaultContext === 'fresh' || config.defaultContext === 'fork'
      ? config.defaultContext
      : '',
    description: configString(config, 'description') || agent?.description || '',
    extensions: configStringList(config.extensions).join('\n'),
    fallbackModels: configStringList(config.fallbackModels).join('\n'),
    maxSubagentDepth: typeof config.maxSubagentDepth === 'number' ? String(config.maxSubagentDepth) : '',
    model: configString(config, 'model'),
    name: configString(config, 'name') || agent?.name || '',
    skills: configStringList(config.skills).join('\n'),
    systemPrompt: configString(config, 'systemPrompt'),
    thinking: configString(config, 'thinking'),
    timeoutMs: typeof config.timeoutMs === 'number' ? String(config.timeoutMs) : '',
    tools: configStringList(config.tools).join('\n'),
    workflowSteps: steps.length ? steps : [{ agent: '', config: {}, task: '' }],
  };
}

export function buildPiSubagentsDefinitionConfig(
  mode: PiSubagentsDefinitionMode,
  draft: PiSubagentsDefinitionDraft,
  original?: PiAgentDescriptor,
): PiSubagentsDefinitionBuildResult {
  const advanced = parseAdvanced(draft.advancedJson);
  if (advanced.issue) return advanced;
  const unsupportedField = unsupportedAdvancedField(advanced.config, mode);
  if (unsupportedField) return { issue: { code: 'unsupported-advanced-field', field: unsupportedField } };
  const roundTripIssue = nonRoundTrippableWorkflowIssue(mode, original);
  if (roundTripIssue) return { issue: roundTripIssue };
  const config: Record<string, JsonValue> = {};
  const name = draft.name.trim();
  const description = draft.description.trim();
  if ((mode === 'create-agent' || mode === 'create-workflow') && (!name || !description)) {
    return { issue: { code: 'name-description-required' } };
  }

  if (mode === 'create-agent' || mode === 'create-workflow') {
    Object.assign(config, actionableAdvancedConfig(advanced.config, mode));
    config.name = name;
    config.description = description;
  } else if (original) {
    const originalConfig = descriptorConfig(original);
    const originalAdvanced = actionableAdvancedConfig(originalConfig, mode);
    const editedAdvanced = actionableAdvancedConfig(advanced.config, mode);
    for (const key of new Set([...Object.keys(originalAdvanced), ...Object.keys(editedAdvanced)])) {
      if (Object.prototype.hasOwnProperty.call(editedAdvanced, key)) {
        const value = editedAdvanced[key];
        if (!jsonEqual(value, originalAdvanced[key])) config[key] = value;
      } else {
        config[key] = clearedAdvancedValue(key, draft);
      }
    }
    if (!name || !description) return { issue: { code: 'name-description-required' } };
    if (name !== (configString(originalConfig, 'name') || original.name)) config.name = name;
    if (description !== (configString(originalConfig, 'description') || original.description)) {
      config.description = description;
    }
  }

  if (mode === 'create-workflow' || mode === 'update-workflow') {
    const workflow = buildWorkflowSteps(draft);
    if (workflow.issue) return { issue: workflow.issue };
    if (mode === 'create-workflow') {
      config.steps = workflow.steps!;
    } else if (original) {
      const originalSteps = normalizedWorkflowSteps(descriptorConfig(original).steps);
      if (!jsonEqual(workflow.steps as JsonValue, originalSteps)) config.steps = workflow.steps!;
    }
  }

  if (mode === 'create-agent') {
    const fallbackModels = stringList(draft.fallbackModels);
    const extensions = stringList(draft.extensions);
    const skills = stringList(draft.skills);
    const tools = stringList(draft.tools);
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
    const originalConfig = descriptorConfig(original);
    const fallbackModels = stringList(draft.fallbackModels);
    const extensions = stringList(draft.extensions);
    const skills = stringList(draft.skills);
    const tools = stringList(draft.tools);
    if (draft.model.trim() !== configString(originalConfig, 'model')) {
      config.model = draft.model.trim() || false;
    }
    if (!sameStringList(configStringList(originalConfig.fallbackModels), fallbackModels)) {
      config.fallbackModels = fallbackModels.length ? fallbackModels : false;
    }
    if (draft.thinking.trim() !== configString(originalConfig, 'thinking')) {
      config.thinking = draft.thinking.trim() || false;
    }
    if (!sameStringList(configStringList(originalConfig.tools), tools)) {
      config.tools = tools.length ? tools.join(', ') : false;
    }
    if (!sameStringList(configStringList(originalConfig.skills), skills)) {
      config.skills = skills.length ? skills.join(', ') : false;
    }
    if (!sameStringList(configStringList(originalConfig.extensions), extensions)) {
      config.extensions = extensions.length ? extensions.join(', ') : false;
    }
    const systemPrompt = draft.systemPrompt.trim() ? draft.systemPrompt : '';
    if (systemPrompt !== configString(originalConfig, 'systemPrompt')) {
      config.systemPrompt = systemPrompt || false;
    }
    const defaultContext = originalConfig.defaultContext === 'fresh' || originalConfig.defaultContext === 'fork'
      ? originalConfig.defaultContext
      : '';
    if (draft.defaultContext !== defaultContext) config.defaultContext = draft.defaultContext || false;
    const timeout = optionalInteger(draft.timeoutMs, 'timeoutMs', 1);
    if (timeout.issue) return { issue: timeout.issue };
    const originalTimeout = typeof originalConfig.timeoutMs === 'number' ? originalConfig.timeoutMs : undefined;
    if (timeout.value !== originalTimeout) config.timeoutMs = timeout.value ?? false;
    const maxDepth = optionalInteger(draft.maxSubagentDepth, 'maxSubagentDepth', 0);
    if (maxDepth.issue) return { issue: maxDepth.issue };
    const originalDepth = typeof originalConfig.maxSubagentDepth === 'number'
      ? originalConfig.maxSubagentDepth
      : undefined;
    if (maxDepth.value !== originalDepth) config.maxSubagentDepth = maxDepth.value ?? false;
  }

  return Object.keys(config).length > 0
    ? { config }
    : { issue: { code: 'no-changes' } };
}
