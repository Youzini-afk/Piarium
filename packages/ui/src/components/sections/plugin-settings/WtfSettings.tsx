import React from 'react';
import type { RuntimeContextTarget } from '@piarium/protocol';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  SettingsControlGroup,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import {
  invalidCommandWords,
  normalizeCommandWords,
  readJsonPath,
  validStringArray,
} from './plugin-config-model';
import { PluginAdvancedDraftEditor } from './PluginAdvancedDraftEditor';
import { PluginConfigSource, PluginDraftFooter } from './PluginSettingsPanelShared';
import { useConfigDocumentObjectDraft } from './usePluginConfigDraft';

interface WtfSettingsProps {
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
}

export const WtfSettings: React.FC<WtfSettingsProps> = ({ runtimeTarget, targetKey }) => {
  const { t } = useI18n();
  const controller = useConfigDocumentObjectDraft({
    path: 'wtf.json',
    runtimeTarget,
    scope: 'global',
    targetKey,
  });
  const configuredWords = validStringArray(readJsonPath(controller.draft, ['words']));
  const words = configuredWords ?? ['fuck'];
  const invalid = invalidCommandWords(words);
  const disabled = !controller.loaded
    || controller.loading
    || controller.saving
    || controller.rawError !== null;

  return (
    <div className="space-y-7">
      <PluginConfigSource controller={controller} />

      <SettingsControlGroup
        title={t('settings.piarium.pluginSettings.wtf.words')}
        info={t('settings.piarium.pluginSettings.wtf.words.description')}
      >
        <SettingsFieldRow
          label={t('settings.piarium.pluginSettings.wtf.words.label')}
          alignEnd={false}
          controlClassName="w-full max-w-[24rem] items-start"
        >
          <Textarea
            value={words.join('\n')}
            disabled={disabled}
            onChange={(event) => {
              const next = normalizeCommandWords(event.target.value);
              if (next.length === 0) controller.removeValue(['words']);
              else controller.setValue(['words'], next);
            }}
            className="min-h-28 min-w-0 flex-1 font-mono"
            placeholder="fuck"
          />
          {configuredWords ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={disabled}
              onClick={() => controller.removeValue(['words'])}
              className="shrink-0 !font-normal text-muted-foreground"
            >
              {t('settings.piarium.pluginSettings.field.useDefault')}
            </Button>
          ) : (
            <span className="shrink-0 typography-micro text-muted-foreground">
              {t('settings.piarium.pluginSettings.field.pluginDefault')}
            </span>
          )}
        </SettingsFieldRow>
      </SettingsControlGroup>

      <SettingsControlGroup
        className="border-t border-border/60 pt-5"
        title={t('settings.piarium.pluginSettings.wtf.commands')}
        info={t('settings.piarium.pluginSettings.wtf.commands.description')}
        contentClassName="divide-y divide-border/60"
      >
        {words.flatMap((word) => ([
          { command: `/${word}`, description: t('settings.piarium.pluginSettings.wtf.command.repair') },
          { command: `/${word}?`, description: t('settings.piarium.pluginSettings.wtf.command.modelRepair') },
          { command: `/${word}!`, description: t('settings.piarium.pluginSettings.wtf.command.rewrite') },
        ])).map((entry) => (
          <div key={entry.command} className="grid gap-1 py-2.5 @xl:grid-cols-[8rem_minmax(0,1fr)] @xl:gap-4">
            <code className="typography-ui-label text-foreground">{entry.command}</code>
            <p className={entry.command.endsWith('!')
              ? 'typography-meta text-[var(--status-warning)]'
              : 'typography-meta text-muted-foreground'}>
              {entry.description}
            </p>
          </div>
        ))}
      </SettingsControlGroup>

      <PluginAdvancedDraftEditor controller={controller} />
      <PluginDraftFooter
        controller={controller}
        blocked={invalid.length > 0}
        blockedMessage={t('settings.piarium.pluginSettings.wtf.invalidWords', { words: invalid.join(', ') })}
      />
    </div>
  );
};
