import React from 'react';
import type { JsonValue, PiConfigScope, RuntimeContextTarget } from '@varin/protocol';
import {
  SettingsControlGroup,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import {
  PluginOptionalBooleanField,
  PluginOptionalNumberField,
  PluginOptionalSelectField,
  PluginStringListField,
} from './PluginConfigFields';
import { PluginAdvancedDraftEditor } from './PluginAdvancedDraftEditor';
import {
  PluginConfigSource,
  PluginDraftFooter,
  PluginRuntimeNote,
  ScopeSelector,
} from './PluginSettingsPanelShared';
import {
  PI_LENS_TRIVY_SEVERITIES,
  piLensDraftIssues,
  type PiLensDraftIssue,
} from './pi-lens-config-model';
import { useTextObjectDraft, type PluginObjectDraft } from './usePluginConfigDraft';
import { PiLensRuntimePanel } from './PiLensRuntimePanel';

interface PiLensSettingsProps {
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
}

interface PiLensFields {
  disabled: boolean;
  draft: Record<string, JsonValue>;
  onRemove: PluginObjectDraft['removeValue'];
  onSet: PluginObjectDraft['setValue'];
}

const GROUP_CLASS = 'border-t border-border/60 pt-5';

const fieldLabelKey = (field: string): string => {
  const labels: Record<string, string> = {
    'lens.enabled': 'settings.varin.pluginSettings.piLens.field.lens',
    'lsp.enabled': 'settings.varin.pluginSettings.piLens.field.lsp',
    'tests.enabled': 'settings.varin.pluginSettings.piLens.field.tests',
    'delta.enabled': 'settings.varin.pluginSettings.piLens.field.delta',
    'opengrep.enabled': 'settings.varin.pluginSettings.piLens.field.opengrep',
    'readGuard.enabled': 'settings.varin.pluginSettings.piLens.field.readGuard',
    'turnEnd.madge.enabled': 'settings.varin.pluginSettings.piLens.field.turnEndMadge',
    'format.enabled': 'settings.varin.pluginSettings.piLens.field.format',
    'format.mode': 'settings.varin.pluginSettings.piLens.field.formatMode',
    'autofix.enabled': 'settings.varin.pluginSettings.piLens.field.autofix',
    'contextInjection.enabled': 'settings.varin.pluginSettings.piLens.field.contextInjection',
    'turnSummary.enabled': 'settings.varin.pluginSettings.piLens.field.turnSummary',
    'actionableWarnings.enabled': 'settings.varin.pluginSettings.piLens.field.actionableWarnings',
    'actionableWarnings.includeLspCodeActions': 'settings.varin.pluginSettings.piLens.field.includeLspCodeActions',
    'actionableWarnings.deltaOnly': 'settings.varin.pluginSettings.piLens.field.deltaOnly',
    'actionableWarnings.autoFix.enabled': 'settings.varin.pluginSettings.piLens.field.actionableAutoFix',
    'actionableWarnings.autoFix.maxFixes': 'settings.varin.pluginSettings.piLens.field.maxFixes',
    'tools.lazy': 'settings.varin.pluginSettings.piLens.field.lazyTools',
    'ui.compactToolLine': 'settings.varin.pluginSettings.piLens.field.compactToolLine',
    'widget.visible': 'settings.varin.pluginSettings.piLens.field.widget',
    'guard.enabled': 'settings.varin.pluginSettings.piLens.field.guard',
    'dispatch.runnerTimeoutFloorMs': 'settings.varin.pluginSettings.piLens.field.runnerTimeoutFloor',
    ignore: 'settings.varin.pluginSettings.piLens.field.ignore',
    maxProjectFiles: 'settings.varin.pluginSettings.piLens.field.maxProjectFiles',
    'reviewGraph.maxFiles': 'settings.varin.pluginSettings.piLens.field.reviewGraphMaxFiles',
    'rules.high-complexity.threshold': 'settings.varin.pluginSettings.piLens.field.complexityThreshold',
    'rules.high-fan-out.threshold': 'settings.varin.pluginSettings.piLens.field.fanOutThreshold',
    'trivy.enabled': 'settings.varin.pluginSettings.piLens.field.trivyEnabled',
    'trivy.minSeverity': 'settings.varin.pluginSettings.piLens.field.trivyMinSeverity',
    'helm.renderValidation.enabled': 'settings.varin.pluginSettings.piLens.field.helmRenderValidation',
  };
  return labels[field] ?? field;
};

const PiLensIssueNote: React.FC<{
  issues: readonly PiLensDraftIssue[];
}> = ({ issues }) => {
  const { t } = useI18n();
  if (issues.length === 0) return null;
  return (
    <div className="space-y-1 rounded-md border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/5 px-3 py-2 typography-meta text-[var(--status-warning)]">
      {issues.map((issue) => {
        const field = t(fieldLabelKey(issue.field) as never);
        const message = issue.code === 'project-global-only'
          ? t('settings.varin.pluginSettings.piLens.validation.projectGlobalOnly', { field })
          : issue.code === 'invalid-number'
            ? t('settings.varin.pluginSettings.validation.invalidNumber', { field })
            : issue.code === 'invalid-boolean'
              ? t('settings.varin.pluginSettings.validation.invalidBoolean', { field })
              : t('settings.varin.pluginSettings.validation.invalidValue', { field });
        return <p key={`${issue.code}:${issue.field}`}>{message}</p>;
      })}
    </div>
  );
};

const fieldProps = (controller: PluginObjectDraft, trustBlocked: boolean): PiLensFields => ({
  disabled: !controller.loaded
    || controller.loading
    || controller.saving
    || controller.rawError !== null
    || trustBlocked,
  draft: controller.draft,
  onRemove: controller.removeValue,
  onSet: controller.setValue,
});

const GlobalQuickSettings: React.FC<{ fields: PiLensFields }> = ({ fields }) => {
  const { t } = useI18n();
  const notSet = t('settings.varin.pluginSettings.field.notSet');
  const options = (values: readonly string[]) => values.map((value) => ({
    value,
    label: t(`settings.varin.pluginSettings.piLens.value.${value}` as never),
  }));
  return (
    <div className="space-y-7">
      <SettingsControlGroup
        title={t('settings.varin.pluginSettings.piLens.section.diagnostics')}
        contentClassName="space-y-4"
      >
        <PluginOptionalBooleanField {...fields} path={['lens', 'enabled']} label={t('settings.varin.pluginSettings.piLens.field.lens')} unsetLabel={notSet} />
        <PluginOptionalBooleanField {...fields} path={['lsp', 'enabled']} label={t('settings.varin.pluginSettings.piLens.field.lsp')} unsetLabel={notSet} />
        <PluginOptionalBooleanField {...fields} path={['tests', 'enabled']} label={t('settings.varin.pluginSettings.piLens.field.tests')} unsetLabel={notSet} />
        <PluginOptionalBooleanField {...fields} path={['delta', 'enabled']} label={t('settings.varin.pluginSettings.piLens.field.delta')} unsetLabel={notSet} />
        <PluginOptionalBooleanField {...fields} path={['opengrep', 'enabled']} label={t('settings.varin.pluginSettings.piLens.field.opengrep')} unsetLabel={notSet} />
        <PluginOptionalBooleanField {...fields} path={['readGuard', 'enabled']} label={t('settings.varin.pluginSettings.piLens.field.readGuard')} unsetLabel={notSet} />
        <PluginOptionalBooleanField {...fields} path={['turnEnd', 'madge', 'enabled']} label={t('settings.varin.pluginSettings.piLens.field.turnEndMadge')} unsetLabel={notSet} />
      </SettingsControlGroup>

      <SettingsControlGroup className={GROUP_CLASS} title={t('settings.varin.pluginSettings.piLens.section.mutations')} contentClassName="space-y-4">
        <PluginOptionalBooleanField {...fields} path={['format', 'enabled']} label={t('settings.varin.pluginSettings.piLens.field.format')} unsetLabel={notSet} />
        <PluginOptionalSelectField {...fields} path={['format', 'mode']} label={t('settings.varin.pluginSettings.piLens.field.formatMode')} options={options(['deferred', 'immediate'])} unsetLabel={notSet} />
        <PluginOptionalBooleanField {...fields} path={['autofix', 'enabled']} label={t('settings.varin.pluginSettings.piLens.field.autofix')} unsetLabel={notSet} />
      </SettingsControlGroup>

      <SettingsControlGroup className={GROUP_CLASS} title={t('settings.varin.pluginSettings.piLens.section.context')} contentClassName="space-y-4">
        <PluginOptionalBooleanField {...fields} path={['contextInjection', 'enabled']} label={t('settings.varin.pluginSettings.piLens.field.contextInjection')} unsetLabel={notSet} />
        <PluginOptionalBooleanField {...fields} path={['turnSummary', 'enabled']} label={t('settings.varin.pluginSettings.piLens.field.turnSummary')} unsetLabel={notSet} />
        <PluginOptionalBooleanField {...fields} path={['actionableWarnings', 'enabled']} label={t('settings.varin.pluginSettings.piLens.field.actionableWarnings')} unsetLabel={notSet} />
        <PluginOptionalBooleanField {...fields} path={['actionableWarnings', 'includeLspCodeActions']} label={t('settings.varin.pluginSettings.piLens.field.includeLspCodeActions')} unsetLabel={notSet} />
        <PluginOptionalBooleanField {...fields} path={['actionableWarnings', 'deltaOnly']} label={t('settings.varin.pluginSettings.piLens.field.deltaOnly')} unsetLabel={notSet} />
        <PluginOptionalBooleanField {...fields} path={['actionableWarnings', 'autoFix', 'enabled']} label={t('settings.varin.pluginSettings.piLens.field.actionableAutoFix')} unsetLabel={notSet} />
        <PluginOptionalNumberField {...fields} path={['actionableWarnings', 'autoFix', 'maxFixes']} label={t('settings.varin.pluginSettings.piLens.field.maxFixes')} min={0} step={1} unsetLabel={notSet} />
      </SettingsControlGroup>

      <SettingsControlGroup className={GROUP_CLASS} title={t('settings.varin.pluginSettings.piLens.section.interface')} contentClassName="space-y-4">
        <PluginOptionalBooleanField {...fields} path={['tools', 'lazy']} label={t('settings.varin.pluginSettings.piLens.field.lazyTools')} unsetLabel={notSet} />
        <PluginOptionalBooleanField {...fields} path={['ui', 'compactToolLine']} label={t('settings.varin.pluginSettings.piLens.field.compactToolLine')} unsetLabel={notSet} />
        <PluginOptionalBooleanField {...fields} path={['widget', 'visible']} label={t('settings.varin.pluginSettings.piLens.field.widget')} unsetLabel={notSet} />
        <PluginOptionalBooleanField {...fields} path={['guard', 'enabled']} label={t('settings.varin.pluginSettings.piLens.field.guard')} unsetLabel={notSet} />
      </SettingsControlGroup>

      <SettingsControlGroup className={GROUP_CLASS} title={t('settings.varin.pluginSettings.piLens.section.scan')} contentClassName="space-y-4">
        <PluginStringListField {...fields} path={['ignore']} label={t('settings.varin.pluginSettings.piLens.field.ignore')} placeholder="**/*.generated.ts" />
        <PluginOptionalNumberField {...fields} path={['dispatch', 'runnerTimeoutFloorMs']} label={t('settings.varin.pluginSettings.piLens.field.runnerTimeoutFloor')} min={1} step={1} unit="ms" unsetLabel={notSet} />
      </SettingsControlGroup>
    </div>
  );
};

const ProjectQuickSettings: React.FC<{ fields: PiLensFields }> = ({ fields }) => {
  const { t } = useI18n();
  const notSet = t('settings.varin.pluginSettings.field.notSet');
  return (
    <div className="space-y-7">
      <SettingsControlGroup title={t('settings.varin.pluginSettings.piLens.section.mutations')} contentClassName="space-y-4">
        <PluginOptionalBooleanField {...fields} path={['format', 'enabled']} label={t('settings.varin.pluginSettings.piLens.field.format')} unsetLabel={notSet} />
        <PluginOptionalBooleanField {...fields} path={['autofix', 'enabled']} label={t('settings.varin.pluginSettings.piLens.field.autofix')} unsetLabel={notSet} />
        <PluginOptionalBooleanField {...fields} path={['actionableWarnings', 'autoFix', 'enabled']} label={t('settings.varin.pluginSettings.piLens.field.actionableAutoFix')} unsetLabel={notSet} />
      </SettingsControlGroup>

      <SettingsControlGroup className={GROUP_CLASS} title={t('settings.varin.pluginSettings.piLens.section.projectScale')} contentClassName="space-y-4">
        <PluginStringListField {...fields} path={['ignore']} label={t('settings.varin.pluginSettings.piLens.field.ignore')} placeholder="**/*.test.ts" />
        <PluginOptionalNumberField {...fields} path={['maxProjectFiles']} label={t('settings.varin.pluginSettings.piLens.field.maxProjectFiles')} min={1} step={1} unsetLabel={notSet} />
        <PluginOptionalNumberField {...fields} path={['reviewGraph', 'maxFiles']} label={t('settings.varin.pluginSettings.piLens.field.reviewGraphMaxFiles')} min={100} max={20000} step={1} unsetLabel={notSet} />
      </SettingsControlGroup>

      <SettingsControlGroup className={GROUP_CLASS} title={t('settings.varin.pluginSettings.piLens.section.rules')} contentClassName="space-y-4">
        <PluginOptionalNumberField {...fields} path={['rules', 'high-complexity', 'threshold']} label={t('settings.varin.pluginSettings.piLens.field.complexityThreshold')} min={1} step={1} unsetLabel={notSet} />
        <PluginOptionalNumberField {...fields} path={['rules', 'high-fan-out', 'threshold']} label={t('settings.varin.pluginSettings.piLens.field.fanOutThreshold')} min={1} step={1} unsetLabel={notSet} />
      </SettingsControlGroup>

      <SettingsControlGroup className={GROUP_CLASS} title={t('settings.varin.pluginSettings.piLens.section.security')} contentClassName="space-y-4">
        <PluginOptionalBooleanField {...fields} path={['trivy', 'enabled']} label={t('settings.varin.pluginSettings.piLens.field.trivyEnabled')} unsetLabel={notSet} />
        <PluginOptionalSelectField {...fields} path={['trivy', 'minSeverity']} label={t('settings.varin.pluginSettings.piLens.field.trivyMinSeverity')} unsetLabel={notSet} options={PI_LENS_TRIVY_SEVERITIES.map((value) => ({
          value,
          label: t(`settings.varin.pluginSettings.piLens.value.${value.toLowerCase()}` as never),
        }))} />
        <PluginOptionalBooleanField {...fields} path={['helm', 'renderValidation', 'enabled']} label={t('settings.varin.pluginSettings.piLens.field.helmRenderValidation')} unsetLabel={notSet} />
      </SettingsControlGroup>
    </div>
  );
};

export const PiLensSettings: React.FC<PiLensSettingsProps> = ({ runtimeTarget, targetKey }) => {
  const { t } = useI18n();
  const [scope, setScope] = React.useState<PiConfigScope>('global');
  const globalController = useTextObjectDraft({
    authority: 'pi-lens-global',
    format: 'json',
    runtimeTarget,
    targetKey: `${targetKey}:global`,
  });
  const projectController = useTextObjectDraft({
    authority: 'pi-lens-project',
    format: 'json',
    runtimeTarget,
    targetKey: `${targetKey}:project`,
  });
  const controller = scope === 'project' ? projectController : globalController;
  const trustBlocked = scope === 'project' && !controller.projectTrusted;
  const issues = React.useMemo(
    () => piLensDraftIssues(controller.draft, scope),
    [controller.draft, scope],
  );
  const fields = fieldProps(controller, trustBlocked);
  const blockingIssue = issues.find((issue) => issue.code !== 'project-global-only');
  const blocked = trustBlocked || blockingIssue !== undefined;
  const issueMessage = React.useCallback((issue: PiLensDraftIssue): string => {
    const field = t(fieldLabelKey(issue.field) as never);
    if (issue.code === 'project-global-only') {
      return t('settings.varin.pluginSettings.piLens.validation.projectGlobalOnly', { field });
    }
    if (issue.code === 'invalid-number') return t('settings.varin.pluginSettings.validation.invalidNumber', { field });
    if (issue.code === 'invalid-boolean') return t('settings.varin.pluginSettings.validation.invalidBoolean', { field });
    return t('settings.varin.pluginSettings.validation.invalidValue', { field });
  }, [t]);

  return (
    <div className="space-y-7">
      <SettingsFieldRow label={t('settings.varin.pluginSettings.scope.label')} info={t('settings.varin.pluginSettings.scope.description')} controlClassName="w-full max-w-[24rem]">
        <ScopeSelector
          value={scope}
          onChange={setScope}
          disabled={globalController.saving || projectController.saving}
        />
      </SettingsFieldRow>
      <PluginConfigSource controller={controller} />
      {scope === 'project' ? (
        <PluginRuntimeNote>{t('settings.varin.pluginSettings.piLens.projectScopeNote')}</PluginRuntimeNote>
      ) : null}
      <PiLensIssueNote issues={issues} />
      {scope === 'global' ? <GlobalQuickSettings fields={fields} /> : <ProjectQuickSettings fields={fields} />}
      <PluginAdvancedDraftEditor controller={controller} blocked={trustBlocked} />
      <PluginDraftFooter
        controller={controller}
        blocked={blocked}
        blockedMessage={trustBlocked
          ? undefined
          : blockingIssue
            ? issueMessage(blockingIssue)
            : undefined}
      />
      <PiLensRuntimePanel runtimeTarget={runtimeTarget} targetKey={targetKey} />
    </div>
  );
};
