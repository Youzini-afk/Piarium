import React from 'react';
import type { JsonValue, RuntimeContextTarget } from '@piarium/protocol';
import { SettingsControlGroup } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import {
  PluginOptionalBooleanField,
  PluginOptionalNumberField,
  PluginOptionalSelectField,
} from './PluginConfigFields';
import { PluginAdvancedDraftEditor } from './PluginAdvancedDraftEditor';
import {
  PluginConfigSource,
  PluginDraftFooter,
  PluginRuntimeNote,
} from './PluginSettingsPanelShared';
import {
  RTK_MODES,
  RTK_SOURCE_FILTER_LEVELS,
  rtkDraftIssues,
  type RtkDraftIssue,
} from './rtk-config-model';
import { RtkRuntimePanel } from './RtkRuntimePanel';
import { useTextObjectDraft, type PluginObjectDraft } from './usePluginConfigDraft';

interface RtkSettingsProps {
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
}

interface RtkFields {
  disabled: boolean;
  draft: Record<string, JsonValue>;
  onRemove: PluginObjectDraft['removeValue'];
  onSet: PluginObjectDraft['setValue'];
}

const GROUP_CLASS = 'border-t border-border/60 pt-5';

const fieldProps = (
  controller: PluginObjectDraft,
  validationBlocked: boolean,
): RtkFields => ({
  disabled: !controller.loaded
    || controller.loading
    || controller.saving
    || controller.rawError !== null
    || validationBlocked,
  draft: controller.draft,
  onRemove: controller.removeValue,
  onSet: controller.setValue,
});

const RtkIssueNote: React.FC<{ issues: readonly RtkDraftIssue[] }> = ({ issues }) => {
  const { t } = useI18n();
  if (issues.length === 0) return null;
  const blocking = issues.some((issue) => issue.blocking);
  return (
    <div className={blocking
      ? 'space-y-1 rounded-md border border-[var(--status-error)]/30 bg-[var(--status-error)]/5 px-3 py-2 typography-meta text-[var(--status-error)]'
      : 'space-y-1 rounded-md border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/5 px-3 py-2 typography-meta text-[var(--status-warning)]'}
    >
      {issues.map((issue) => (
        <p key={`${issue.code}:${issue.field}`}>
          {issue.code === 'unknown-field'
            ? t('settings.piarium.pluginSettings.rtk.diagnostic.unknownField', { field: issue.field })
            : issue.code === 'invalid-boolean'
              ? t('settings.piarium.pluginSettings.validation.invalidBoolean', { field: issue.field })
              : issue.code === 'invalid-number'
                ? t('settings.piarium.pluginSettings.validation.invalidNumber', { field: issue.field })
                : t('settings.piarium.pluginSettings.validation.invalidValue', { field: issue.field })}
        </p>
      ))}
    </div>
  );
};

const useRtkOptions = (values: readonly string[]) => {
  const { t } = useI18n();
  return values.map((value) => ({
    value,
    label: t(`settings.piarium.pluginSettings.rtk.value.${value}` as never),
  }));
};

const GeneralSettings: React.FC<{ fields: RtkFields }> = ({ fields }) => {
  const { t } = useI18n();
  const notSet = t('settings.piarium.pluginSettings.field.notSet');
  return (
    <SettingsControlGroup
      title={t('settings.piarium.pluginSettings.rtk.section.general')}
      contentClassName="space-y-4"
    >
      <PluginOptionalBooleanField {...fields} path={['enabled']} label={t('settings.piarium.pluginSettings.rtk.field.enabled')} unsetLabel={notSet} />
      <PluginOptionalSelectField {...fields} path={['mode']} label={t('settings.piarium.pluginSettings.rtk.field.mode')} options={useRtkOptions(RTK_MODES)} unsetLabel={notSet} />
      <PluginOptionalBooleanField {...fields} path={['guardWhenRtkMissing']} label={t('settings.piarium.pluginSettings.rtk.field.guardWhenRtkMissing')} unsetLabel={notSet} />
      <PluginOptionalBooleanField {...fields} path={['showRewriteNotifications']} label={t('settings.piarium.pluginSettings.rtk.field.showRewriteNotifications')} unsetLabel={notSet} />
    </SettingsControlGroup>
  );
};

const OutputSettings: React.FC<{ fields: RtkFields }> = ({ fields }) => {
  const { t } = useI18n();
  const notSet = t('settings.piarium.pluginSettings.field.notSet');
  return (
    <SettingsControlGroup className={GROUP_CLASS} title={t('settings.piarium.pluginSettings.rtk.section.output')} contentClassName="space-y-4">
      <PluginOptionalBooleanField {...fields} path={['outputCompaction', 'enabled']} label={t('settings.piarium.pluginSettings.rtk.field.outputEnabled')} unsetLabel={notSet} />
      <PluginOptionalBooleanField {...fields} path={['outputCompaction', 'stripAnsi']} label={t('settings.piarium.pluginSettings.rtk.field.stripAnsi')} unsetLabel={notSet} />
      <PluginOptionalBooleanField {...fields} path={['outputCompaction', 'aggregateTestOutput']} label={t('settings.piarium.pluginSettings.rtk.field.aggregateTestOutput')} unsetLabel={notSet} />
      <PluginOptionalBooleanField {...fields} path={['outputCompaction', 'filterBuildOutput']} label={t('settings.piarium.pluginSettings.rtk.field.filterBuildOutput')} unsetLabel={notSet} />
      <PluginOptionalBooleanField {...fields} path={['outputCompaction', 'compactGitOutput']} label={t('settings.piarium.pluginSettings.rtk.field.compactGitOutput')} unsetLabel={notSet} />
      <PluginOptionalBooleanField {...fields} path={['outputCompaction', 'aggregateLinterOutput']} label={t('settings.piarium.pluginSettings.rtk.field.aggregateLinterOutput')} unsetLabel={notSet} />
      <PluginOptionalBooleanField {...fields} path={['outputCompaction', 'groupSearchOutput']} label={t('settings.piarium.pluginSettings.rtk.field.groupSearchOutput')} unsetLabel={notSet} />
      <PluginOptionalBooleanField {...fields} path={['outputCompaction', 'trackSavings']} label={t('settings.piarium.pluginSettings.rtk.field.trackSavings')} unsetLabel={notSet} />
    </SettingsControlGroup>
  );
};

const ReadSettings: React.FC<{ fields: RtkFields }> = ({ fields }) => {
  const { t } = useI18n();
  const notSet = t('settings.piarium.pluginSettings.field.notSet');
  return (
    <SettingsControlGroup className={GROUP_CLASS} title={t('settings.piarium.pluginSettings.rtk.section.read')} contentClassName="space-y-4">
      <PluginOptionalBooleanField {...fields} path={['outputCompaction', 'readCompaction', 'enabled']} label={t('settings.piarium.pluginSettings.rtk.field.readCompactionEnabled')} unsetLabel={notSet} />
      <PluginOptionalBooleanField {...fields} path={['outputCompaction', 'sourceCodeFilteringEnabled']} label={t('settings.piarium.pluginSettings.rtk.field.sourceCodeFilteringEnabled')} unsetLabel={notSet} />
      <PluginOptionalSelectField {...fields} path={['outputCompaction', 'sourceCodeFiltering']} label={t('settings.piarium.pluginSettings.rtk.field.sourceCodeFiltering')} options={useRtkOptions(RTK_SOURCE_FILTER_LEVELS)} unsetLabel={notSet} />
      <PluginOptionalBooleanField {...fields} path={['outputCompaction', 'preserveExactSkillReads']} label={t('settings.piarium.pluginSettings.rtk.field.preserveExactSkillReads')} unsetLabel={notSet} />
    </SettingsControlGroup>
  );
};

const TruncationSettings: React.FC<{ fields: RtkFields }> = ({ fields }) => {
  const { t } = useI18n();
  const notSet = t('settings.piarium.pluginSettings.field.notSet');
  return (
    <SettingsControlGroup className={GROUP_CLASS} title={t('settings.piarium.pluginSettings.rtk.section.truncation')} contentClassName="space-y-4">
      <PluginOptionalBooleanField {...fields} path={['outputCompaction', 'smartTruncate', 'enabled']} label={t('settings.piarium.pluginSettings.rtk.field.smartTruncateEnabled')} unsetLabel={notSet} />
      <PluginOptionalNumberField {...fields} path={['outputCompaction', 'smartTruncate', 'maxLines']} label={t('settings.piarium.pluginSettings.rtk.field.smartTruncateMaxLines')} min={40} max={4_000} step={1} unsetLabel={notSet} />
      <PluginOptionalBooleanField {...fields} path={['outputCompaction', 'truncate', 'enabled']} label={t('settings.piarium.pluginSettings.rtk.field.truncateEnabled')} unsetLabel={notSet} />
      <PluginOptionalNumberField {...fields} path={['outputCompaction', 'truncate', 'maxChars']} label={t('settings.piarium.pluginSettings.rtk.field.truncateMaxChars')} min={1_000} max={200_000} step={1} unsetLabel={notSet} />
    </SettingsControlGroup>
  );
};

export const RtkSettings: React.FC<RtkSettingsProps> = ({ runtimeTarget, targetKey }) => {
  const { t } = useI18n();
  const controller = useTextObjectDraft({
    format: 'json',
    paths: ['extensions/pi-rtk-optimizer/config.json'],
    root: 'agent',
    runtimeTarget,
    targetKey,
  });
  const issues = React.useMemo(() => rtkDraftIssues(controller.draft), [controller.draft]);
  const validationBlocked = issues.some((issue) => issue.blocking);
  const fields = fieldProps(controller, validationBlocked);

  return (
    <div className="space-y-7">
      <PluginConfigSource controller={controller} />
      <PluginRuntimeNote>{t('settings.piarium.pluginSettings.rtk.authority')}</PluginRuntimeNote>
      <RtkIssueNote issues={issues} />
      <GeneralSettings fields={fields} />
      <OutputSettings fields={fields} />
      <ReadSettings fields={fields} />
      <TruncationSettings fields={fields} />
      <PluginAdvancedDraftEditor controller={controller} />
      <PluginDraftFooter
        controller={controller}
        blocked={validationBlocked}
        blockedMessage={validationBlocked
          ? t('settings.piarium.pluginSettings.rtk.validation.fixBeforeSave')
          : undefined}
      />
      <RtkRuntimePanel runtimeTarget={runtimeTarget} targetKey={targetKey} />
    </div>
  );
};
