import React from 'react';
import type { JsonValue, PiConfigScope, RuntimeContextTarget } from '@piarium/protocol';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import {
  SettingsControlGroup,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
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
  hasJsonPath,
  readJsonPath,
  type JsonObject,
} from './plugin-config-model';
import {
  observationalMemoryDraftIssue,
  type ObservationalMemoryDraftIssue,
} from './observational-memory-config-model';
import { useSettingsObjectDraft } from './usePluginConfigDraft';

interface ObservationalMemorySettingsProps {
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
}

interface ModelFieldProps {
  disabled: boolean;
  draft: JsonObject;
  onRemove: (path: readonly string[]) => void;
  onSet: (path: readonly string[], value: JsonValue) => void;
}

const GROUP_CLASS = 'border-t border-border/60 pt-5';
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const ObservationalModelField: React.FC<ModelFieldProps> = ({
  disabled,
  draft,
  onRemove,
  onSet,
}) => {
  const { t } = useI18n();
  const provider = readJsonPath(draft, ['model', 'provider']);
  const model = readJsonPath(draft, ['model', 'id']);
  const explicit = hasJsonPath(draft, ['model']);
  return (
    <SettingsFieldRow
      label={t('settings.piarium.pluginSettings.observationalMemory.field.model')}
      controlClassName="w-full max-w-[24rem]"
    >
      <div
        aria-disabled={disabled}
        className={disabled ? 'pointer-events-none opacity-60' : undefined}
        inert={disabled ? true : undefined}
      >
        <ModelSelector
          providerId={typeof provider === 'string' ? provider : ''}
          modelId={typeof model === 'string' ? model : ''}
          placeholder={t('settings.piarium.pluginSettings.field.notSet')}
          onChange={(providerId, modelId) => {
            if (!providerId || !modelId) {
              onRemove(['model']);
              return;
            }
            onSet(['model', 'provider'], providerId);
            onSet(['model', 'id'], modelId);
          }}
          className="w-full max-w-72 justify-between"
          dropdownPortalToBody
        />
      </div>
      {explicit ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={disabled}
          onClick={() => onRemove(['model'])}
          className="!font-normal text-muted-foreground"
        >
          {t('settings.piarium.pluginSettings.field.remove')}
        </Button>
      ) : (
        <span className="typography-micro text-muted-foreground">
          {t('settings.piarium.pluginSettings.field.notSet')}
        </span>
      )}
    </SettingsFieldRow>
  );
};

export const ObservationalMemorySettings: React.FC<ObservationalMemorySettingsProps> = ({
  runtimeTarget,
  targetKey,
}) => {
  const { t } = useI18n();
  const [scope, setScope] = React.useState<PiConfigScope>('global');
  const globalController = useSettingsObjectDraft({
    property: 'observational-memory',
    runtimeTarget,
    scope: 'global',
    targetKey: `${targetKey}:global`,
  });
  const projectController = useSettingsObjectDraft({
    property: 'observational-memory',
    runtimeTarget,
    scope: 'project',
    targetKey: `${targetKey}:project`,
  });
  const controller = scope === 'project' ? projectController : globalController;
  const trustBlocked = scope === 'project' && !controller.projectTrusted;
  const issue = React.useMemo(
    () => observationalMemoryDraftIssue(controller.draft),
    [controller.draft],
  );
  const disabled = !controller.loaded
    || controller.loading
    || controller.saving
    || controller.rawError !== null
    || trustBlocked;
  const notSet = t('settings.piarium.pluginSettings.field.notSet');
  const modelConfigured = hasJsonPath(controller.draft, ['model']);
  const fieldProps = {
    disabled,
    draft: controller.draft,
    onRemove: controller.removeValue,
    onSet: controller.setValue,
    unsetLabel: notSet,
  };
  const fieldLabel = React.useCallback((field: string): string => {
    const labels: Record<string, string> = {
      agentMaxTurns: t('settings.piarium.pluginSettings.observationalMemory.field.agentMaxTurns'),
      compactAfterTokens: t('settings.piarium.pluginSettings.observationalMemory.field.compactAfterTokens'),
      compactAfterTokensMode: t('settings.piarium.pluginSettings.observationalMemory.field.compactMode'),
      compactAfterTokensRatio: t('settings.piarium.pluginSettings.observationalMemory.field.compactRatio'),
      debugLog: t('settings.piarium.pluginSettings.observationalMemory.field.debugLog'),
      model: t('settings.piarium.pluginSettings.observationalMemory.field.model'),
      'model.id': t('settings.piarium.pluginSettings.observationalMemory.field.model'),
      'model.provider': t('settings.piarium.pluginSettings.observationalMemory.field.model'),
      'model.thinking': t('settings.piarium.pluginSettings.observationalMemory.field.thinking'),
      observationsPoolMaxTokens: t('settings.piarium.pluginSettings.observationalMemory.field.poolMax'),
      observationsPoolTargetTokens: t('settings.piarium.pluginSettings.observationalMemory.field.poolTarget'),
      observeAfterTokens: t('settings.piarium.pluginSettings.observationalMemory.field.observeAfterTokens'),
      observerChunkMaxTokens: t('settings.piarium.pluginSettings.observationalMemory.field.observerChunkMaxTokens'),
      passive: t('settings.piarium.pluginSettings.observationalMemory.field.passive'),
      reflectAfterTokens: t('settings.piarium.pluginSettings.observationalMemory.field.reflectAfterTokens'),
      showWorkerNotifications: t('settings.piarium.pluginSettings.observationalMemory.field.notifications'),
    };
    return labels[field] ?? field;
  }, [t]);
  const issueMessage = React.useCallback((value: ObservationalMemoryDraftIssue): string => {
    const field = fieldLabel(value.field);
    switch (value.code) {
      case 'invalid-number':
        return t('settings.piarium.pluginSettings.validation.invalidNumber', { field });
      case 'invalid-boolean':
        return t('settings.piarium.pluginSettings.validation.invalidBoolean', { field });
      case 'required':
        return t('settings.piarium.pluginSettings.validation.required', { field });
      case 'invalid-value':
        return t('settings.piarium.pluginSettings.validation.invalidValue', { field });
    }
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
        title={t('settings.piarium.pluginSettings.observationalMemory.section.capture')}
        contentClassName="space-y-4"
      >
        <PluginOptionalNumberField {...fieldProps} path={['observeAfterTokens']} label={t('settings.piarium.pluginSettings.observationalMemory.field.observeAfterTokens')} min={1} step={1} fallbackValue={10000} />
        <PluginOptionalNumberField {...fieldProps} path={['reflectAfterTokens']} label={t('settings.piarium.pluginSettings.observationalMemory.field.reflectAfterTokens')} min={1} step={1} fallbackValue={20000} />
        <PluginOptionalNumberField {...fieldProps} path={['observerChunkMaxTokens']} label={t('settings.piarium.pluginSettings.observationalMemory.field.observerChunkMaxTokens')} min={1} step={1} fallbackValue={60000} />
      </SettingsControlGroup>

      <SettingsControlGroup
        className={GROUP_CLASS}
        title={t('settings.piarium.pluginSettings.observationalMemory.section.compaction')}
        contentClassName="space-y-4"
      >
        <PluginOptionalSelectField {...fieldProps} path={['compactAfterTokensMode']} label={t('settings.piarium.pluginSettings.observationalMemory.field.compactMode')} options={[
          { value: 'calibrated', label: t('settings.piarium.pluginSettings.observationalMemory.value.calibrated') },
          { value: 'ratio', label: t('settings.piarium.pluginSettings.observationalMemory.value.ratio') },
        ]} />
        <PluginOptionalNumberField {...fieldProps} path={['compactAfterTokens']} label={t('settings.piarium.pluginSettings.observationalMemory.field.compactAfterTokens')} min={1} step={1} fallbackValue={81000} />
        <PluginOptionalNumberField {...fieldProps} path={['compactAfterTokensRatio']} label={t('settings.piarium.pluginSettings.observationalMemory.field.compactRatio')} min={0} max={1} step={0.01} fallbackValue={0.68} preserveTypedPrecision />
      </SettingsControlGroup>

      <SettingsControlGroup
        className={GROUP_CLASS}
        title={t('settings.piarium.pluginSettings.observationalMemory.section.pool')}
        contentClassName="space-y-4"
      >
        <PluginOptionalNumberField {...fieldProps} path={['observationsPoolMaxTokens']} label={t('settings.piarium.pluginSettings.observationalMemory.field.poolMax')} min={1} step={1} fallbackValue={20000} />
        <PluginOptionalNumberField {...fieldProps} path={['observationsPoolTargetTokens']} label={t('settings.piarium.pluginSettings.observationalMemory.field.poolTarget')} min={1} step={1} fallbackValue={10000} />
      </SettingsControlGroup>

      <SettingsControlGroup
        className={GROUP_CLASS}
        title={t('settings.piarium.pluginSettings.observationalMemory.section.worker')}
        contentClassName="space-y-4"
      >
        <ObservationalModelField {...fieldProps} />
        <PluginOptionalSelectField {...fieldProps} disabled={disabled || !modelConfigured} path={['model', 'thinking']} label={t('settings.piarium.pluginSettings.observationalMemory.field.thinking')} options={THINKING_LEVELS.map((level) => ({
          value: level,
          label: t(`settings.piarium.pluginSettings.subagents.thinking.${level}` as Parameters<typeof t>[0]),
        }))} />
        <PluginOptionalNumberField {...fieldProps} path={['agentMaxTurns']} label={t('settings.piarium.pluginSettings.observationalMemory.field.agentMaxTurns')} min={1} step={1} fallbackValue={16} />
        <PluginOptionalBooleanField {...fieldProps} path={['showWorkerNotifications']} label={t('settings.piarium.pluginSettings.observationalMemory.field.notifications')} />
        <PluginOptionalBooleanField {...fieldProps} path={['passive']} label={t('settings.piarium.pluginSettings.observationalMemory.field.passive')} />
        <PluginOptionalBooleanField {...fieldProps} path={['debugLog']} label={t('settings.piarium.pluginSettings.observationalMemory.field.debugLog')} />
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
