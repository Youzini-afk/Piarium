import React from 'react';
import type { JsonValue, RuntimeContextTarget } from '@piarium/protocol';
import { SettingsControlGroup } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import {
  PluginOptionalBooleanField,
  PluginOptionalNumberField,
  PluginOptionalSelectField,
  PluginStringField,
} from './PluginConfigFields';
import { PluginAdvancedDraftEditor } from './PluginAdvancedDraftEditor';
import {
  PluginConfigSource,
  PluginDraftFooter,
  PluginRuntimeNote,
} from './PluginSettingsPanelShared';
import {
  HERMES_MEMORY_MODES,
  HERMES_OVERFLOW_STRATEGIES,
  HERMES_POLICY_STYLES,
  HERMES_REVIEW_TRANSPORTS,
  HERMES_SESSION_SEARCH_VARIANTS,
  HERMES_THINKING_LEVELS,
  hermesAgentRootFromAuthorityPath,
  hermesMemoryDraftIssues,
  type HermesMemoryDraftIssue,
} from './hermes-memory-config-model';
import { HermesMemoryRuntimePanel } from './HermesMemoryRuntimePanel';
import { useTextObjectDraft, type PluginObjectDraft } from './usePluginConfigDraft';

interface HermesMemorySettingsProps {
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
}

interface HermesMemoryFields {
  disabled: boolean;
  draft: Record<string, JsonValue>;
  onRemove: PluginObjectDraft['removeValue'];
  onSet: PluginObjectDraft['setValue'];
}

const GROUP_CLASS = 'border-t border-border/60 pt-5';

const fieldProps = (
  controller: PluginObjectDraft,
  validationBlocked: boolean,
): HermesMemoryFields => ({
  disabled: !controller.loaded
    || controller.loading
    || controller.saving
    || controller.rawError !== null
    || validationBlocked,
  draft: controller.draft,
  onRemove: controller.removeValue,
  onSet: controller.setValue,
});

const HermesMemoryIssueNote: React.FC<{
  issues: readonly HermesMemoryDraftIssue[];
}> = ({ issues }) => {
  const { t } = useI18n();
  if (issues.length === 0) return null;
  return (
    <div className="space-y-1 rounded-md border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/5 px-3 py-2 typography-meta text-[var(--status-warning)]">
      {issues.map((issue) => (
        <p key={`${issue.code}:${issue.field}`}>
          {issue.code === 'unknown-field'
            ? t('settings.piarium.pluginSettings.hermesMemory.diagnostic.unknownField', { field: issue.field })
            : issue.code === 'modern-overrides-legacy'
              ? t('settings.piarium.pluginSettings.hermesMemory.diagnostic.modernOverridesLegacy')
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

const useOptions = (values: readonly string[]) => {
  const { t } = useI18n();
  return values.map((value) => ({
    value,
    label: t(`settings.piarium.pluginSettings.hermesMemory.value.${value}` as never),
  }));
};

const MemoryPolicySettings: React.FC<{ fields: HermesMemoryFields }> = ({ fields }) => {
  const { t } = useI18n();
  const notSet = t('settings.piarium.pluginSettings.field.notSet');
  const customPolicy = fields.draft.memoryPolicyStyle === 'custom';
  return (
    <SettingsControlGroup
      title={t('settings.piarium.pluginSettings.hermesMemory.section.policy')}
      contentClassName="space-y-4"
    >
      <PluginOptionalSelectField {...fields} path={['memoryMode']} label={t('settings.piarium.pluginSettings.hermesMemory.field.memoryMode')} options={useOptions(HERMES_MEMORY_MODES)} unsetLabel={notSet} />
      <PluginOptionalSelectField {...fields} path={['memoryPolicyStyle']} label={t('settings.piarium.pluginSettings.hermesMemory.field.memoryPolicyStyle')} options={useOptions(HERMES_POLICY_STYLES)} unsetLabel={notSet} />
      {customPolicy ? (
        <PluginRuntimeNote>{t('settings.piarium.pluginSettings.hermesMemory.customPolicyAdvanced')}</PluginRuntimeNote>
      ) : null}
      <PluginOptionalBooleanField {...fields} path={['standingInstructionsEnabled']} label={t('settings.piarium.pluginSettings.hermesMemory.field.standingInstructionsEnabled')} unsetLabel={notSet} />
      <PluginOptionalNumberField {...fields} path={['memoryCharLimit']} label={t('settings.piarium.pluginSettings.hermesMemory.field.memoryCharLimit')} preserveTypedPrecision unsetLabel={notSet} />
      <PluginOptionalNumberField {...fields} path={['userCharLimit']} label={t('settings.piarium.pluginSettings.hermesMemory.field.userCharLimit')} preserveTypedPrecision unsetLabel={notSet} />
      <PluginOptionalNumberField {...fields} path={['projectCharLimit']} label={t('settings.piarium.pluginSettings.hermesMemory.field.projectCharLimit')} preserveTypedPrecision unsetLabel={notSet} />
      <PluginStringField
        {...fields}
        path={['projectsMemoryDir']}
        label={t('settings.piarium.pluginSettings.hermesMemory.field.projectsMemoryDir')}
        info={t('settings.piarium.pluginSettings.hermesMemory.field.projectsMemoryDirInfo')}
      />
    </SettingsControlGroup>
  );
};

const ReviewSettings: React.FC<{ fields: HermesMemoryFields }> = ({ fields }) => {
  const { t } = useI18n();
  const notSet = t('settings.piarium.pluginSettings.field.notSet');
  return (
    <SettingsControlGroup className={GROUP_CLASS} title={t('settings.piarium.pluginSettings.hermesMemory.section.review')} contentClassName="space-y-4">
      <PluginOptionalBooleanField {...fields} path={['reviewEnabled']} label={t('settings.piarium.pluginSettings.hermesMemory.field.reviewEnabled')} unsetLabel={notSet} />
      <PluginOptionalSelectField {...fields} path={['reviewTransport']} label={t('settings.piarium.pluginSettings.hermesMemory.field.reviewTransport')} options={useOptions(HERMES_REVIEW_TRANSPORTS)} unsetLabel={notSet} />
      <PluginOptionalNumberField {...fields} path={['nudgeInterval']} label={t('settings.piarium.pluginSettings.hermesMemory.field.nudgeInterval')} preserveTypedPrecision unsetLabel={notSet} />
      <PluginOptionalNumberField {...fields} path={['nudgeToolCalls']} label={t('settings.piarium.pluginSettings.hermesMemory.field.nudgeToolCalls')} preserveTypedPrecision unsetLabel={notSet} />
      <PluginOptionalNumberField {...fields} path={['reviewRecentMessages']} label={t('settings.piarium.pluginSettings.hermesMemory.field.reviewRecentMessages')} min={0} preserveTypedPrecision unsetLabel={notSet} />
    </SettingsControlGroup>
  );
};

const FlushSettings: React.FC<{ fields: HermesMemoryFields }> = ({ fields }) => {
  const { t } = useI18n();
  const notSet = t('settings.piarium.pluginSettings.field.notSet');
  return (
    <SettingsControlGroup className={GROUP_CLASS} title={t('settings.piarium.pluginSettings.hermesMemory.section.flush')} contentClassName="space-y-4">
      <PluginOptionalBooleanField {...fields} path={['flushOnCompact']} label={t('settings.piarium.pluginSettings.hermesMemory.field.flushOnCompact')} unsetLabel={notSet} />
      <PluginOptionalBooleanField {...fields} path={['flushOnShutdown']} label={t('settings.piarium.pluginSettings.hermesMemory.field.flushOnShutdown')} unsetLabel={notSet} />
      <PluginOptionalNumberField {...fields} path={['flushMinTurns']} label={t('settings.piarium.pluginSettings.hermesMemory.field.flushMinTurns')} preserveTypedPrecision unsetLabel={notSet} />
      <PluginOptionalNumberField {...fields} path={['flushRecentMessages']} label={t('settings.piarium.pluginSettings.hermesMemory.field.flushRecentMessages')} min={0} preserveTypedPrecision unsetLabel={notSet} />
    </SettingsControlGroup>
  );
};

const CapacitySettings: React.FC<{ fields: HermesMemoryFields }> = ({ fields }) => {
  const { t } = useI18n();
  const notSet = t('settings.piarium.pluginSettings.field.notSet');
  return (
    <SettingsControlGroup className={GROUP_CLASS} title={t('settings.piarium.pluginSettings.hermesMemory.section.capacity')} contentClassName="space-y-4">
      <PluginOptionalSelectField {...fields} path={['memoryOverflowStrategy']} label={t('settings.piarium.pluginSettings.hermesMemory.field.memoryOverflowStrategy')} options={useOptions(HERMES_OVERFLOW_STRATEGIES)} unsetLabel={notSet} />
      <PluginOptionalNumberField {...fields} path={['overflowGraceMs']} label={t('settings.piarium.pluginSettings.hermesMemory.field.overflowGraceMs')} min={0} preserveTypedPrecision unit="ms" unsetLabel={notSet} />
      <PluginOptionalNumberField {...fields} path={['consolidationTimeoutMs']} label={t('settings.piarium.pluginSettings.hermesMemory.field.consolidationTimeoutMs')} preserveTypedPrecision unit="ms" unsetLabel={notSet} />
      <PluginOptionalBooleanField {...fields} path={['autoConsolidationWarnOnFailure']} label={t('settings.piarium.pluginSettings.hermesMemory.field.autoConsolidationWarnOnFailure')} unsetLabel={notSet} />
    </SettingsControlGroup>
  );
};

const RecallSettings: React.FC<{ fields: HermesMemoryFields }> = ({ fields }) => {
  const { t } = useI18n();
  const notSet = t('settings.piarium.pluginSettings.field.notSet');
  return (
    <SettingsControlGroup className={GROUP_CLASS} title={t('settings.piarium.pluginSettings.hermesMemory.section.recall')} contentClassName="space-y-4">
      <PluginOptionalBooleanField {...fields} path={['correctionDetection']} label={t('settings.piarium.pluginSettings.hermesMemory.field.correctionDetection')} unsetLabel={notSet} />
      <PluginOptionalBooleanField {...fields} path={['failureInjectionEnabled']} label={t('settings.piarium.pluginSettings.hermesMemory.field.failureInjectionEnabled')} unsetLabel={notSet} />
      <PluginOptionalNumberField {...fields} path={['failureInjectionMaxAgeDays']} label={t('settings.piarium.pluginSettings.hermesMemory.field.failureInjectionMaxAgeDays')} preserveTypedPrecision unsetLabel={notSet} />
      <PluginOptionalNumberField {...fields} path={['failureInjectionMaxEntries']} label={t('settings.piarium.pluginSettings.hermesMemory.field.failureInjectionMaxEntries')} preserveTypedPrecision unsetLabel={notSet} />
      <PluginOptionalSelectField {...fields} path={['sessionSearch', 'variant']} label={t('settings.piarium.pluginSettings.hermesMemory.field.sessionSearchVariant')} options={useOptions(HERMES_SESSION_SEARCH_VARIANTS)} unsetLabel={notSet} />
      <PluginStringField {...fields} path={['llmModelOverride']} label={t('settings.piarium.pluginSettings.hermesMemory.field.llmModelOverride')} />
      <PluginOptionalSelectField {...fields} path={['llmThinkingOverride']} label={t('settings.piarium.pluginSettings.hermesMemory.field.llmThinkingOverride')} options={useOptions(HERMES_THINKING_LEVELS)} unsetLabel={notSet} />
    </SettingsControlGroup>
  );
};

export const HermesMemorySettings: React.FC<HermesMemorySettingsProps> = ({
  runtimeTarget,
  targetKey,
}) => {
  const { t } = useI18n();
  const controller = useTextObjectDraft({
    authority: 'hermes-memory-user',
    format: 'json',
    runtimeTarget,
    targetKey,
  });
  const agentRoot = React.useMemo(
    () => hermesAgentRootFromAuthorityPath(controller.path),
    [controller.path],
  );
  const issues = React.useMemo(
    () => hermesMemoryDraftIssues(controller.draft, { agentRoot }),
    [agentRoot, controller.draft],
  );
  const validationBlocked = issues.some((issue) => issue.blocking);
  const fields = fieldProps(controller, validationBlocked);

  return (
    <div className="space-y-7">
      <PluginConfigSource controller={controller} />
      <PluginRuntimeNote>{t('settings.piarium.pluginSettings.hermesMemory.authority')}</PluginRuntimeNote>
      <HermesMemoryIssueNote issues={issues} />
      <MemoryPolicySettings fields={fields} />
      <ReviewSettings fields={fields} />
      <FlushSettings fields={fields} />
      <CapacitySettings fields={fields} />
      <RecallSettings fields={fields} />
      <PluginAdvancedDraftEditor controller={controller} />
      <PluginDraftFooter
        controller={controller}
        blocked={validationBlocked}
        blockedMessage={validationBlocked
          ? t('settings.piarium.pluginSettings.hermesMemory.validation.fixBeforeSave')
          : undefined}
      />
      <HermesMemoryRuntimePanel runtimeTarget={runtimeTarget} targetKey={targetKey} />
    </div>
  );
};
