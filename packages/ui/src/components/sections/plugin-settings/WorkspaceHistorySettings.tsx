import React from 'react';
import type { PiConfigScope, RuntimeContextTarget } from '@piarium/protocol';
import { SettingsControlGroup } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import {
  PluginBooleanField,
  PluginNumberField,
  PluginSelectField,
  PluginStringField,
} from './PluginConfigFields';
import { PluginDraftFooter, PluginRuntimeNote, ScopeSelector } from './PluginSettingsPanelShared';
import { useSettingsObjectDraft } from './usePluginConfigDraft';

interface WorkspaceHistorySettingsProps {
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
}

export const WorkspaceHistorySettings: React.FC<WorkspaceHistorySettingsProps> = ({
  runtimeTarget,
  targetKey,
}) => {
  const { t } = useI18n();
  const [scope, setScope] = React.useState<PiConfigScope>('global');
  const controller = useSettingsObjectDraft({
    property: 'workspaceHistory',
    runtimeTarget,
    scope,
    targetKey,
  });
  const blocked = scope === 'project' && !controller.projectTrusted;
  const disabled = !controller.loaded || controller.loading || controller.saving || blocked;
  const fieldProps = {
    disabled,
    draft: controller.draft,
    onRemove: controller.removeValue,
    onSet: controller.setValue,
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
        <PluginRuntimeNote>{t('settings.piarium.pluginSettings.workspaceHistory.runtimeNote')}</PluginRuntimeNote>
        <ScopeSelector value={scope} onChange={setScope} disabled={controller.saving} />
      </div>

      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.workspaceHistory.activation.title')}
        description={t('settings.piarium.pluginSettings.workspaceHistory.activation.description')}
        contentClassName="space-y-4"
      >
        <PluginSelectField
          {...fieldProps}
          path={['enabled']}
          label={t('settings.piarium.pluginSettings.workspaceHistory.enabled')}
          defaultValue="auto"
          options={[
            { value: 'auto', label: t('settings.piarium.pluginSettings.workspaceHistory.enabled.auto') },
            { value: true, label: t('settings.piarium.pluginSettings.workspaceHistory.enabled.on') },
            { value: false, label: t('settings.piarium.pluginSettings.workspaceHistory.enabled.off') },
          ]}
        />
        <PluginBooleanField
          {...fieldProps}
          path={['requireProjectMarker']}
          label={t('settings.piarium.pluginSettings.workspaceHistory.requireProjectMarker')}
          defaultValue
        />
        <PluginBooleanField
          {...fieldProps}
          path={['allowHomeDirectory']}
          label={t('settings.piarium.pluginSettings.workspaceHistory.allowHomeDirectory')}
          description={t('settings.piarium.pluginSettings.workspaceHistory.allowHomeDirectory.description')}
          defaultValue={false}
        />
        <PluginStringField
          {...fieldProps}
          path={['storageDir']}
          label={t('settings.piarium.pluginSettings.workspaceHistory.storageDir')}
          placeholder={t('settings.piarium.pluginSettings.workspaceHistory.storageDir.placeholder')}
        />
      </SettingsControlGroup>

      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.workspaceHistory.limits.title')}
        description={t('settings.piarium.pluginSettings.workspaceHistory.limits.description')}
        contentClassName="space-y-4"
      >
        <PluginNumberField {...fieldProps} path={['maxSessionsPerWorkspace']} label="maxSessionsPerWorkspace" defaultValue={3} min={1} />
        <PluginNumberField {...fieldProps} path={['maxWorkspaces']} label="maxWorkspaces" defaultValue={10} min={1} />
        <PluginNumberField {...fieldProps} path={['maxScanFiles']} label="maxScanFiles" defaultValue={20_000} min={1} step={100} />
        <PluginNumberField {...fieldProps} path={['maxScanDirs']} label="maxScanDirs" defaultValue={3_000} min={1} step={100} />
        <PluginNumberField {...fieldProps} path={['maxScanMs']} label="maxScanMs" defaultValue={5_000} min={100} step={100} unit="ms" />
        <PluginNumberField {...fieldProps} path={['gitTimeoutMs']} label="gitTimeoutMs" defaultValue={60_000} min={100} step={1_000} unit="ms" />
      </SettingsControlGroup>

      <PluginDraftFooter controller={controller} blocked={blocked} />
    </div>
  );
};
