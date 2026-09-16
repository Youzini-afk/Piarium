import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useHarnessSettings } from './useHarnessSettings';
import { ToolsSettings } from './ToolsSettings';
import { PermissionsSettings } from './PermissionsSettings';
import { ModelsSettings } from './ModelsSettings';
import { ContextSettings } from './ContextSettings';
import { RetrievalSettings } from './RetrievalSettings';
import { WebSettings } from './WebSettings';

export type HarnessSettingsSection = 'tools' | 'permissions' | 'models' | 'context' | 'retrieval' | 'web';
const pages = { tools: ToolsSettings, permissions: PermissionsSettings, models: ModelsSettings,
  context: ContextSettings, retrieval: RetrievalSettings, web: WebSettings };

export function HarnessSettingsPage({ section }: { section: HarnessSettingsSection }) {
  const { t } = useI18n();
  const { harness, status, error, update, retry, targetKey } = useHarnessSettings();
  const Page = pages[section];
  return <SettingsPageLayout title={t(`settings.page.harness.page.${section}.title`)}
    description={t(`settings.page.harness.page.${section}.description`)} showSaveStatus
    headerEnd={<span className="typography-meta text-muted-foreground">{t('settings.harness.userDefaults')}</span>}
    className="[&>section]:py-5 [&>section]:space-y-4">
    {status === 'loading' ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
    {error ? <div role="alert" className="mb-5 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
      <p className="typography-meta text-destructive">{error}</p>
      <Button variant="outline" size="sm" className="mt-2" onClick={() => { void retry(); }}>{t('settings.harness.retry')}</Button>
    </div> : null}
    {harness ? <Page key={`${targetKey}:${section}`} harness={harness} update={update} /> : null}
    {harness ? <p className="pb-4 typography-meta text-muted-foreground">{t('settings.page.harness.nextSession')}</p> : null}
  </SettingsPageLayout>;
}
