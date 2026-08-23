import React from 'react';
import type { PiConfigScope, RuntimeContextTarget } from '@piarium/protocol';
import {
  SettingsControlGroup,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
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
  ScopeSelector,
} from './PluginSettingsPanelShared';
import {
  openAICodexCompatDraftIssue,
  type OpenAICodexCompatDraftIssue,
} from './openai-codex-compat-config-model';
import { useTextObjectDraft } from './usePluginConfigDraft';

interface OpenAICodexCompatSettingsProps {
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
}

const GROUP_CLASS = 'border-t border-border/60 pt-5';
const OPENAI_CODEX_COMPAT_GLOBAL_PATHS = ['openai-codex-compat.json'] as const;
const OPENAI_CODEX_COMPAT_PROJECT_PATHS = ['.pi/openai-codex-compat.json'] as const;

export const OpenAICodexCompatSettings: React.FC<OpenAICodexCompatSettingsProps> = ({
  runtimeTarget,
  targetKey,
}) => {
  const { t } = useI18n();
  const [scope, setScope] = React.useState<PiConfigScope>('global');
  const globalController = useTextObjectDraft({
    format: 'json',
    paths: OPENAI_CODEX_COMPAT_GLOBAL_PATHS,
    root: 'agent',
    runtimeTarget,
    targetKey: `${targetKey}:global`,
  });
  const projectController = useTextObjectDraft({
    format: 'json',
    paths: OPENAI_CODEX_COMPAT_PROJECT_PATHS,
    root: 'project',
    runtimeTarget,
    targetKey: `${targetKey}:project`,
  });
  const controller = scope === 'project' ? projectController : globalController;
  const trustBlocked = scope === 'project' && !controller.projectTrusted;
  const issue = React.useMemo(
    () => openAICodexCompatDraftIssue(controller.draft),
    [controller.draft],
  );
  const disabled = !controller.loaded
    || controller.loading
    || controller.saving
    || controller.rawError !== null
    || trustBlocked;
  const notSet = t('settings.piarium.pluginSettings.field.notSet');
  const fieldProps = {
    disabled,
    draft: controller.draft,
    onRemove: controller.removeValue,
    onSet: controller.setValue,
    unsetLabel: notSet,
  };
  const fieldLabel = React.useCallback((field: string): string => {
    const labels: Record<string, string> = {
      applyPatch: t('settings.piarium.pluginSettings.codexCompat.field.applyPatch'),
      applyPatchDebug: t('settings.piarium.pluginSettings.codexCompat.field.applyPatchDebug'),
      autoCompactAtPercent: t('settings.piarium.pluginSettings.codexCompat.field.autoCompactAtPercent'),
      fastMode: t('settings.piarium.pluginSettings.codexCompat.field.fastMode'),
      imageDetail: t('settings.piarium.pluginSettings.codexCompat.field.imageDetail'),
      imageGeneration: t('settings.piarium.pluginSettings.codexCompat.field.imageGeneration'),
      reasoningMode: t('settings.piarium.pluginSettings.codexCompat.field.reasoningMode'),
      reasoningSummary: t('settings.piarium.pluginSettings.codexCompat.field.reasoningSummary'),
      responsesLite: t('settings.piarium.pluginSettings.codexCompat.field.responsesLite'),
      textVerbosity: t('settings.piarium.pluginSettings.codexCompat.field.textVerbosity'),
      toolBackground: t('settings.piarium.pluginSettings.codexCompat.field.toolBackground'),
      webRun: t('settings.piarium.pluginSettings.codexCompat.field.webRun'),
      webSearch: t('settings.piarium.pluginSettings.codexCompat.field.webSearch'),
    };
    return labels[field] ?? field;
  }, [t]);
  const issueMessage = React.useCallback((value: OpenAICodexCompatDraftIssue): string => {
    const field = fieldLabel(value.field);
    if (value.code === 'invalid-number') {
      return t('settings.piarium.pluginSettings.validation.invalidNumber', { field });
    }
    if (value.code === 'invalid-boolean') {
      return t('settings.piarium.pluginSettings.validation.invalidBoolean', { field });
    }
    return t('settings.piarium.pluginSettings.validation.invalidValue', { field });
  }, [fieldLabel, t]);

  return (
    <div className="space-y-7">
      <SettingsFieldRow
        label={t('settings.piarium.pluginSettings.scope.label')}
        info={t('settings.piarium.pluginSettings.scope.description')}
        controlClassName="w-full max-w-[24rem]"
      >
        <ScopeSelector
          value={scope}
          onChange={setScope}
          disabled={globalController.saving || projectController.saving}
        />
      </SettingsFieldRow>
      <PluginConfigSource controller={controller} />

      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.codexCompat.section.requests')}
        contentClassName="space-y-4"
      >
        <PluginOptionalBooleanField {...fieldProps} path={['fastMode']} label={t('settings.piarium.pluginSettings.codexCompat.field.fastMode')} />
        <PluginOptionalBooleanField {...fieldProps} path={['responsesLite']} label={t('settings.piarium.pluginSettings.codexCompat.field.responsesLite')} />
        <PluginOptionalSelectField {...fieldProps} path={['textVerbosity']} label={t('settings.piarium.pluginSettings.codexCompat.field.textVerbosity')} options={[
          { value: 'low', label: t('settings.piarium.pluginSettings.subagents.thinking.low') },
          { value: 'medium', label: t('settings.piarium.pluginSettings.subagents.thinking.medium') },
          { value: 'high', label: t('settings.piarium.pluginSettings.subagents.thinking.high') },
        ]} />
        <PluginOptionalSelectField {...fieldProps} path={['reasoningSummary']} label={t('settings.piarium.pluginSettings.codexCompat.field.reasoningSummary')} options={[
          { value: 'auto', label: t('settings.piarium.pluginSettings.codexCompat.value.auto') },
          { value: 'concise', label: t('settings.piarium.pluginSettings.codexCompat.value.concise') },
          { value: 'detailed', label: t('settings.piarium.pluginSettings.codexCompat.value.detailed') },
          { value: 'off', label: t('settings.piarium.pluginSettings.subagents.thinking.off') },
        ]} />
        <PluginOptionalSelectField {...fieldProps} path={['reasoningMode']} label={t('settings.piarium.pluginSettings.codexCompat.field.reasoningMode')} options={[
          { value: 'standard', label: t('settings.piarium.pluginSettings.codexCompat.value.standard') },
          { value: 'pro', label: 'Pro' },
        ]} />
      </SettingsControlGroup>

      <SettingsControlGroup
        className={GROUP_CLASS}
        title={t('settings.piarium.pluginSettings.codexCompat.section.compaction')}
        contentClassName="space-y-4"
      >
        <PluginOptionalNumberField
          {...fieldProps}
          path={['autoCompactAtPercent']}
          label={t('settings.piarium.pluginSettings.codexCompat.field.autoCompactAtPercent')}
          min={0}
          max={100}
          step={0.1}
          fallbackValue={80}
          preserveTypedPrecision
          emptyLabel={t('settings.piarium.pluginSettings.codexCompat.value.piLifecycle')}
          emptyActionLabel={t('settings.piarium.pluginSettings.codexCompat.value.piLifecycle')}
          emptyValue={null}
          unit="%"
        />
      </SettingsControlGroup>

      <SettingsControlGroup
        className={GROUP_CLASS}
        title={t('settings.piarium.pluginSettings.codexCompat.section.tools')}
        contentClassName="space-y-4"
      >
        <PluginOptionalBooleanField {...fieldProps} path={['applyPatch']} label="apply_patch" />
        <PluginOptionalBooleanField {...fieldProps} path={['applyPatchDebug']} label={t('settings.piarium.pluginSettings.codexCompat.field.applyPatchDebug')} />
        <PluginOptionalSelectField {...fieldProps} path={['toolBackground']} label={t('settings.piarium.pluginSettings.codexCompat.field.toolBackground')} options={[
          { value: 'subtle', label: t('settings.piarium.pluginSettings.codexCompat.value.subtle') },
          { value: 'status', label: t('settings.piarium.pluginSettings.codexCompat.value.status') },
          { value: 'none', label: t('settings.piarium.pluginSettings.codexCompat.value.none') },
        ]} />
        <PluginOptionalBooleanField {...fieldProps} path={['imageGeneration']} label={t('settings.piarium.pluginSettings.codexCompat.field.imageGeneration')} />
        <PluginOptionalSelectField {...fieldProps} path={['imageDetail']} label={t('settings.piarium.pluginSettings.codexCompat.field.imageDetail')} options={[
          { value: 'auto', label: t('settings.piarium.pluginSettings.codexCompat.value.auto') },
          { value: 'low', label: t('settings.piarium.pluginSettings.subagents.thinking.low') },
          { value: 'high', label: t('settings.piarium.pluginSettings.subagents.thinking.high') },
          { value: 'original', label: t('settings.piarium.pluginSettings.codexCompat.value.original') },
        ]} />
        <PluginOptionalBooleanField {...fieldProps} path={['webRun']} label="web.run" />
        <PluginOptionalSelectField {...fieldProps} path={['webSearch']} label={t('settings.piarium.pluginSettings.codexCompat.field.webSearch')} options={[
          { value: 'disabled', label: t('settings.piarium.pluginSettings.field.disabled') },
          { value: 'cached', label: t('settings.piarium.pluginSettings.codexCompat.value.cached') },
          { value: 'indexed', label: t('settings.piarium.pluginSettings.codexCompat.value.indexed') },
          { value: 'live', label: t('settings.piarium.pluginSettings.codexCompat.value.live') },
        ]} />
      </SettingsControlGroup>

      <PluginAdvancedDraftEditor controller={controller} blocked={trustBlocked} />
      <PluginDraftFooter
        controller={controller}
        blocked={trustBlocked || issue !== null}
        blockedMessage={trustBlocked || !issue ? undefined : issueMessage(issue)}
      />
    </div>
  );
};
