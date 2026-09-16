import React from 'react';
import { SettingsSection, SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiProviderStore } from '@/stores/usePiProviderStore';
import { useI18n } from '@/lib/i18n';
import { AutoSaveInput } from './AutoSaveInput';
import type { HarnessSettingsPageProps } from './harness-settings-state';

function InferenceSettings({ harness, update, kind }: HarnessSettingsPageProps & { kind: 'embedding' | 'rerank' }) {
  const { t } = useI18n();
  const providers = usePiProviderStore((state) => state.providers);
  const binding = harness[kind];
  const [remote, setRemote] = React.useState(Boolean(binding));
  const remoteRef = React.useRef(remote);
  const [fields, setFields] = React.useState({ providerId: binding?.providerId ?? '', modelId: binding?.modelId ?? '', endpoint: kind === 'rerank' ? harness.rerank?.endpoint ?? '' : '' });
  const current = React.useRef(fields);
  const commit = (patch: Partial<typeof fields>) => {
    if (!remoteRef.current) return;
    const next = { ...current.current, ...patch };
    current.current = next;
    setFields(next);
    if (!next.providerId.trim() || !next.modelId.trim()) return;
    update({ [kind]: {
      protocol: kind === 'embedding' ? 'openai-compatible' : 'http-rerank',
      providerId: next.providerId.trim(), modelId: next.modelId.trim(),
      ...(kind === 'rerank' ? { endpoint: next.endpoint.trim() || undefined } : {}),
    } });
  };
  const defaultLabel = t(kind === 'embedding' ? 'settings.harness.retrieval.local' : 'settings.harness.retrieval.off');
  return <SettingsSection title={t(`settings.page.harness.section.${kind}`)} settingsItem={`harness.${kind}`} contentClassName="space-y-5">
    <SettingsFieldRow label={t('settings.harness.retrieval.source')} description={t(`settings.page.harness.section.${kind}.description`)}>
      <Select value={remote ? 'remote' : 'default'} onValueChange={(value) => { remoteRef.current = value === 'remote'; setRemote(value === 'remote'); if (value === 'default') update({ [kind]: undefined }); else commit({}); }}>
        <SelectTrigger size="settings" className="w-64" aria-label={t('settings.harness.retrieval.source')}><SelectValue>{remote ? t('settings.harness.retrieval.remote') : defaultLabel}</SelectValue></SelectTrigger>
        <SelectContent><SelectItem value="default">{defaultLabel}</SelectItem><SelectItem value="remote">{t('settings.harness.retrieval.remote')}</SelectItem></SelectContent>
      </Select>
    </SettingsFieldRow>
    {remote ? <>
      <SettingsFieldRow label={t(`settings.page.harness.${kind}.provider`)}>
        <Select value={fields.providerId || '__none'} onValueChange={(providerId) => {
          if (providerId === '__none') return;
          const next = { ...current.current, providerId, modelId: '' };
          current.current = next; setFields(next);
        }}>
          <SelectTrigger size="settings" className="w-64" aria-label={t(`settings.page.harness.${kind}.provider`)}><SelectValue>{fields.providerId || t('settings.page.harness.models.notConfigured')}</SelectValue></SelectTrigger>
          <SelectContent><SelectItem value="__none" disabled>{t('settings.page.harness.models.notConfigured')}</SelectItem>{providers.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.id}</SelectItem>)}</SelectContent>
        </Select>
      </SettingsFieldRow>
      <SettingsFieldRow label={t(`settings.page.harness.${kind}.model`)} controlClassName="@xl:flex-1 @xl:max-w-80">
        <AutoSaveInput key={fields.providerId} value={fields.modelId} onCommit={(modelId) => { if (current.current.providerId === fields.providerId) commit({ modelId }); }}
          aria-label={t(`settings.page.harness.${kind}.model`)} placeholder={kind === 'embedding' ? 'text-embedding-3-small' : 'rerank-v3.5'} />
      </SettingsFieldRow>
      {kind === 'rerank' ? <SettingsFieldRow label={t('settings.page.harness.rerank.endpoint')} controlClassName="@xl:flex-1 @xl:max-w-80">
        <AutoSaveInput value={fields.endpoint} onCommit={(endpoint) => commit({ endpoint })} placeholder="/rerank" aria-label={t('settings.page.harness.rerank.endpoint')}
          validate={(value) => !value || value.startsWith('/') ? null : t('settings.page.harness.rerank.endpoint.description')} />
      </SettingsFieldRow> : null}
      <p className="typography-meta text-muted-foreground">{t(!fields.providerId || !fields.modelId ? 'settings.harness.completeFields' : `settings.page.harness.${kind}.provider.description`)}</p>
    </> : null}
  </SettingsSection>;
}

export function RetrievalSettings(props: HarnessSettingsPageProps) {
  const cwd = useDirectoryStore((state) => state.currentDirectory);
  const load = usePiProviderStore((state) => state.load);
  const error = usePiProviderStore((state) => state.error);
  React.useEffect(() => { void load(cwd).catch(() => undefined); }, [cwd, load]);
  return <>
    {error ? <p role="alert" className="typography-meta text-destructive">{String(error)}</p> : null}
    <InferenceSettings {...props} kind="embedding" />
    <InferenceSettings {...props} kind="rerank" />
  </>;
}
