import React from 'react';
import type { JsonValue, PiAgentDescriptor } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { ModelSelector } from './ModelSelector';
import {
  SETTINGS_FIELD_LABEL_CLASS,
  SettingsControlGroup,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import {
  buildPiSubagentsDefinitionConfig,
  createPiSubagentsDefinitionDraft,
  isSupportedPiSubagentsThinking,
  PI_SUBAGENTS_THINKING_LEVELS,
  type PiSubagentsDefinitionDraft,
  type PiSubagentsDefinitionIssue,
  type PiSubagentsDefinitionMode,
  type PiSubagentsWorkflowStepDraft,
} from './pi-subagents-action-model';

type ActionScope = 'user' | 'project';

const splitModel = (value: string): { modelId: string; providerId: string } => {
  const separator = value.indexOf('/');
  return separator > 0
    ? { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) }
    : { providerId: '', modelId: value };
};

interface PiSubagentsDefinitionDialogProps {
  agent?: PiAgentDescriptor;
  mode: PiSubagentsDefinitionMode | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (scope: ActionScope, config: Record<string, JsonValue>) => Promise<boolean>;
  open: boolean;
  projectTrusted: boolean;
  submitting: boolean;
}

function stepConfigString(step: PiSubagentsWorkflowStepDraft, key: string): string {
  const value = step.config[key];
  return typeof value === 'string' ? value : '';
}

function stepConfigStringList(
  step: PiSubagentsWorkflowStepDraft,
  key: 'reads' | 'skills',
): string[] | undefined {
  const value = step.config[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
}

const WorkflowStepEditor: React.FC<{
  disabled: boolean;
  onChange: (step: PiSubagentsWorkflowStepDraft) => void;
  step: PiSubagentsWorkflowStepDraft;
}> = ({ disabled, onChange, step }) => {
  const { t } = useI18n();
  const setConfig = React.useCallback((key: string, value: JsonValue | undefined) => {
    const config = { ...step.config };
    if (value === undefined) delete config[key];
    else config[key] = value;
    onChange({ ...step, config });
  }, [onChange, step]);
  const setToolBudgetField = React.useCallback((key: string, value: JsonValue | undefined) => {
    const raw = step.config.toolBudget;
    const budget: Record<string, JsonValue> = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? { ...raw }
      : { hard: 16 };
    if (value === undefined) delete budget[key];
    else budget[key] = value;
    setConfig('toolBudget', budget);
  }, [setConfig, step.config.toolBudget]);

  const output = step.config.output;
  const outputBehavior = output === false ? 'disabled' : typeof output === 'string' ? 'file' : 'default';
  const reads = stepConfigStringList(step, 'reads');
  const readsMode = step.config.reads === false ? 'disabled' : reads ? 'selected' : 'default';
  const skills = stepConfigStringList(step, 'skills');
  const skillsMode = step.config.skills === false ? 'disabled' : skills ? 'selected' : 'default';
  const progress = typeof step.config.progress === 'boolean'
    ? step.config.progress ? 'enabled' : 'disabled'
    : 'default';
  const rawBudget = step.config.toolBudget;
  const budget = typeof rawBudget === 'object' && rawBudget !== null && !Array.isArray(rawBudget)
    ? rawBudget
    : undefined;
  const budgetMode = rawBudget === undefined ? 'default' : 'override';
  const block = budget?.block;
  const blockList = Array.isArray(block)
    ? block.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  const blockMode = block === '*' ? 'all' : blockList ? 'selected' : 'default';
  const model = stepConfigString(step, 'model');

  return (
    <div className="space-y-4">
      <div className="grid gap-3 @xl:grid-cols-2">
        <SettingsFieldRow label={t('settings.piarium.agents.definition.field.phase')} alignEnd={false} controlClassName="w-full items-start">
          <Input
            value={stepConfigString(step, 'phase')}
            disabled={disabled}
            placeholder="research"
            onChange={(event) => setConfig('phase', event.target.value || undefined)}
          />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.piarium.agents.definition.field.stepLabel')} alignEnd={false} controlClassName="w-full items-start">
          <Input
            value={stepConfigString(step, 'label')}
            disabled={disabled}
            placeholder="Map the change"
            onChange={(event) => setConfig('label', event.target.value || undefined)}
          />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.piarium.agents.definition.field.namedResult')} alignEnd={false} controlClassName="w-full items-start">
          <Input
            value={stepConfigString(step, 'as')}
            disabled={disabled}
            placeholder="research"
            onChange={(event) => setConfig('as', event.target.value || undefined)}
          />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.piarium.agents.definition.field.outputSchemaFile')} alignEnd={false} controlClassName="w-full items-start">
          <Input
            value={stepConfigString(step, 'outputSchema')}
            disabled={disabled}
            placeholder="schemas/result.json"
            onChange={(event) => setConfig('outputSchema', event.target.value || undefined)}
          />
        </SettingsFieldRow>
      </div>

      <SettingsFieldRow label={t('settings.piarium.agents.definition.field.primaryModel')} controlClassName="w-full max-w-lg">
        <div
          aria-disabled={disabled}
          className={disabled ? 'pointer-events-none opacity-60' : undefined}
          inert={disabled ? true : undefined}
        >
          <ModelSelector
            {...splitModel(model)}
            placeholder={t('settings.piarium.agents.definition.placeholder.inheritModel')}
            onChange={(providerId, modelId) => setConfig(
              'model',
              providerId && modelId ? `${providerId}/${modelId}` : undefined,
            )}
            className="w-full max-w-72 justify-between"
            dropdownPortalToBody
          />
        </div>
      </SettingsFieldRow>

      <div className="grid gap-3 @xl:grid-cols-2">
        <SettingsFieldRow label={t('settings.piarium.agents.definition.field.savedOutput')} alignEnd={false} controlClassName="w-full items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Select
              value={outputBehavior}
              disabled={disabled}
              onValueChange={(value) => {
                if (value === 'default') setConfig('output', undefined);
                else if (value === 'disabled') setConfig('output', false);
                else setConfig('output', typeof output === 'string' ? output : 'output.md');
              }}
            >
              <SelectTrigger size="settings" className="w-full">
                <SelectValue>
                  {outputBehavior === 'default'
                    ? t('settings.piarium.pluginSettings.field.pluginDefault')
                    : outputBehavior === 'disabled'
                      ? t('settings.piarium.pluginSettings.field.disabled')
                      : t('settings.piarium.pluginSettings.field.enabled')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">{t('settings.piarium.pluginSettings.field.pluginDefault')}</SelectItem>
                <SelectItem value="disabled">{t('settings.piarium.pluginSettings.field.disabled')}</SelectItem>
                <SelectItem value="file">{t('settings.piarium.pluginSettings.field.enabled')}</SelectItem>
              </SelectContent>
            </Select>
            {outputBehavior === 'file' ? (
              <Input
                value={typeof output === 'string' ? output : ''}
                disabled={disabled}
                placeholder="output.md"
                onChange={(event) => setConfig('output', event.target.value)}
              />
            ) : null}
          </div>
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.piarium.agents.definition.field.outputReturnMode')} controlClassName="w-full">
          <Select
            value={stepConfigString(step, 'outputMode') || 'default'}
            disabled={disabled}
            onValueChange={(value) => setConfig('outputMode', value === 'default' ? undefined : value)}
          >
            <SelectTrigger size="settings" className="w-full">
              <SelectValue>
                {stepConfigString(step, 'outputMode') || t('settings.piarium.pluginSettings.field.pluginDefault')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">{t('settings.piarium.pluginSettings.field.pluginDefault')}</SelectItem>
              <SelectItem value="inline">inline</SelectItem>
              <SelectItem value="file-only">file-only</SelectItem>
            </SelectContent>
          </Select>
        </SettingsFieldRow>
      </div>

      <div className="grid gap-3 @xl:grid-cols-2">
        {([
          ['reads', t('settings.piarium.agents.definition.field.filesReadBeforeStep'), readsMode, reads],
          ['skills', t('settings.piarium.agents.definition.field.availableSkills'), skillsMode, skills],
        ] as const).map(([key, label, mode, values]) => (
          <SettingsFieldRow key={key} label={label} alignEnd={false} controlClassName="w-full items-start">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Select
                value={mode}
                disabled={disabled}
                onValueChange={(value) => {
                  if (value === 'default') setConfig(key, undefined);
                  else if (value === 'disabled') setConfig(key, false);
                  else setConfig(key, values ?? []);
                }}
              >
                <SelectTrigger size="settings" className="w-full">
                  <SelectValue>
                    {mode === 'default'
                      ? t('settings.piarium.pluginSettings.field.pluginDefault')
                      : mode === 'disabled'
                        ? t('settings.piarium.pluginSettings.field.disabled')
                        : t('settings.piarium.pluginSettings.subagents.value.selectedTools')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">{t('settings.piarium.pluginSettings.field.pluginDefault')}</SelectItem>
                  <SelectItem value="disabled">{t('settings.piarium.pluginSettings.field.disabled')}</SelectItem>
                  <SelectItem value="selected">{t('settings.piarium.pluginSettings.subagents.value.selectedTools')}</SelectItem>
                </SelectContent>
              </Select>
              {mode === 'selected' ? (
                <Textarea
                  value={(values ?? []).join('\n')}
                  disabled={disabled}
                  placeholder={key === 'reads' ? 'brief.md\nrequirements.md' : 'skill-name'}
                  onChange={(event) => setConfig(key, event.target.value
                    .split(/\r?\n/)
                    .map((entry) => entry.trim())
                    .filter(Boolean))}
                  className="min-h-20 font-mono"
                />
              ) : null}
            </div>
          </SettingsFieldRow>
        ))}
      </div>

      <SettingsFieldRow label={t('settings.piarium.agents.definition.field.progressTracking')} controlClassName="w-full max-w-lg">
        <Select
          value={progress}
          disabled={disabled}
          onValueChange={(value) => setConfig(
            'progress',
            value === 'default' ? undefined : value === 'enabled',
          )}
        >
          <SelectTrigger size="settings" className="w-full min-w-40 max-w-48">
            <SelectValue>
              {progress === 'default'
                ? t('settings.piarium.pluginSettings.field.pluginDefault')
                : t(progress === 'enabled'
                  ? 'settings.piarium.pluginSettings.field.enabled'
                  : 'settings.piarium.pluginSettings.field.disabled')}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">{t('settings.piarium.pluginSettings.field.pluginDefault')}</SelectItem>
            <SelectItem value="enabled">{t('settings.piarium.pluginSettings.field.enabled')}</SelectItem>
            <SelectItem value="disabled">{t('settings.piarium.pluginSettings.field.disabled')}</SelectItem>
          </SelectContent>
        </Select>
      </SettingsFieldRow>

      <div className="space-y-3 border-t border-border/60 pt-3">
        <SettingsFieldRow label={t('settings.piarium.pluginSettings.subagents.field.toolBudget')} controlClassName="w-full max-w-lg">
          <Select
            value={budgetMode}
            disabled={disabled}
            onValueChange={(value) => setConfig('toolBudget', value === 'default' ? undefined : (budget ?? { hard: 16 }))}
          >
            <SelectTrigger size="settings" className="w-full min-w-40 max-w-48">
              <SelectValue>
                {budgetMode === 'default'
                  ? t('settings.piarium.pluginSettings.field.pluginDefault')
                  : budget
                    ? t('settings.piarium.pluginSettings.subagents.overrides.mode.override')
                    : t('settings.piarium.pluginSettings.field.unsupportedValue')}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">{t('settings.piarium.pluginSettings.field.pluginDefault')}</SelectItem>
              <SelectItem value="override">{t('settings.piarium.pluginSettings.subagents.overrides.mode.override')}</SelectItem>
            </SelectContent>
          </Select>
        </SettingsFieldRow>
        {budgetMode === 'override' ? (
          <div className="grid gap-3 @xl:grid-cols-2">
            <SettingsFieldRow label={t('settings.piarium.pluginSettings.subagents.field.toolBudgetHard')} controlClassName="w-full">
              <NumberInput
                value={typeof budget?.hard === 'number' ? budget.hard : undefined}
                fallbackValue={16}
                disabled={disabled}
                min={1}
                step={1}
                onValueChange={(value) => setToolBudgetField('hard', value)}
                containerClassName="w-36"
              />
            </SettingsFieldRow>
            <SettingsFieldRow label={t('settings.piarium.pluginSettings.subagents.field.toolBudgetSoft')} controlClassName="w-full">
              <NumberInput
                value={typeof budget?.soft === 'number' ? budget.soft : undefined}
                fallbackValue={10}
                disabled={disabled}
                min={1}
                step={1}
                onClear={() => setToolBudgetField('soft', undefined)}
                onValueChange={(value) => setToolBudgetField('soft', value)}
                containerClassName="w-36"
                emptyLabel={t('settings.piarium.pluginSettings.field.pluginDefault')}
              />
            </SettingsFieldRow>
            <SettingsFieldRow label={t('settings.piarium.pluginSettings.subagents.field.toolsAfterBudget')} alignEnd={false} controlClassName="w-full items-start @xl:col-span-2">
              <div className="flex min-w-0 flex-1 flex-col gap-2 @xl:flex-row">
                <Select
                  value={blockMode}
                  disabled={disabled}
                  onValueChange={(value) => {
                    if (value === 'default') setToolBudgetField('block', undefined);
                    else if (value === 'all') setToolBudgetField('block', '*');
                    else setToolBudgetField('block', blockList ?? ['read', 'grep', 'find', 'ls']);
                  }}
                >
                  <SelectTrigger size="settings" className="w-full min-w-40 max-w-48">
                    <SelectValue>
                      {blockMode === 'default'
                        ? t('settings.piarium.pluginSettings.field.pluginDefault')
                        : t(blockMode === 'all'
                          ? 'settings.piarium.pluginSettings.subagents.value.allTools'
                          : 'settings.piarium.pluginSettings.subagents.value.selectedTools')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">{t('settings.piarium.pluginSettings.field.pluginDefault')}</SelectItem>
                    <SelectItem value="all">{t('settings.piarium.pluginSettings.subagents.value.allTools')}</SelectItem>
                    <SelectItem value="selected">{t('settings.piarium.pluginSettings.subagents.value.selectedTools')}</SelectItem>
                  </SelectContent>
                </Select>
                {blockMode === 'selected' ? (
                  <Textarea
                    value={(blockList ?? []).join('\n')}
                    disabled={disabled}
                    placeholder={'read\ngrep\nfind\nls'}
                    onChange={(event) => setToolBudgetField('block', event.target.value
                      .split(/\r?\n/)
                      .map((entry) => entry.trim())
                      .filter(Boolean))}
                    className="min-h-20 min-w-0 flex-1 font-mono"
                  />
                ) : null}
              </div>
            </SettingsFieldRow>
          </div>
        ) : null}
      </div>
    </div>
  );
};

function titleKey(mode: PiSubagentsDefinitionMode):
  | 'settings.piarium.agents.definition.createAgent'
  | 'settings.piarium.agents.definition.createWorkflow'
  | 'settings.piarium.agents.definition.editAgent'
  | 'settings.piarium.agents.definition.editWorkflow' {
  switch (mode) {
    case 'create-agent':
      return 'settings.piarium.agents.definition.createAgent';
    case 'create-workflow':
      return 'settings.piarium.agents.definition.createWorkflow';
    case 'update-agent':
      return 'settings.piarium.agents.definition.editAgent';
    case 'update-workflow':
      return 'settings.piarium.agents.definition.editWorkflow';
  }
}

export const PiSubagentsDefinitionDialog: React.FC<PiSubagentsDefinitionDialogProps> = ({
  agent,
  mode,
  onOpenChange,
  onSubmit,
  open,
  projectTrusted,
  submitting,
}) => {
  const { t } = useI18n();
  const tx = React.useCallback((key: string) => t(key as Parameters<typeof t>[0]), [t]);
  const [scope, setScope] = React.useState<ActionScope>('user');
  const [draft, setDraft] = React.useState<PiSubagentsDefinitionDraft>(() => (
    createPiSubagentsDefinitionDraft(agent)
  ));
  const [issue, setIssue] = React.useState<PiSubagentsDefinitionIssue | null>(null);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const createMode = mode === 'create-agent' || mode === 'create-workflow';

  React.useEffect(() => {
    if (!open || !mode) return;
    setDraft(createPiSubagentsDefinitionDraft(agent));
    setScope(agent?.source.scope === 'project' ? 'project' : 'user');
    setIssue(null);
    setAdvancedOpen(false);
  }, [agent, mode, open]);

  const update = React.useCallback(<K extends keyof PiSubagentsDefinitionDraft,>(
    key: K,
    value: PiSubagentsDefinitionDraft[K],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setIssue(null);
  }, []);

  const issueText = React.useMemo(() => {
    if (!issue) return null;
    switch (issue.code) {
      case 'invalid-integer': {
        const field = issue.field === 'timeoutMs'
          ? tx('settings.piarium.agents.definition.field.timeLimit')
          : tx('settings.piarium.agents.definition.field.delegationDepth');
        return t('settings.piarium.agents.definition.validation.integer', { field });
      }
      case 'invalid-json':
        return t('settings.piarium.agents.definition.validation.json');
      case 'json-object':
        return t('settings.piarium.agents.definition.validation.jsonObject');
      case 'name-description-required':
        return t('settings.piarium.agents.definition.validation.nameDescription');
      case 'no-changes':
        return t('settings.piarium.agents.definition.validation.noChanges');
      case 'unsupported-advanced-field':
        return `${t('settings.piarium.pluginSettings.field.unsupportedValue')}: ${issue.field}`;
      case 'unsupported-workflow-step-field':
        return `${t('settings.piarium.pluginSettings.field.unsupportedValue')}: ${t('settings.piarium.agents.definition.step', { index: issue.index + 1 })} · ${issue.field}`;
      case 'workflow-step-agent':
        return t('settings.piarium.agents.definition.validation.stepAgent', { index: issue.index + 1 });
    }
  }, [issue, t, tx]);

  const submit = React.useCallback(async () => {
    if (!mode) return;
    const built = buildPiSubagentsDefinitionConfig(mode, draft, agent);
    if (built.issue) {
      setIssue(built.issue);
      return;
    }
    if (scope === 'project' && !projectTrusted) return;
    if (await onSubmit(scope, built.config)) onOpenChange(false);
  }, [agent, draft, mode, onOpenChange, onSubmit, projectTrusted, scope]);

  if (!mode) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t(titleKey(mode))}</DialogTitle>
          <DialogDescription>
            {t(createMode
              ? 'settings.piarium.agents.definition.createDescription'
              : 'settings.piarium.agents.definition.updateDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-1">
          <SettingsControlGroup contentClassName="space-y-4">
            {createMode ? (
              <SettingsFieldRow label={tx('settings.piarium.agents.definition.field.saveLocation')} controlClassName="w-full max-w-lg">
                <Select value={scope} onValueChange={setScope} disabled={submitting}>
                  <SelectTrigger size="settings" className="w-full min-w-40 max-w-48">
                    <SelectValue>
                      {scope === 'project'
                        ? t('settings.piarium.agents.scope.project')
                        : t('settings.piarium.agents.scope.user')}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">{t('settings.piarium.agents.scope.user')}</SelectItem>
                    <SelectItem value="project" disabled={!projectTrusted}>
                      {t('settings.piarium.agents.scope.project')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </SettingsFieldRow>
            ) : null}
            <SettingsFieldRow label={tx('settings.piarium.agents.definition.field.name')} controlClassName="w-full max-w-lg">
              <Input
                value={draft.name}
                disabled={submitting}
                onChange={(event) => update('name', event.target.value)}
                className="min-w-0 flex-1"
              />
            </SettingsFieldRow>
            <SettingsFieldRow label={tx('settings.piarium.agents.definition.field.description')} alignEnd={false} controlClassName="w-full max-w-lg items-start">
              <Textarea
                value={draft.description}
                disabled={submitting}
                onChange={(event) => update('description', event.target.value)}
                className="min-h-20 min-w-0 flex-1"
              />
            </SettingsFieldRow>
          </SettingsControlGroup>

          {mode === 'create-workflow' || mode === 'update-workflow' ? (
            <SettingsControlGroup
              className="border-t border-border/60 pt-5"
              title={t('settings.piarium.agents.definition.steps')}
              contentClassName="space-y-3"
            >
              {draft.workflowSteps.map((step, index) => (
                <div key={index} className="border-t border-border/60 pt-3 first:border-t-0 first:pt-0">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className={SETTINGS_FIELD_LABEL_CLASS}>
                      {t('settings.piarium.agents.definition.step', { index: index + 1 })}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={submitting || draft.workflowSteps.length === 1}
                      onClick={() => update(
                        'workflowSteps',
                        draft.workflowSteps.filter((_, candidate) => candidate !== index),
                      )}
                    >
                      <Icon name="delete-bin" className="size-3.5" />
                      {t('settings.piarium.agents.definition.removeStep')}
                    </Button>
                  </div>
                  <div className="space-y-3">
                    <SettingsFieldRow label={tx('settings.piarium.agents.definition.field.stepAgent')} controlClassName="w-full max-w-lg">
                      <Input
                        value={step.agent}
                        disabled={submitting}
                        placeholder={tx('settings.piarium.agents.definition.placeholder.stepAgent')}
                        onChange={(event) => update(
                          'workflowSteps',
                          draft.workflowSteps.map((current, candidate) => (
                            candidate === index ? { ...current, agent: event.target.value } : current
                          )),
                        )}
                      />
                    </SettingsFieldRow>
                    <SettingsFieldRow label={tx('settings.piarium.agents.definition.field.stepTask')} alignEnd={false} controlClassName="w-full max-w-lg items-start">
                      <Textarea
                        value={step.task}
                        disabled={submitting}
                        placeholder={tx('settings.piarium.agents.definition.placeholder.stepTask')}
                        onChange={(event) => update(
                          'workflowSteps',
                          draft.workflowSteps.map((current, candidate) => (
                            candidate === index ? { ...current, task: event.target.value } : current
                          )),
                        )}
                        className="min-h-16"
                      />
                    </SettingsFieldRow>
                    <div className="border-t border-border/60 pt-3">
                      <WorkflowStepEditor
                        disabled={submitting}
                        step={step}
                        onChange={(next) => update(
                          'workflowSteps',
                          draft.workflowSteps.map((current, candidate) => (
                            candidate === index ? next : current
                          )),
                        )}
                      />
                    </div>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={submitting}
                onClick={() => update('workflowSteps', [
                  ...draft.workflowSteps,
                  { agent: '', config: {}, task: '' },
                ])}
              >
                <Icon name="add" className="size-4" />
                {t('settings.piarium.agents.definition.addStep')}
              </Button>
            </SettingsControlGroup>
          ) : null}

          {mode === 'create-agent' || mode === 'update-agent' ? (
            <>
              <SettingsControlGroup
                className="border-t border-border/60 pt-5"
                title={tx('settings.piarium.agents.definition.modelSection')}
                description={tx('settings.piarium.agents.definition.modelSectionDescription')}
                contentClassName="space-y-4"
              >
                <SettingsFieldRow label={tx('settings.piarium.agents.definition.field.primaryModel')} controlClassName="w-full max-w-lg">
                  <div
                    aria-disabled={submitting}
                    className={submitting ? 'pointer-events-none opacity-60' : undefined}
                    inert={submitting ? true : undefined}
                  >
                    <ModelSelector
                      {...splitModel(draft.model)}
                      placeholder={tx('settings.piarium.agents.definition.placeholder.inheritModel')}
                      onChange={(providerId, modelId) => update('model', providerId && modelId ? `${providerId}/${modelId}` : '')}
                      className="w-full max-w-72 justify-between"
                      dropdownPortalToBody
                    />
                  </div>
                </SettingsFieldRow>
                <SettingsFieldRow label={tx('settings.piarium.agents.definition.field.fallbackModels')} alignEnd={false} controlClassName="w-full max-w-lg items-start">
                  <Textarea value={draft.fallbackModels} disabled={submitting} placeholder={tx('settings.piarium.agents.definition.placeholder.fallbackModels')} onChange={(event) => update('fallbackModels', event.target.value)} className="min-h-20 min-w-0 flex-1 font-mono" />
                </SettingsFieldRow>
                <SettingsFieldRow label={tx('settings.piarium.agents.definition.field.thinkingLevel')} controlClassName="w-full max-w-lg">
                  <Select
                    value={!draft.thinking
                      ? 'default'
                      : isSupportedPiSubagentsThinking(draft.thinking) ? draft.thinking : 'unsupported'}
                    disabled={submitting}
                    onValueChange={(value) => {
                      if (value !== 'unsupported') update('thinking', value === 'default' ? '' : value);
                    }}
                  >
                    <SelectTrigger size="settings" className="w-full min-w-40 max-w-48">
                      <SelectValue>
                        {draft.thinking && !isSupportedPiSubagentsThinking(draft.thinking)
                          ? t('settings.piarium.pluginSettings.field.unsupportedValue')
                          : draft.thinking
                          ? tx(`settings.piarium.pluginSettings.subagents.thinking.${draft.thinking}`)
                          : tx('settings.piarium.agents.definition.value.inheritThinking')}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">{tx('settings.piarium.agents.definition.value.inheritThinking')}</SelectItem>
                      {draft.thinking && !isSupportedPiSubagentsThinking(draft.thinking) ? (
                        <SelectItem value="unsupported" disabled>
                          {t('settings.piarium.pluginSettings.field.unsupportedValue')}
                        </SelectItem>
                      ) : null}
                      {PI_SUBAGENTS_THINKING_LEVELS.map((level) => (
                        <SelectItem key={level} value={level}>{tx(`settings.piarium.pluginSettings.subagents.thinking.${level}`)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsFieldRow>
              </SettingsControlGroup>

              <SettingsControlGroup
                className="border-t border-border/60 pt-5"
                title={tx('settings.piarium.agents.definition.identitySection')}
                contentClassName="space-y-4"
              >
                <SettingsFieldRow label={tx('settings.piarium.agents.definition.field.systemInstructions')} alignEnd={false} controlClassName="w-full max-w-lg items-start">
                  <Textarea value={draft.systemPrompt} disabled={submitting} placeholder={tx('settings.piarium.agents.definition.placeholder.systemInstructions')} onChange={(event) => update('systemPrompt', event.target.value)} className="min-h-28 min-w-0 flex-1" />
                </SettingsFieldRow>
                <SettingsFieldRow label={tx('settings.piarium.agents.definition.field.startingContext')} controlClassName="w-full max-w-lg">
                  <Select value={draft.defaultContext || 'default'} disabled={submitting} onValueChange={(value) => update('defaultContext', value === 'default' ? '' : value as 'fresh' | 'fork')}>
                    <SelectTrigger size="settings" className="w-full min-w-40 max-w-48">
                      <SelectValue>
                        {draft.defaultContext
                          ? tx(`settings.piarium.pluginSettings.subagents.context.${draft.defaultContext}`)
                          : t('settings.piarium.pluginSettings.field.pluginDefault')}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">{t('settings.piarium.pluginSettings.field.pluginDefault')}</SelectItem>
                      <SelectItem value="fresh">{tx('settings.piarium.pluginSettings.subagents.context.fresh')}</SelectItem>
                      <SelectItem value="fork">{tx('settings.piarium.pluginSettings.subagents.context.fork')}</SelectItem>
                    </SelectContent>
                  </Select>
                </SettingsFieldRow>
                <SettingsFieldRow label={tx('settings.piarium.agents.definition.field.allowedTools')} alignEnd={false} controlClassName="w-full max-w-lg items-start">
                  <Textarea value={draft.tools} disabled={submitting} placeholder={tx('settings.piarium.agents.definition.placeholder.tools')} onChange={(event) => update('tools', event.target.value)} className="min-h-20 min-w-0 flex-1 font-mono" />
                </SettingsFieldRow>
                <SettingsFieldRow label={tx('settings.piarium.agents.definition.field.availableSkills')} alignEnd={false} controlClassName="w-full max-w-lg items-start">
                  <Textarea value={draft.skills} disabled={submitting} placeholder={tx('settings.piarium.agents.definition.placeholder.skills')} onChange={(event) => update('skills', event.target.value)} className="min-h-20 min-w-0 flex-1 font-mono" />
                </SettingsFieldRow>
                <SettingsFieldRow label={tx('settings.piarium.agents.definition.field.extensions')} alignEnd={false} controlClassName="w-full max-w-lg items-start">
                  <Textarea value={draft.extensions} disabled={submitting} placeholder={tx('settings.piarium.agents.definition.placeholder.extensions')} onChange={(event) => update('extensions', event.target.value)} className="min-h-20 min-w-0 flex-1 font-mono" />
                </SettingsFieldRow>
                <SettingsFieldRow label={tx('settings.piarium.agents.definition.field.timeLimit')} controlClassName="w-full max-w-lg">
                  <Input value={draft.timeoutMs} disabled={submitting} inputMode="numeric" placeholder={tx('settings.piarium.agents.definition.placeholder.milliseconds')} onChange={(event) => update('timeoutMs', event.target.value)} className="w-36" />
                </SettingsFieldRow>
                <SettingsFieldRow label={tx('settings.piarium.agents.definition.field.delegationDepth')} controlClassName="w-full max-w-lg">
                  <Input value={draft.maxSubagentDepth} disabled={submitting} inputMode="numeric" placeholder={tx('settings.piarium.agents.definition.placeholder.depth')} onChange={(event) => update('maxSubagentDepth', event.target.value)} className="w-36" />
                </SettingsFieldRow>
              </SettingsControlGroup>
            </>
          ) : null}

          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger className="border border-border/60 px-3 py-2.5">
              <span className="typography-ui-label text-foreground">
                {advancedOpen
                  ? t('settings.piarium.pluginSettings.advanced.hide')
                  : t('settings.piarium.pluginSettings.advanced.show')}
              </span>
              <Icon name={advancedOpen ? 'arrow-up-s' : 'arrow-down-s'} className="size-4 text-muted-foreground" />
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2 pt-3">
              <label htmlFor="pi-subagents-advanced-config" className={SETTINGS_FIELD_LABEL_CLASS}>
                {tx('settings.piarium.agents.definition.field.advancedOptions')}
              </label>
              <Textarea
                id="pi-subagents-advanced-config"
                value={draft.advancedJson}
                disabled={submitting}
                onChange={(event) => update('advancedJson', event.target.value)}
                className="min-h-40 font-mono"
                spellCheck={false}
              />
            </CollapsibleContent>
          </Collapsible>

          {scope === 'project' && !projectTrusted ? (
            <p className="typography-meta text-[var(--status-warning)]">
              {t('settings.piarium.recovery.pluginSettings.projectUntrusted')}
            </p>
          ) : null}
          {issueText ? (
            <p className="typography-meta text-[var(--status-error)]">{issueText}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={submitting} onClick={() => onOpenChange(false)}>
            {t('settings.common.actions.cancel')}
          </Button>
          <Button
            type="button"
            disabled={submitting || (scope === 'project' && !projectTrusted)}
            onClick={() => void submit()}
          >
            {submitting ? (
              <Icon name="loader-4" className="size-4 animate-spin" />
            ) : null}
            {t(createMode ? 'settings.common.actions.create' : 'settings.common.actions.saveChanges')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
