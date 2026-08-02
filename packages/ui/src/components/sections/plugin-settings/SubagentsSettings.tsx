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
import {
  useConfigDocumentObjectDraft,
  useSettingsObjectDraft,
} from './usePluginConfigDraft';

interface SubagentsSettingsProps {
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
}

export const SubagentsSettings: React.FC<SubagentsSettingsProps> = ({ runtimeTarget, targetKey }) => {
  const { t } = useI18n();
  const [scope, setScope] = React.useState<PiConfigScope>('global');
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
  const settingsBlocked = scope === 'project' && !settings.projectTrusted;
  const settingsFields = {
    disabled: !settings.loaded || settings.loading || settings.saving || settingsBlocked,
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

  return (
    <div className="space-y-8">
      <PluginRuntimeNote>{t('settings.piarium.pluginSettings.subagents.runtimeNote')}</PluginRuntimeNote>

      <div className="space-y-5 rounded-lg border border-border/60 px-4 py-4">
        <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
          <div className="space-y-1">
            <h3 className="typography-settings-group-title text-foreground">
              {t('settings.piarium.pluginSettings.subagents.defaults.title')}
            </h3>
            <p className="typography-meta text-muted-foreground">
              {t('settings.piarium.pluginSettings.subagents.defaults.description')}
            </p>
          </div>
          <ScopeSelector value={scope} onChange={setScope} disabled={settings.saving} />
        </div>

        <div className="space-y-4">
          <PluginStringField {...settingsFields} path={['defaultModel']} label="defaultModel" placeholder="provider/model" />
          <PluginStringField {...settingsFields} path={['defaultThinking']} label="defaultThinking" placeholder="off | low | medium | high | xhigh" />
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
          title={t('settings.piarium.pluginSettings.subagents.watchdog.title')}
          description={t('settings.piarium.pluginSettings.subagents.watchdog.description')}
          contentClassName="space-y-4"
        >
          <PluginBooleanField {...settingsFields} path={['watchdog', 'enabled']} label="watchdog.enabled" defaultValue={false} />
          <PluginBooleanField {...settingsFields} path={['watchdog', 'showDuringRun']} label="watchdog.showDuringRun" defaultValue={false} />
          <PluginBooleanField {...settingsFields} path={['watchdog', 'main', 'enabled']} label="watchdog.main.enabled" defaultValue={false} />
          <PluginBooleanField {...settingsFields} path={['watchdog', 'children', 'enabled']} label="watchdog.children.enabled" defaultValue={false} />
          <PluginBooleanField {...settingsFields} path={['watchdog', 'lsp', 'enabled']} label="watchdog.lsp.enabled" defaultValue />
          <PluginNumberField {...settingsFields} path={['watchdog', 'compactAtPercent']} label="watchdog.compactAtPercent" defaultValue={80} min={1} max={100} unit="%" />
        </SettingsControlGroup>

        <PluginDraftFooter controller={settings} blocked={settingsBlocked} />
      </div>

      <div className="space-y-5 rounded-lg border border-border/60 px-4 py-4">
        <div className="space-y-1">
          <h3 className="typography-settings-group-title text-foreground">
            {t('settings.piarium.pluginSettings.subagents.runtime.title')}
          </h3>
          <p className="typography-meta text-muted-foreground">
            {t('settings.piarium.pluginSettings.subagents.runtime.description')}
          </p>
        </div>

        <div className="space-y-4">
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
          <PluginNumberField {...runtimeFields} path={['maxSubagentDepth']} label="maxSubagentDepth" defaultValue={2} min={0} />
          <PluginNumberField {...runtimeFields} path={['maxSubagentSpawnsPerSession']} label="maxSubagentSpawnsPerSession" description={t('settings.piarium.pluginSettings.subagents.unlimitedZero')} defaultValue={0} min={0} />
          <PluginNumberField {...runtimeFields} path={['globalConcurrencyLimit']} label="globalConcurrencyLimit" defaultValue={20} min={1} />
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
        </div>

        <PluginDraftFooter controller={runtime} />
      </div>
    </div>
  );
};
