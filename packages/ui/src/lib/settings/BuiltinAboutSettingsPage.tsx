import React from 'react';
import { AboutSettings } from '@/components/sections/openchamber/AboutSettings';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { useI18n } from '@/lib/i18n';

export const BuiltinAboutSettingsPage: React.FC = () => {
  const { t } = useI18n();
  return (
    <SettingsPageLayout title={t('settings.page.about.title')} showSaveStatus={false}>
      <AboutSettings />
    </SettingsPageLayout>
  );
};
