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

function titleKey(mode: PiSubagentsDefinitionMode):
  | 'settings.piarium.agents.definition.createAgent'
  | 'settings.piarium.agents.definition.editAgent' {
  switch (mode) {
    case 'create-agent':
      return 'settings.piarium.agents.definition.createAgent';
    case 'update-agent':
      return 'settings.piarium.agents.definition.editAgent';
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
  const createMode = mode === 'create-agent';

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
