import React from 'react';
import type { RuntimeContextTarget } from '@piarium/protocol';
import { SettingsControlGroup } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import {
  PluginBooleanField,
  PluginNumberField,
  PluginSelectField,
  PluginStringField,
} from './PluginConfigFields';
import { readJsonPath } from './plugin-config-model';
import { PluginDraftFooter, PluginRuntimeNote } from './PluginSettingsPanelShared';
import { useTextObjectDraft } from './usePluginConfigDraft';

interface WebAccessSettingsProps {
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
}

const WEB_ACCESS_PATHS = ['web-search.json'] as const;

export const WebAccessSettings: React.FC<WebAccessSettingsProps> = ({ runtimeTarget, targetKey }) => {
  const { t } = useI18n();
  const controller = useTextObjectDraft({
    format: 'json',
    paths: WEB_ACCESS_PATHS,
    root: 'agent',
    runtimeTarget,
    targetKey,
  });
  const disabled = !controller.loaded || controller.loading || controller.saving;
  const fieldProps = {
    disabled,
    draft: controller.draft,
    onRemove: controller.removeValue,
    onSet: controller.setValue,
  };
  const remote = readJsonPath(controller.draft, ['curatorRemote']);
  const remoteEnabled = remote === true
    || (typeof remote === 'object' && remote !== null && !Array.isArray(remote));

  return (
    <div className="space-y-7">
      <PluginRuntimeNote>{t('settings.piarium.pluginSettings.webAccess.runtimeNote')}</PluginRuntimeNote>

      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.webAccess.search.title')}
        description={t('settings.piarium.pluginSettings.webAccess.search.description')}
        contentClassName="space-y-4"
      >
        <PluginBooleanField
          {...fieldProps}
          path={['webSearch', 'enabled']}
          label="webSearch.enabled"
          defaultValue
        />
        <PluginStringField
          {...fieldProps}
          path={['provider']}
          label="provider"
          description={t('settings.piarium.pluginSettings.webAccess.provider.baseDescription')}
          placeholder="auto"
        />
        <PluginStringField
          {...fieldProps}
          path={['searchProvider']}
          label="searchProvider"
          description={t('settings.piarium.pluginSettings.webAccess.provider.description')}
          placeholder="auto"
        />
        <PluginSelectField
          {...fieldProps}
          path={['workflow']}
          label="workflow"
          defaultValue="summary-review"
          options={[
            { value: 'summary-review', label: 'summary-review' },
            { value: 'auto-summary', label: 'auto-summary' },
            { value: 'none', label: 'none' },
          ]}
        />
        <PluginStringField
          {...fieldProps}
          path={['summaryModel']}
          label="summaryModel"
          placeholder="provider/model"
        />
      </SettingsControlGroup>

      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.webAccess.curator.title')}
        description={t('settings.piarium.pluginSettings.webAccess.curator.description')}
        contentClassName="space-y-4"
      >
        <PluginNumberField
          {...fieldProps}
          path={['curatorTimeoutSeconds']}
          label="curatorTimeoutSeconds"
          defaultValue={remoteEnabled ? 60 : 20}
          min={1}
          unit="s"
        />
        <PluginBooleanField
          {...fieldProps}
          path={['autoOpenBrowser']}
          label="autoOpenBrowser"
          defaultValue={!remoteEnabled}
        />
        <PluginBooleanField
          {...fieldProps}
          path={['allowBrowserCookies']}
          label="allowBrowserCookies"
          defaultValue={false}
        />
        <PluginStringField
          {...fieldProps}
          path={['chromeProfile']}
          label="chromeProfile"
        />
      </SettingsControlGroup>

      <PluginDraftFooter controller={controller} />
    </div>
  );
};
