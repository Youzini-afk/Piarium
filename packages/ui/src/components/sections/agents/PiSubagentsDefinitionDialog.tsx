import React from 'react';
import type { JsonValue, PiAgentDescriptor } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import {
  SETTINGS_FIELD_LABEL_CLASS,
  SETTINGS_HELPER_CLASS,
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
  type PiSubagentsDefinitionDraft,
  type PiSubagentsDefinitionIssue,
  type PiSubagentsDefinitionMode,
} from './pi-subagents-action-model';

type ActionScope = 'user' | 'project';

interface PiSubagentsDefinitionDialogProps {
  agent?: PiAgentDescriptor;
  mode: PiSubagentsDefinitionMode | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (scope: ActionScope, config: Record<string, JsonValue>) => Promise<boolean>;
  open: boolean;
  projectTrusted: boolean;
  submitting: boolean;
}

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
      case 'invalid-integer':
        return t('settings.piarium.agents.definition.validation.integer', { field: issue.field });
      case 'invalid-json':
        return t('settings.piarium.agents.definition.validation.json');
      case 'json-object':
        return t('settings.piarium.agents.definition.validation.jsonObject');
      case 'name-description-required':
        return t('settings.piarium.agents.definition.validation.nameDescription');
      case 'no-changes':
        return t('settings.piarium.agents.definition.validation.noChanges');
      case 'workflow-step-agent':
        return t('settings.piarium.agents.definition.validation.stepAgent', { index: issue.index + 1 });
    }
  }, [issue, t]);

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
              <SettingsFieldRow label="scope" controlClassName="w-full max-w-lg">
                <Select value={scope} onValueChange={setScope} disabled={submitting}>
                  <SelectTrigger size="settings" className="w-full min-w-40 max-w-48">
                    <SelectValue />
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
            <SettingsFieldRow label="name" controlClassName="w-full max-w-lg">
              <Input
                value={draft.name}
                disabled={submitting}
                onChange={(event) => update('name', event.target.value)}
                className="min-w-0 flex-1"
              />
            </SettingsFieldRow>
            <SettingsFieldRow label="description" alignEnd={false} controlClassName="w-full max-w-lg items-start">
              <Textarea
                value={draft.description}
                disabled={submitting}
                onChange={(event) => update('description', event.target.value)}
                className="min-h-20 min-w-0 flex-1"
              />
            </SettingsFieldRow>
          </SettingsControlGroup>

          {mode === 'create-workflow' ? (
            <SettingsControlGroup
              className="border-t border-border/60 pt-5"
              title={t('settings.piarium.agents.definition.steps')}
              contentClassName="space-y-3"
            >
              {draft.workflowSteps.map((step, index) => (
                <div key={index} className="rounded-lg border border-border/60 bg-background/50 p-3">
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
                    <Input
                      value={step.agent}
                      disabled={submitting}
                      placeholder="agent"
                      onChange={(event) => update(
                        'workflowSteps',
                        draft.workflowSteps.map((current, candidate) => (
                          candidate === index ? { ...current, agent: event.target.value } : current
                        )),
                      )}
                    />
                    <Textarea
                      value={step.task}
                      disabled={submitting}
                      placeholder="task"
                      onChange={(event) => update(
                        'workflowSteps',
                        draft.workflowSteps.map((current, candidate) => (
                          candidate === index ? { ...current, task: event.target.value } : current
                        )),
                      )}
                      className="min-h-16"
                    />
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
                  { agent: '', task: '' },
                ])}
              >
                <Icon name="add" className="size-4" />
                {t('settings.piarium.agents.definition.addStep')}
              </Button>
            </SettingsControlGroup>
          ) : null}

          {mode === 'create-agent' || mode === 'update-agent' ? (
            <SettingsControlGroup
              className="border-t border-border/60 pt-5"
              title={t('settings.piarium.agents.definition.agentOptions')}
              contentClassName="space-y-4"
            >
              <SettingsFieldRow label="model" controlClassName="w-full max-w-lg">
                <Input value={draft.model} disabled={submitting} placeholder="provider/model" onChange={(event) => update('model', event.target.value)} className="min-w-0 flex-1" />
              </SettingsFieldRow>
              <SettingsFieldRow label="fallbackModels" alignEnd={false} controlClassName="w-full max-w-lg items-start">
                <Textarea value={draft.fallbackModels} disabled={submitting} placeholder="provider/model" onChange={(event) => update('fallbackModels', event.target.value)} className="min-h-20 min-w-0 flex-1 font-mono" />
              </SettingsFieldRow>
              <SettingsFieldRow label="thinking" controlClassName="w-full max-w-lg">
                <Input value={draft.thinking} disabled={submitting} placeholder="off | low | medium | high | xhigh | max" onChange={(event) => update('thinking', event.target.value)} className="min-w-0 flex-1" />
              </SettingsFieldRow>
              <SettingsFieldRow label="aliases" alignEnd={false} controlClassName="w-full max-w-lg items-start">
                <Textarea value={draft.aliases} disabled={submitting} onChange={(event) => update('aliases', event.target.value)} className="min-h-20 min-w-0 flex-1 font-mono" />
              </SettingsFieldRow>
              {mode === 'create-agent' ? (
                <>
                  <SettingsFieldRow label="systemPrompt" alignEnd={false} controlClassName="w-full max-w-lg items-start">
                    <Textarea value={draft.systemPrompt} disabled={submitting} onChange={(event) => update('systemPrompt', event.target.value)} className="min-h-28 min-w-0 flex-1" />
                  </SettingsFieldRow>
                  <SettingsFieldRow label="defaultContext" controlClassName="w-full max-w-lg">
                    <Select value={draft.defaultContext || 'default'} disabled={submitting} onValueChange={(value) => update('defaultContext', value === 'default' ? '' : value as 'fresh' | 'fork')}>
                      <SelectTrigger size="settings" className="w-full min-w-40 max-w-48"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">{t('settings.piarium.pluginSettings.field.pluginDefault')}</SelectItem>
                        <SelectItem value="fresh">fresh</SelectItem>
                        <SelectItem value="fork">fork</SelectItem>
                      </SelectContent>
                    </Select>
                  </SettingsFieldRow>
                  <SettingsFieldRow label="tools" alignEnd={false} controlClassName="w-full max-w-lg items-start">
                    <Textarea value={draft.tools} disabled={submitting} onChange={(event) => update('tools', event.target.value)} className="min-h-20 min-w-0 flex-1 font-mono" />
                  </SettingsFieldRow>
                  <SettingsFieldRow label="skills" alignEnd={false} controlClassName="w-full max-w-lg items-start">
                    <Textarea value={draft.skills} disabled={submitting} onChange={(event) => update('skills', event.target.value)} className="min-h-20 min-w-0 flex-1 font-mono" />
                  </SettingsFieldRow>
                  <SettingsFieldRow label="extensions" alignEnd={false} controlClassName="w-full max-w-lg items-start">
                    <Textarea value={draft.extensions} disabled={submitting} onChange={(event) => update('extensions', event.target.value)} className="min-h-20 min-w-0 flex-1 font-mono" />
                  </SettingsFieldRow>
                  <SettingsFieldRow label="timeoutMs" controlClassName="w-full max-w-lg">
                    <Input value={draft.timeoutMs} disabled={submitting} inputMode="numeric" onChange={(event) => update('timeoutMs', event.target.value)} className="w-36" />
                  </SettingsFieldRow>
                  <SettingsFieldRow label="maxSubagentDepth" controlClassName="w-full max-w-lg">
                    <Input value={draft.maxSubagentDepth} disabled={submitting} inputMode="numeric" onChange={(event) => update('maxSubagentDepth', event.target.value)} className="w-36" />
                  </SettingsFieldRow>
                </>
              ) : null}
            </SettingsControlGroup>
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
                advanced config
              </label>
              <p className={SETTINGS_HELPER_CLASS}>
                {t('settings.piarium.agents.definition.advancedDescription')}
              </p>
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
