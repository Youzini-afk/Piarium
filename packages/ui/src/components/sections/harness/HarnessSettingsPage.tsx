import React from 'react';
import { useI18n } from '@/lib/i18n';

export const HarnessSettingsPage: React.FC = () => {
  const { t } = useI18n();

  return (
    <div className="space-y-6 p-6">
      <div>
        <h2 className="text-lg font-semibold">{t('settings.page.harness.title')}</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t('settings.page.harness.description')}
        </p>
      </div>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">{t('settings.page.harness.section.tools')}</h3>
        <p className="text-xs text-muted-foreground">
          {t('settings.page.harness.section.tools.description')}
        </p>
        {/* Tool toggles will be added as tools are implemented in phases 1.3-1.7 */}
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {t('settings.page.harness.section.tools.placeholder')}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">{t('settings.page.harness.section.shell')}</h3>
        <p className="text-xs text-muted-foreground">
          {t('settings.page.harness.section.shell.description')}
        </p>
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {t('settings.page.harness.section.shell.placeholder')}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">{t('settings.page.harness.section.output')}</h3>
        <p className="text-xs text-muted-foreground">
          {t('settings.page.harness.section.output.description')}
        </p>
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {t('settings.page.harness.section.output.placeholder')}
        </div>
      </section>
    </div>
  );
};
