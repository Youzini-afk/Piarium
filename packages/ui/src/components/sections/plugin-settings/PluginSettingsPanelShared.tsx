import React from 'react';
import type { PiConfigScope } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import type { PluginObjectDraft } from './usePluginConfigDraft';

export const ScopeSelector: React.FC<{
  disabled?: boolean;
  onChange: (scope: PiConfigScope) => void;
  value: PiConfigScope;
}> = ({ disabled, onChange, value }) => {
  const { t } = useI18n();
  return (
    <Select value={value} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger size="settings" className="min-w-40">
        <SelectValue>
          {value === 'project'
            ? t('settings.common.scope.project')
            : t('settings.common.scope.global')}
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value="global">{t('settings.common.scope.global')}</SelectItem>
        <SelectItem value="project">{t('settings.common.scope.project')}</SelectItem>
      </SelectContent>
    </Select>
  );
};

export const PluginDraftFooter: React.FC<{
  blocked?: boolean;
  blockedMessage?: React.ReactNode;
  controller: PluginObjectDraft;
}> = ({ blocked = false, blockedMessage, controller }) => {
  const { t } = useI18n();
  return (
    <div className="space-y-3 border-t border-border/60 pt-4">
      <div className="flex justify-end">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={controller.loading || controller.saving}
            onClick={() => void controller.reload()}
            className="!font-normal gap-1.5"
          >
            <Icon name="refresh" className={controller.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
            {controller.dirty
              ? t('settings.piarium.pluginSettings.source.discard')
              : t('settings.piarium.recovery.actions.refresh')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!controller.loaded || !controller.dirty || controller.externalChanged || controller.loading || controller.saving || controller.rawError !== null || blocked}
            onClick={() => void controller.save()}
          >
            {controller.saving
              ? t('settings.common.actions.saving')
              : t('settings.common.actions.saveChanges')}
          </Button>
        </div>
      </div>
      {controller.error ? (
        <p className="break-words typography-meta text-[var(--status-error)]">{controller.error}</p>
      ) : null}
      {blocked && !controller.loading ? (
        <p className="typography-meta text-[var(--status-warning)]">
          {blockedMessage ?? t('settings.piarium.recovery.pluginSettings.projectUntrusted')}
        </p>
      ) : null}
    </div>
  );
};

export const PluginConfigSource: React.FC<{
  controller: PluginObjectDraft;
}> = ({ controller }) => {
  const { t } = useI18n();
  return (
    <SettingsFieldRow
      label={t('settings.piarium.pluginSettings.source.label')}
      info={t('settings.piarium.pluginSettings.source.description')}
      controlClassName="w-full max-w-[24rem]"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <code className="min-w-0 break-all typography-micro text-muted-foreground">
          {controller.path || t('settings.piarium.pluginSettings.loadingPath')}
        </code>
        {controller.dirty ? (
          <span className="shrink-0 rounded-full border border-[var(--status-warning)]/30 px-2 py-0.5 typography-micro text-[var(--status-warning)]">
            {t('settings.piarium.pluginSettings.source.unsaved')}
          </span>
        ) : null}
      </div>
    </SettingsFieldRow>
  );
};

export const PluginRuntimeNote: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex items-start gap-2 typography-meta text-muted-foreground">
    <Icon name="information" className="mt-0.5 size-4 shrink-0" />
    <p>{children}</p>
  </div>
);
