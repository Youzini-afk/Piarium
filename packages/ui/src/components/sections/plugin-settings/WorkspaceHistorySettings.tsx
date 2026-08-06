import React from 'react';
import type { PiConfigScope, RuntimeContextTarget } from '@piarium/protocol';
import {
  SettingsControlGroup,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import {
  PluginBooleanField,
  PluginNumberField,
  PluginSelectField,
  PluginStringField,
} from './PluginConfigFields';
import { PluginAdvancedDraftEditor } from './PluginAdvancedDraftEditor';
import {
  PluginConfigSource,
  PluginDraftFooter,
  ScopeSelector,
} from './PluginSettingsPanelShared';
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
  const globalController = useSettingsObjectDraft({
    property: 'workspaceHistory',
    runtimeTarget,
    scope: 'global',
    targetKey: `${targetKey}:global`,
  });
  const projectController = useSettingsObjectDraft({
    property: 'workspaceHistory',
    runtimeTarget,
    scope: 'project',
    targetKey: `${targetKey}:project`,
  });
  const controller = scope === 'global' ? globalController : projectController;
  const blocked = scope === 'project' && !controller.projectTrusted;
  const disabled = !controller.loaded
    || controller.loading
    || controller.saving
    || controller.rawError !== null
    || blocked;
  const fieldProps = {
    disabled,
    draft: controller.draft,
    onRemove: controller.removeValue,
    onSet: controller.setValue,
  };

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
        title={t('settings.piarium.pluginSettings.workspaceHistory.activation.title')}
        info={t('settings.piarium.pluginSettings.workspaceHistory.activation.description')}
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
          description={t('settings.piarium.pluginSettings.workspaceHistory.storageDir.description')}
          placeholder={t('settings.piarium.pluginSettings.workspaceHistory.storageDir.placeholder')}
        />
      </SettingsControlGroup>

      <SettingsControlGroup
        className="border-t border-border/60 pt-5"
        title={t('settings.piarium.pluginSettings.workspaceHistory.retention.title')}
        info={t('settings.piarium.pluginSettings.workspaceHistory.retention.description')}
        contentClassName="space-y-4"
      >
        <p className="typography-meta text-[var(--status-warning)]">
          {t('settings.piarium.pluginSettings.workspaceHistory.retention.warning')}
        </p>
        <PluginNumberField
          {...fieldProps}
          path={['maxSessionsPerWorkspace']}
          label={t('settings.piarium.pluginSettings.workspaceHistory.retention.sessions')}
          info={t('settings.piarium.pluginSettings.workspaceHistory.retention.sessions.description')}
          defaultValue={3}
          min={1}
        />
        <PluginNumberField
          {...fieldProps}
          path={['maxWorkspaces']}
          label={t('settings.piarium.pluginSettings.workspaceHistory.retention.workspaces')}
          info={t('settings.piarium.pluginSettings.workspaceHistory.retention.workspaces.description')}
          defaultValue={10}
          min={1}
        />
      </SettingsControlGroup>

      <PluginAdvancedDraftEditor controller={controller} blocked={blocked} />
      <PluginDraftFooter controller={controller} blocked={blocked} />
    </div>
  );
};
