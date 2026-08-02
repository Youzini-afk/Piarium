import React from 'react';
import type { RuntimeContextTarget } from '@piarium/protocol';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import {
  invalidCommandWords,
  normalizeCommandWords,
  readJsonPath,
  validStringArray,
} from './plugin-config-model';
import { PluginDraftFooter, PluginRuntimeNote } from './PluginSettingsPanelShared';
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
  const disabled = !controller.loaded || controller.loading || controller.saving;

  return (
    <div className="space-y-6">
      <PluginRuntimeNote>{t('settings.piarium.pluginSettings.wtf.runtimeNote')}</PluginRuntimeNote>

      <SettingsFieldRow
        label={t('settings.piarium.pluginSettings.wtf.words')}
        description={t('settings.piarium.pluginSettings.wtf.words.description')}
        alignEnd={false}
        controlClassName="w-full max-w-lg items-start"
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

      <div className="rounded-lg border border-border/60 px-3 py-3">
        <p className="typography-ui-label text-foreground">
          {t('settings.piarium.pluginSettings.wtf.commands')}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {words.flatMap((word) => [word, `${word}?`, `${word}!`]).map((command) => (
            <code key={command} className="rounded bg-[var(--surface-elevated)] px-2 py-1 typography-micro text-foreground">
              /{command}
            </code>
          ))}
        </div>
      </div>

      <PluginDraftFooter
        controller={controller}
        blocked={invalid.length > 0}
        blockedMessage={t('settings.piarium.pluginSettings.wtf.invalidWords', { words: invalid.join(', ') })}
      />
    </div>
  );
};
