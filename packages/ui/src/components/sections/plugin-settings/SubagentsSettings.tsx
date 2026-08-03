import React from 'react';
import type { PiConfigScope, RuntimeContextTarget } from '@piarium/protocol';
import { SettingsChipGroup, SettingsControlGroup } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import {
  PluginBooleanField,
  PluginNumberField,
  PluginOptionalBooleanField,
  PluginOptionalNumberField,
  PluginSelectField,
  PluginStringField,
  PluginStringListField,
} from './PluginConfigFields';
import { PluginDraftFooter, PluginRuntimeNote, ScopeSelector } from './PluginSettingsPanelShared';
import { readJsonPath, setJsonPath } from './plugin-config-model';
import { SubagentsAgentOverrides } from './SubagentsAgentOverrides';
import {
  subagentsRuntimeDraftIssue,
  subagentsSettingsDraftIssue,
  type SubagentsDraftIssue,
} from './subagents-config-model';
import {
  useConfigDocumentObjectDraft,
  useSettingsObjectDraft,
} from './usePluginConfigDraft';

interface SubagentsSettingsProps {
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
}

const SUBGROUP_CLASS = 'border-t border-border/60 pt-5';
type SubagentsPanel = 'agents' | 'watchdog' | 'runtime' | 'budgets';

export const SubagentsSettings: React.FC<SubagentsSettingsProps> = ({ runtimeTarget, targetKey }) => {
  const { t } = useI18n();
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const [scope, setScope] = React.useState<PiConfigScope>('global');
  const [panel, setPanel] = React.useState<SubagentsPanel>('agents');
  const settings = useSettingsObjectDraft({
    property: 'subagents',
    runtimeTarget,
    scope,
    targetKey,
  });
  const runtime = useConfigDocumentObjectDraft({
    path: 'extensions/subagent/config.json',
    runtimeTarget,
    scope: 'global',
    targetKey,
  });
  const settingsTrustBlocked = scope === 'project' && !settings.projectTrusted;
  const settingsIssue = React.useMemo(
    () => subagentsSettingsDraftIssue(settings.draft),
    [settings.draft],
  );
  const runtimeIssue = React.useMemo(
    () => subagentsRuntimeDraftIssue(runtime.draft),
    [runtime.draft],
  );
  const issueMessage = React.useCallback((issue: SubagentsDraftIssue): string => {
    switch (issue.code) {
      case 'model-scope-allow-required':
        return t('settings.piarium.pluginSettings.subagents.validation.modelScopeAllow');
      case 'required':
        return t('settings.piarium.pluginSettings.subagents.validation.required', { field: issue.field });
      case 'invalid-number':
        return t('settings.piarium.pluginSettings.subagents.validation.invalidNumber', { field: issue.field });
      case 'invalid-value':
        return t('settings.piarium.pluginSettings.subagents.validation.invalidValue', { field: issue.field });
      case 'soft-exceeds-hard':
        return t('settings.piarium.pluginSettings.subagents.validation.softExceedsHard', { field: issue.field });
    }
  }, [t]);
  const settingsFields = {
    disabled: !settings.loaded || settings.loading || settings.saving || settingsTrustBlocked,
    draft: settings.draft,
    onRemove: settings.removeValue,
    onSet: settings.setValue,
  };
  const runtimeFields = {
    disabled: !runtime.loaded || runtime.loading || runtime.saving,
    draft: runtime.draft,
    onRemove: runtime.removeValue,
    onSet: runtime.setValue,
  };
  const fleetValue = readJsonPath(runtime.draft, ['fleetView']);
  const fleetEnabled = typeof fleetValue === 'boolean' ? fleetValue : true;
  const waitToolValue = readJsonPath(runtime.draft, ['waitTool']);
  const waitToolDraft = typeof waitToolValue === 'boolean'
    ? { ...runtime.draft, waitTool: { enabled: waitToolValue } }
    : runtime.draft;
  const proactiveValue = readJsonPath(runtime.draft, ['proactiveSkillSubagents']);
  const proactiveDraft = proactiveValue === false
    ? setJsonPath(runtime.draft, ['proactiveSkillSubagents'], { enabled: false })
    : runtime.draft;
  const proactiveFields = {
    ...runtimeFields,
    draft: proactiveDraft,
    onRemove: (path: readonly string[]) => {
      if (proactiveValue === false && path[0] === 'proactiveSkillSubagents') {
        runtime.removeValue(['proactiveSkillSubagents']);
        return;
      }
      runtime.removeValue(path);
    },
    onSet: (path: readonly string[], value: Parameters<typeof runtime.setValue>[1]) => {
      if (proactiveValue === false && path[0] === 'proactiveSkillSubagents') {
        runtime.setValue(
          ['proactiveSkillSubagents'],
          setJsonPath({ enabled: false }, path.slice(1), value),
        );
        return;
      }
      runtime.setValue(path, value);
    },
  };
  const pluginDefault = t('settings.piarium.pluginSettings.field.pluginDefault');
  const unlimited = t('settings.piarium.pluginSettings.subagents.value.unlimited');
  const off = t('settings.piarium.pluginSettings.subagents.value.off');
  const panelOptions: Array<{ value: SubagentsPanel; label: string }> = [
    { value: 'agents', label: t('settings.page.agents.title') },
    { value: 'watchdog', label: t('settings.piarium.pluginSettings.subagents.watchdog.title') },
    { value: 'runtime', label: t('settings.piarium.pluginSettings.subagents.runtime.title') },
    { value: 'budgets', label: t('settings.piarium.pluginSettings.subagents.runtime.budgets') },
  ];

  return (
    <div className="space-y-8">
      <PluginRuntimeNote>{t('settings.piarium.pluginSettings.subagents.runtimeNote')}</PluginRuntimeNote>

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setSettingsPage('agents')}>
          {t('settings.page.agents.title')}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setSettingsPage('fleet')}>
          {t('settings.page.fleet.title')}
        </Button>
      </div>

      <div className="rounded-lg border border-border/60 px-4 py-3">
        <SettingsChipGroup
          value={panel}
          options={panelOptions}
          onChange={setPanel}
          aria-label="pi-subagents"
        />
      </div>

      {panel === 'agents' || panel === 'watchdog' ? (
      <div className="space-y-5 rounded-lg border border-border/60 px-4 py-4">
        <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
          <div className="space-y-1">
            <h3 className="typography-settings-group-title text-foreground">
              {panel === 'agents'
                ? t('settings.piarium.pluginSettings.subagents.defaults.title')
                : t('settings.piarium.pluginSettings.subagents.watchdog.title')}
            </h3>
            <p className="typography-meta text-muted-foreground">
              {panel === 'agents'
                ? t('settings.piarium.pluginSettings.subagents.defaults.description')
                : t('settings.piarium.pluginSettings.subagents.watchdog.description')}
            </p>
          </div>
          <ScopeSelector value={scope} onChange={setScope} disabled={settings.saving} />
        </div>

        {panel === 'agents' ? <>
        <div className="space-y-4">
          <PluginStringField {...settingsFields} path={['defaultModel']} label="defaultModel" placeholder="provider/model" />
          <PluginStringField {...settingsFields} path={['defaultThinking']} label="defaultThinking" placeholder="off | minimal | low | medium | high | xhigh | max" />
          <PluginStringListField {...settingsFields} path={['defaultExtensions']} label="defaultExtensions" placeholder="extension/path.ts" emptyArrayOnClear />
          <PluginBooleanField {...settingsFields} path={['disableBuiltins']} label="disableBuiltins" defaultValue={false} />
          <PluginBooleanField {...settingsFields} path={['disableThinking']} label="disableThinking" defaultValue={false} />
          {scope === 'project' ? (
            <PluginSelectField
              {...settingsFields}
              path={['projectRootResolution']}
              label="projectRootResolution"
              defaultValue="nearest"
              options={[
                { value: 'nearest', label: 'nearest' },
                { value: 'git-root', label: 'git-root' },
              ]}
            />
          ) : null}
        </div>

        <SettingsControlGroup
          className={SUBGROUP_CLASS}
          title={t('settings.piarium.pluginSettings.subagents.modelScope.title')}
          contentClassName="space-y-4"
        >
          <PluginBooleanField {...settingsFields} path={['modelScope', 'enforce']} label="modelScope.enforce" defaultValue={false} />
          <PluginStringListField {...settingsFields} path={['modelScope', 'allow']} label="modelScope.allow" placeholder="provider/*" />
        </SettingsControlGroup>

        <SubagentsAgentOverrides
          {...settingsFields}
          runtimeTarget={runtimeTarget}
          targetKey={`${targetKey}:${scope}`}
        />
        </> : null}

        {panel === 'watchdog' ? <>
        <SettingsControlGroup
          className={SUBGROUP_CLASS}
          title={t('settings.piarium.pluginSettings.subagents.watchdog.title')}
          description={t('settings.piarium.pluginSettings.subagents.watchdog.description')}
          contentClassName="space-y-4"
        >
          <PluginBooleanField {...settingsFields} path={['watchdog', 'enabled']} label="watchdog.enabled" defaultValue={false} />
          <PluginBooleanField {...settingsFields} path={['watchdog', 'showDuringRun']} label="watchdog.showDuringRun" defaultValue={false} />
        </SettingsControlGroup>
        </> : null}

        <SettingsControlGroup
          className={SUBGROUP_CLASS}
          title={t('settings.piarium.pluginSettings.subagents.watchdog.review')}
          contentClassName="space-y-4"
        >
          <PluginOptionalNumberField {...settingsFields} path={['watchdog', 'syncBacklog']} label="watchdog.syncBacklog" defaultValue="off" emptyValue="off" emptyLabel={off} min={1} fallbackValue={1} />
          <PluginNumberField {...settingsFields} path={['watchdog', 'agentEndTimeoutMs']} label="watchdog.agentEndTimeoutMs" defaultValue={30000} min={1} unit="ms" />
          <PluginSelectField
            {...settingsFields}
            path={['watchdog', 'severityThreshold']}
            label="watchdog.severityThreshold"
            defaultValue="concern"
            options={[
              { value: 'concern', label: 'concern' },
              { value: 'blocker', label: 'blocker' },
            ]}
          />
          <PluginOptionalNumberField {...settingsFields} path={['watchdog', 'maxWarnings']} label="watchdog.maxWarnings" defaultValue={null} emptyValue={null} emptyLabel={unlimited} min={0} fallbackValue={0} />
          <PluginNumberField {...settingsFields} path={['watchdog', 'compactAtPercent']} label="watchdog.compactAtPercent" defaultValue={80} min={50} max={95} unit="%" />
          <PluginNumberField {...settingsFields} path={['watchdog', 'reviewRetryDelayMs']} label="watchdog.reviewRetryDelayMs" defaultValue={1000} min={1} unit="ms" />
          <PluginNumberField {...settingsFields} path={['watchdog', 'maxReviewFailures']} label="watchdog.maxReviewFailures" defaultValue={3} min={1} />
          <PluginBooleanField {...settingsFields} path={['watchdog', 'guidance', 'watchdogMd']} label="watchdog.guidance.watchdogMd" defaultValue />
          <PluginStringField {...settingsFields} path={['watchdog', 'guidance', 'systemPromptPath']} label="watchdog.guidance.systemPromptPath" placeholder="path/to/watchdog-prompt.md" />
          <PluginBooleanField {...settingsFields} path={['watchdog', 'autoFollow', 'blockers']} label="watchdog.autoFollow.blockers" defaultValue />
          <PluginOptionalNumberField {...settingsFields} path={['watchdog', 'autoFollow', 'maxAttempts']} label="watchdog.autoFollow.maxAttempts" defaultValue={3} emptyValue={null} emptyLabel={unlimited} min={1} fallbackValue={1} />
          <PluginNumberField {...settingsFields} path={['watchdog', 'autoFollow', 'stalemateRepeats']} label="watchdog.autoFollow.stalemateRepeats" defaultValue={3} min={1} />
        </SettingsControlGroup>

        <SettingsControlGroup
          className={SUBGROUP_CLASS}
          title={t('settings.piarium.pluginSettings.subagents.watchdog.endpoints')}
          contentClassName="space-y-4"
        >
          <PluginOptionalBooleanField {...settingsFields} path={['watchdog', 'main', 'enabled']} label="watchdog.main.enabled" />
          <PluginStringField {...settingsFields} path={['watchdog', 'main', 'model']} label="watchdog.main.model" placeholder="provider/model" />
          <PluginStringField {...settingsFields} path={['watchdog', 'main', 'thinking']} label="watchdog.main.thinking" placeholder="off | low | medium | high | xhigh | max" />
          <PluginBooleanField {...settingsFields} path={['watchdog', 'children', 'enabled']} label="watchdog.children.enabled" defaultValue={false} />
          <PluginStringField {...settingsFields} path={['watchdog', 'children', 'model']} label="watchdog.children.model" placeholder="provider/model" />
          <PluginStringField {...settingsFields} path={['watchdog', 'children', 'thinking']} label="watchdog.children.thinking" placeholder="off | low | medium | high | xhigh | max" />
          <PluginNumberField {...settingsFields} path={['watchdog', 'children', 'watchdogTailTimeoutMs']} label="watchdog.children.watchdogTailTimeoutMs" defaultValue={120000} min={1} unit="ms" />
          <PluginBooleanField {...settingsFields} path={['watchdog', 'children', 'autoFollow', 'blockers']} label="watchdog.children.autoFollow.blockers" defaultValue />
          <PluginOptionalNumberField {...settingsFields} path={['watchdog', 'children', 'autoFollow', 'maxAttempts']} label="watchdog.children.autoFollow.maxAttempts" defaultValue={3} emptyValue={null} emptyLabel={unlimited} min={1} fallbackValue={1} />
          <PluginNumberField {...settingsFields} path={['watchdog', 'children', 'autoFollow', 'stalemateRepeats']} label="watchdog.children.autoFollow.stalemateRepeats" defaultValue={3} min={1} />
          <PluginBooleanField {...settingsFields} path={['watchdog', 'asyncCompletion', 'enabled']} label="watchdog.asyncCompletion.enabled" defaultValue={false} />
          <PluginBooleanField {...settingsFields} path={['watchdog', 'asyncCompletion', 'autoFollowBlockers']} label="watchdog.asyncCompletion.autoFollowBlockers" defaultValue={false} />
        </SettingsControlGroup>

        <SettingsControlGroup
          className={SUBGROUP_CLASS}
          title={t('settings.piarium.pluginSettings.subagents.watchdog.lsp')}
          contentClassName="space-y-4"
        >
          <PluginBooleanField {...settingsFields} path={['watchdog', 'lsp', 'enabled']} label="watchdog.lsp.enabled" defaultValue />
          <PluginNumberField {...settingsFields} path={['watchdog', 'lsp', 'timeoutMs']} label="watchdog.lsp.timeoutMs" defaultValue={3000} min={1} unit="ms" />
          <PluginNumberField {...settingsFields} path={['watchdog', 'lsp', 'maxFiles']} label="watchdog.lsp.maxFiles" defaultValue={20} min={1} />
          <PluginNumberField {...settingsFields} path={['watchdog', 'lsp', 'maxDiagnostics']} label="watchdog.lsp.maxDiagnostics" defaultValue={50} min={0} />
        </SettingsControlGroup>

        <PluginDraftFooter
          controller={settings}
          blocked={settingsTrustBlocked || settingsIssue !== null}
          blockedMessage={settingsTrustBlocked || !settingsIssue ? undefined : issueMessage(settingsIssue)}
        />
      </div>
      ) : null}

      {panel === 'runtime' || panel === 'budgets' ? (
      <div className="space-y-5 rounded-lg border border-border/60 px-4 py-4">
        <div className="space-y-1">
          <h3 className="typography-settings-group-title text-foreground">
            {t('settings.piarium.pluginSettings.subagents.runtime.title')}
          </h3>
          <p className="typography-meta text-muted-foreground">
            {t('settings.piarium.pluginSettings.subagents.runtime.description')}
          </p>
        </div>

        {panel === 'runtime' ? <>
        <SettingsControlGroup
          title={t('settings.piarium.pluginSettings.subagents.runtime.execution')}
          contentClassName="space-y-4"
        >
          <PluginBooleanField {...runtimeFields} path={['asyncByDefault']} label="asyncByDefault" defaultValue={false} />
          <PluginBooleanField {...runtimeFields} path={['forceTopLevelAsync']} label="forceTopLevelAsync" defaultValue={false} />
          <PluginBooleanField {...runtimeFields} path={['fleetView']} label="fleetView" defaultValue />
          <PluginSelectField
            {...runtimeFields}
            path={['fleetViewPlacement']}
            label="fleetViewPlacement"
            defaultValue="belowEditor"
            options={[
              { value: 'aboveEditor', label: 'aboveEditor' },
              { value: 'belowEditor', label: 'belowEditor' },
            ]}
          />
          <PluginBooleanField {...runtimeFields} path={['asyncWidget']} label="asyncWidget" defaultValue={!fleetEnabled} />
          <PluginSelectField
            {...runtimeFields}
            path={['toolDescriptionMode']}
            label="toolDescriptionMode"
            defaultValue="full"
            options={[
              { value: 'full', label: 'full' },
              { value: 'compact', label: 'compact' },
              { value: 'custom', label: 'custom' },
            ]}
          />
          <PluginBooleanField
            {...runtimeFields}
            draft={waitToolDraft}
            path={['waitTool', 'enabled']}
            label="waitTool.enabled"
            defaultValue
          />
        </SettingsControlGroup>
        </> : null}

        {panel === 'budgets' ? (
        <SettingsControlGroup
          className={SUBGROUP_CLASS}
          title={t('settings.piarium.pluginSettings.subagents.runtime.limits')}
          contentClassName="space-y-4"
        >
          <PluginNumberField {...runtimeFields} path={['maxSubagentDepth']} label="maxSubagentDepth" defaultValue={2} min={0} />
          <PluginNumberField {...runtimeFields} path={['maxSubagentSpawnsPerSession']} label="maxSubagentSpawnsPerSession" description={t('settings.piarium.pluginSettings.subagents.unlimitedZero')} defaultValue={0} min={0} />
          <PluginNumberField {...runtimeFields} path={['globalConcurrencyLimit']} label="globalConcurrencyLimit" defaultValue={20} min={1} />
          <PluginNumberField {...runtimeFields} path={['parallel', 'maxTasks']} label="parallel.maxTasks" defaultValue={8} min={1} />
          <PluginNumberField {...runtimeFields} path={['parallel', 'concurrency']} label="parallel.concurrency" defaultValue={4} min={1} />
          <PluginOptionalNumberField {...runtimeFields} path={['chain', 'dynamicFanout', 'maxItems']} label="chain.dynamicFanout.maxItems" emptyLabel={pluginDefault} min={0} fallbackValue={0} />
        </SettingsControlGroup>
        ) : null}

        <SettingsControlGroup
          className={SUBGROUP_CLASS}
          title={t('settings.piarium.pluginSettings.subagents.runtime.storage')}
          contentClassName="space-y-4"
        >
          <PluginSelectField
            {...runtimeFields}
            path={['artifactDir']}
            label="artifactDir"
            defaultValue="project"
            options={[
              { value: 'project', label: 'project' },
              { value: 'session', label: 'session' },
              { value: 'temp', label: 'temp' },
            ]}
          />
          <PluginStringField {...runtimeFields} path={['defaultSessionDir']} label="defaultSessionDir" placeholder="~/.pi/agent/sessions/subagent" />
          <PluginStringField {...runtimeFields} path={['singleRunOutputBaseDir']} label="singleRunOutputBaseDir" placeholder="~/.pi/subagent-outputs" />
          <PluginStringField {...runtimeFields} path={['worktreeBaseDir']} label="worktreeBaseDir" placeholder="path/to/worktrees" />
          <PluginStringField {...runtimeFields} path={['worktreeSetupHook']} label="worktreeSetupHook" placeholder="./scripts/setup-worktree.mjs" />
          <PluginNumberField {...runtimeFields} path={['worktreeSetupHookTimeoutMs']} label="worktreeSetupHookTimeoutMs" defaultValue={30000} min={1} unit="ms" />
        </SettingsControlGroup>

        <SettingsControlGroup
          className={SUBGROUP_CLASS}
          title={t('settings.piarium.pluginSettings.subagents.runtime.coordination')}
          contentClassName="space-y-4"
        >
          <PluginSelectField
            {...runtimeFields}
            path={['intercomBridge', 'mode']}
            label="intercomBridge.mode"
            defaultValue="always"
            options={[
              { value: 'off', label: 'off' },
              { value: 'fork-only', label: 'fork-only' },
              { value: 'always', label: 'always' },
            ]}
          />
          <PluginStringField {...runtimeFields} path={['intercomBridge', 'instructionFile']} label="intercomBridge.instructionFile" placeholder="./intercom-bridge.md" />
          <PluginBooleanField {...runtimeFields} path={['intercomBridge', 'resultDelivery']} label="intercomBridge.resultDelivery" defaultValue />
          <PluginBooleanField {...runtimeFields} path={['scheduledRuns', 'enabled']} label="scheduledRuns.enabled" defaultValue={false} />
          <PluginNumberField {...runtimeFields} path={['scheduledRuns', 'maxPending']} label="scheduledRuns.maxPending" defaultValue={20} min={1} />
          <PluginNumberField {...runtimeFields} path={['scheduledRuns', 'maxLatenessMs']} label="scheduledRuns.maxLatenessMs" defaultValue={300000} min={0} unit="ms" />
        </SettingsControlGroup>

        <SettingsControlGroup
          className={SUBGROUP_CLASS}
          title={t('settings.piarium.pluginSettings.subagents.runtime.notifications')}
          contentClassName="space-y-4"
        >
          <PluginBooleanField {...runtimeFields} path={['completionBatch', 'enabled']} label="completionBatch.enabled" defaultValue />
          <PluginNumberField {...runtimeFields} path={['completionBatch', 'debounceMs']} label="completionBatch.debounceMs" defaultValue={150} min={1} unit="ms" />
          <PluginNumberField {...runtimeFields} path={['completionBatch', 'maxWaitMs']} label="completionBatch.maxWaitMs" defaultValue={1000} min={1} unit="ms" />
          <PluginNumberField {...runtimeFields} path={['completionBatch', 'stragglerDebounceMs']} label="completionBatch.stragglerDebounceMs" defaultValue={75} min={1} unit="ms" />
          <PluginNumberField {...runtimeFields} path={['completionBatch', 'stragglerMaxWaitMs']} label="completionBatch.stragglerMaxWaitMs" defaultValue={400} min={1} unit="ms" />
          <PluginNumberField {...runtimeFields} path={['completionBatch', 'stragglerWindowMs']} label="completionBatch.stragglerWindowMs" defaultValue={2000} min={1} unit="ms" />
          <PluginBooleanField {...runtimeFields} path={['control', 'enabled']} label="control.enabled" defaultValue />
          <PluginNumberField {...runtimeFields} path={['control', 'needsAttentionAfterMs']} label="control.needsAttentionAfterMs" defaultValue={60000} min={1} unit="ms" />
          <PluginNumberField {...runtimeFields} path={['control', 'activeNoticeAfterMs']} label="control.activeNoticeAfterMs" defaultValue={240000} min={1} unit="ms" />
          <PluginOptionalNumberField {...runtimeFields} path={['control', 'activeNoticeAfterTurns']} label="control.activeNoticeAfterTurns" emptyLabel={pluginDefault} min={1} fallbackValue={1} />
          <PluginOptionalNumberField {...runtimeFields} path={['control', 'activeNoticeAfterTokens']} label="control.activeNoticeAfterTokens" emptyLabel={pluginDefault} min={1} fallbackValue={1} />
          <PluginNumberField {...runtimeFields} path={['control', 'failedToolAttemptsBeforeAttention']} label="control.failedToolAttemptsBeforeAttention" defaultValue={3} min={1} />
          <PluginStringListField
            {...runtimeFields}
            path={['control', 'notifyOn']}
            label="control.notifyOn"
            placeholder={'active_long_running\nneeds_attention'}
            defaultValue={['active_long_running', 'needs_attention']}
            emptyArrayOnClear
          />
          <PluginStringListField
            {...runtimeFields}
            path={['control', 'notifyChannels']}
            label="control.notifyChannels"
            placeholder={'event\nasync\nintercom'}
            defaultValue={['event', 'async', 'intercom']}
            emptyArrayOnClear
          />
        </SettingsControlGroup>

        <SettingsControlGroup
          className={SUBGROUP_CLASS}
          title={t('settings.piarium.pluginSettings.subagents.runtime.proactiveSkills')}
          description={t('settings.piarium.pluginSettings.subagents.runtime.proactiveSkillsDescription')}
          contentClassName="space-y-4"
        >
          <PluginOptionalBooleanField {...proactiveFields} path={['proactiveSkillSubagents', 'enabled']} label="proactiveSkillSubagents.enabled" />
          <PluginNumberField {...proactiveFields} path={['proactiveSkillSubagents', 'minReferences']} label="proactiveSkillSubagents.minReferences" defaultValue={2} min={1} />
          <PluginNumberField {...proactiveFields} path={['proactiveSkillSubagents', 'maxRecommendations']} label="proactiveSkillSubagents.maxRecommendations" defaultValue={3} min={1} max={5} />
          <PluginStringField {...proactiveFields} path={['proactiveSkillSubagents', 'preferredAgent']} label="proactiveSkillSubagents.preferredAgent" defaultValue="reviewer" placeholder="reviewer" />
        </SettingsControlGroup>

        <SettingsControlGroup
          className={SUBGROUP_CLASS}
          title={t('settings.piarium.pluginSettings.subagents.runtime.budgets')}
          contentClassName="space-y-4"
        >
          <PluginOptionalNumberField {...runtimeFields} path={['turnBudget', 'maxTurns']} label="turnBudget.maxTurns" emptyLabel={pluginDefault} min={1} fallbackValue={1} />
          <PluginNumberField {...runtimeFields} path={['turnBudget', 'graceTurns']} label="turnBudget.graceTurns" defaultValue={1} min={0} />
          <PluginOptionalNumberField {...runtimeFields} path={['toolBudget', 'soft']} label="toolBudget.soft" emptyLabel={pluginDefault} min={1} fallbackValue={1} />
          <PluginOptionalNumberField {...runtimeFields} path={['toolBudget', 'hard']} label="toolBudget.hard" emptyLabel={pluginDefault} min={1} fallbackValue={1} />
          <PluginOptionalNumberField {...runtimeFields} path={['usageBudget', 'tokens', 'soft']} label="usageBudget.tokens.soft" emptyLabel={pluginDefault} min={1} fallbackValue={1} />
          <PluginOptionalNumberField {...runtimeFields} path={['usageBudget', 'tokens', 'hard']} label="usageBudget.tokens.hard" emptyLabel={pluginDefault} min={1} fallbackValue={1} />
          <PluginOptionalNumberField {...runtimeFields} path={['usageBudget', 'costUsd', 'soft']} label="usageBudget.costUsd.soft" emptyLabel={pluginDefault} min={0.000001} step={0.000001} fallbackValue={0.01} unit="USD" />
          <PluginOptionalNumberField {...runtimeFields} path={['usageBudget', 'costUsd', 'hard']} label="usageBudget.costUsd.hard" emptyLabel={pluginDefault} min={0.000001} step={0.000001} fallbackValue={0.01} unit="USD" />
        </SettingsControlGroup>

        <PluginDraftFooter
          controller={runtime}
          blocked={runtimeIssue !== null}
          blockedMessage={runtimeIssue ? issueMessage(runtimeIssue) : undefined}
        />
      </div>
      ) : null}
    </div>
  );
};
