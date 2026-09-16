import React from 'react';
import { SettingsSection, SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';
import type { HarnessSettingsPageProps } from './harness-settings-state';

export function ContextSettings({ harness, update }: HarnessSettingsPageProps) {
  const { t } = useI18n();
  const openPage = useUIStore((state) => state.setSettingsPage);
  return <>
    <SettingsSection settingsItem="harness.context">
      <SettingsCheckboxRow checked={harness.context.backgroundPreparation}
        onChange={(backgroundPreparation) => update({ context: { backgroundPreparation } })}
        ariaLabel={t('settings.page.harness.context.backgroundPreparation')}
        label={t('settings.page.harness.context.backgroundPreparation')}
        description={t('settings.page.harness.context.backgroundPreparation.description')} />
    </SettingsSection>
    <SettingsSection title={t('settings.page.knowledge.title')} description={t('settings.page.knowledge.description')}>
      <Button variant="outline" size="sm" onClick={() => openPage('knowledge')}>{t('settings.page.knowledge.title')}</Button>
    </SettingsSection>
  </>;
}
