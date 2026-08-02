import React from 'react';
import type { RuntimeContextTarget } from '@piarium/protocol';
import { SettingsControlGroup } from '@/components/sections/shared/SettingsSection';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import {
  PluginBooleanField,
  PluginNumberField,
  PluginStringField,
  PluginStringListField,
} from './PluginConfigFields';
import { PluginDraftFooter, PluginRuntimeNote } from './PluginSettingsPanelShared';
import { useTextObjectDraft } from './usePluginConfigDraft';

interface MagicContextSettingsProps {
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
}

type MagicScope = 'user' | 'project';
type MagicAgent = 'historian' | 'dreamer' | 'sidekick';

const MAGIC_USER_PATHS = ['cortexkit/magic-context.jsonc', 'cortexkit/magic-context.json'] as const;
const MAGIC_PROJECT_PATHS = ['.cortexkit/magic-context.jsonc', '.cortexkit/magic-context.json'] as const;
const MAGIC_AGENTS: readonly MagicAgent[] = ['historian', 'dreamer', 'sidekick'];
const DREAMER_TASK_DEFAULTS = {
  'map-memories': { schedule: '0 2 * * *', timeout: 20 },
  verify: { schedule: '0 3 * * *', timeout: 20 },
  'verify-broad': { schedule: '0 4 * * 0', timeout: 20 },
  curate: { schedule: '0 4 * * 0', timeout: 20 },
  'compress-cues': { schedule: '0 4 * * *', timeout: 20 },
  'classify-memories': { schedule: '0 6 * * *', timeout: 20 },
  retrospective: { schedule: '0 5 * * *', timeout: 20 },
  'maintain-docs': { schedule: '', timeout: 20 },
  'evaluate-smart-notes': { schedule: '0 3 * * *', timeout: 20 },
  'review-user-memories': { schedule: '0 3 * * *', timeout: 20 },
  'promote-primers': { schedule: '0 3 * * *', timeout: 20 },
  'refresh-primers': { schedule: '0 3 * * *', timeout: 20 },
} as const;
type DreamerTask = keyof typeof DREAMER_TASK_DEFAULTS;

export const MagicContextSettings: React.FC<MagicContextSettingsProps> = ({
  runtimeTarget,
  targetKey,
}) => {
  const { t } = useI18n();
  const [scope, setScope] = React.useState<MagicScope>('user');
  const [task, setTask] = React.useState<DreamerTask>('map-memories');
  const controller = useTextObjectDraft({
    format: 'jsonc',
    paths: scope === 'user' ? MAGIC_USER_PATHS : MAGIC_PROJECT_PATHS,
    root: scope === 'user' ? 'user-config' : 'project',
    runtimeTarget,
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
  const taskDefaults = DREAMER_TASK_DEFAULTS[task];

  return (
    <div className="space-y-7">
      <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
        <PluginRuntimeNote>{t('settings.piarium.pluginSettings.magic.runtimeNote')}</PluginRuntimeNote>
        <Select value={scope} disabled={controller.saving} onValueChange={setScope}>
          <SelectTrigger size="settings" className="min-w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="user">{t('settings.piarium.pluginSettings.magic.scope.user')}</SelectItem>
            <SelectItem value="project">{t('settings.common.scope.project')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.magic.core.title')}
        description={t('settings.piarium.pluginSettings.magic.core.description')}
        contentClassName="space-y-4"
      >
        <PluginBooleanField {...fieldProps} path={['enabled']} label="enabled" defaultValue />
        {scope === 'user' ? (
          <PluginStringField
            {...fieldProps}
            path={['language']}
            label="language"
            placeholder="en | zh | ja | ..."
          />
        ) : null}
      </SettingsControlGroup>

      {MAGIC_AGENTS.map((agent) => {
        const historianProject = scope === 'project' && agent === 'historian';
        return (
          <SettingsControlGroup
            key={agent}
            title={agent}
            description={t(`settings.piarium.pluginSettings.magic.agent.${agent}.description`)}
            contentClassName="space-y-4"
          >
            <PluginBooleanField {...fieldProps} path={[agent, 'disable']} label="disable" defaultValue={false} />
            {!historianProject ? (
              <PluginStringField {...fieldProps} path={[agent, 'model']} label="model" placeholder="provider/model" />
            ) : null}
            {!historianProject ? (
              <PluginStringListField
                {...fieldProps}
                path={[agent, 'fallback_models']}
                label="fallback_models"
                placeholder="provider/model"
              />
            ) : null}
            <PluginStringField
              {...fieldProps}
              path={[agent, 'thinking_level']}
              label="thinking_level"
              placeholder="off | minimal | low | medium | high | xhigh"
            />
          </SettingsControlGroup>
        );
      })}

      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.magic.tasks.title')}
        description={t('settings.piarium.pluginSettings.magic.tasks.description')}
        contentClassName="space-y-4"
      >
        <div className="flex justify-end">
          <Select value={task} disabled={disabled} onValueChange={setTask}>
            <SelectTrigger size="settings" className="min-w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {(Object.keys(DREAMER_TASK_DEFAULTS) as DreamerTask[]).map((name) => (
                <SelectItem key={name} value={name}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <PluginStringField
          {...fieldProps}
          path={['dreamer', 'tasks', task, 'schedule']}
          label="schedule"
          description={t('settings.piarium.pluginSettings.magic.tasks.schedule.description')}
          defaultValue={taskDefaults.schedule}
          allowEmpty
          placeholder="0 3 * * *"
        />
        <PluginStringField
          {...fieldProps}
          path={['dreamer', 'tasks', task, 'model']}
          label="model"
          placeholder="provider/model"
        />
        <PluginStringField
          {...fieldProps}
          path={['dreamer', 'tasks', task, 'thinking_level']}
          label="thinking_level"
          placeholder="off | minimal | low | medium | high | xhigh"
        />
        <PluginNumberField
          {...fieldProps}
          path={['dreamer', 'tasks', task, 'timeout_minutes']}
          label="timeout_minutes"
          defaultValue={taskDefaults.timeout}
          min={5}
          unit="min"
        />
      </SettingsControlGroup>

      <PluginDraftFooter controller={controller} blocked={blocked} />
    </div>
  );
};
