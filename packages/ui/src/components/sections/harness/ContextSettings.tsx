import React from 'react';
import { SettingsSection, SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import type { HarnessSettingsPageProps } from './harness-settings-state';

export function ContextSettings({ harness, update }: HarnessSettingsPageProps) {
  const { t } = useI18n();
  return <>
    <SettingsSection settingsItem="harness.context">
      <SettingsCheckboxRow checked={harness.context.backgroundPreparation}
        onChange={(backgroundPreparation) => update({ context: { backgroundPreparation } })}
        ariaLabel={t('settings.page.harness.context.backgroundPreparation')}
        label={t('settings.page.harness.context.backgroundPreparation')}
        description={t('settings.page.harness.context.backgroundPreparation.description')} />
    </SettingsSection>
  </>;
}
