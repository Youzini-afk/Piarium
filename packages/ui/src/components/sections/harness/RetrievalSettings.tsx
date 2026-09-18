import React from 'react';
import type { LocalSemanticStatus } from '@piarium/protocol';
import { Button } from '@/components/ui/button';
import { SettingsSection, SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { usePiProviderStore } from '@/stores/usePiProviderStore';
import { useI18n } from '@/lib/i18n';
import { AutoSaveInput } from './AutoSaveInput';
import { cancelLocalSemantic, getLocalSemanticStatus, importLocalSemantic, installLocalSemantic } from './local-semantic';
import type { HarnessSettingsPageProps } from './harness-settings-state';

type LocalSemanticState = {
  status: LocalSemanticStatus | null;
  error: string | null;
  busy: boolean;
  refresh: () => void;
  run: (action: () => Promise<void>, startsInstall?: boolean) => void;
};

function formatBytes(value: number | undefined): string {
  if (!Number.isFinite(value) || value === undefined || value < 0) return '—';
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB'] as const;
  let amount = value;
  let unit: typeof units[number] = units[0];
  for (const next of units) {
    amount /= 1024;
    unit = next;
    if (amount < 1024 || next === units[units.length - 1]) break;
  }
  return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

function useLocalSemantic(): LocalSemanticState {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<LocalSemanticStatus | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const mounted = React.useRef(false);
  const generation = React.useRef(0);
  const request = React.useRef<AbortController | null>(null);

  const read = React.useCallback(async (expectedGeneration: number) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const next = await getLocalSemanticStatus(controller.signal);
      if (!controller.signal.aborted && mounted.current && expectedGeneration === generation.current) {
        setStatus(next);
        setError(null);
      }
    } catch (failure) {
      if (!controller.signal.aborted && mounted.current && expectedGeneration === generation.current) {
        setError(failure instanceof Error && failure.message ? failure.message : t('settings.page.harness.localSemantic.requestFailed'));
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [t]);

  React.useEffect(() => {
    mounted.current = true;
    const expectedGeneration = ++generation.current;
    void read(expectedGeneration);
    return () => {
      mounted.current = false;
      request.current?.abort();
      request.current = null;
      generation.current += 1;
    };
  }, [read]);

  React.useEffect(() => {
    if (status?.status !== 'installing' || busy) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await read(generation.current);
      if (!cancelled && mounted.current) timer = setTimeout(() => { void poll(); }, 1500);
    };
    timer = setTimeout(() => { void poll(); }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [busy, read, status?.status]);

  const refresh = React.useCallback(() => {
    request.current?.abort();
    const expectedGeneration = ++generation.current;
    setError(null);
    void read(expectedGeneration);
  }, [read]);

  const run = React.useCallback((action: () => Promise<void>, startsInstall = false) => {
    request.current?.abort();
    const expectedGeneration = ++generation.current;
    const previous = status;
    setBusy(true);
    setError(null);
    if (startsInstall) setStatus({ status: 'installing', stage: 'downloading' });
    void (async () => {
      try {
        await action();
        if (!mounted.current || expectedGeneration !== generation.current) return;
        await read(expectedGeneration);
      } catch (failure) {
        if (!mounted.current || expectedGeneration !== generation.current) return;
        setStatus(previous);
        setError(failure instanceof Error && failure.message ? failure.message : t('settings.page.harness.localSemantic.requestFailed'));
      } finally {
        if (mounted.current && expectedGeneration === generation.current) setBusy(false);
      }
    })();
  }, [read, status, t]);

  return { status, error, busy, refresh, run };
}

function LocalSemanticSettings({ state }: { state: LocalSemanticState }) {
  const { t } = useI18n();
  const fileInput = React.useRef<HTMLInputElement | null>(null);
  const status = state.status;
  const installing = status?.status === 'installing';
  const canInstall = status?.status === 'not-installed' || status?.status === 'failed' || (status?.status === 'ready' && Boolean(status.error));
  const statusLabel = status === null
    ? (state.error ? t('settings.page.harness.localSemantic.status.unknown') : t('common.loading'))
    : status.status === 'ready'
    ? t('settings.page.harness.localSemantic.status.ready')
    : status.status === 'installing'
      ? t('settings.page.harness.localSemantic.status.installing')
      : status.status === 'failed'
        ? t('settings.page.harness.localSemantic.status.failed')
        : t('settings.page.harness.localSemantic.status.notInstalled');
  const progress = installing && status.downloadedBytes !== undefined
    ? t('settings.page.harness.localSemantic.progress', {
      downloaded: formatBytes(status.downloadedBytes), total: formatBytes(status.totalBytes),
    })
    : null;
  const stage = installing && status.stage === 'downloading'
    ? t('settings.page.harness.localSemantic.stage.downloading')
    : installing && status.stage === 'extracting'
      ? t('settings.page.harness.localSemantic.stage.extracting')
      : installing && status.stage === 'verifying'
        ? t('settings.page.harness.localSemantic.stage.verifying')
        : null;

  return <SettingsSection title={t('settings.page.harness.localSemantic.title')}
    description={t('settings.page.harness.localSemantic.description')} settingsItem="harness.localSemantic">
    <SettingsFieldRow label={t('settings.page.harness.localSemantic.status.label')}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span role="status" className="typography-meta text-muted-foreground">
          {statusLabel}{status?.version ? ` · ${status.version}` : ''}
        </span>
        {stage ? <span className="typography-meta text-muted-foreground">{stage}</span> : null}
        {progress ? <span className="typography-meta tabular-nums text-muted-foreground">{progress}</span> : null}
      </div>
    </SettingsFieldRow>
    {status?.error ? <p role="alert" className="typography-meta text-destructive">{status.error}</p> : null}
    {state.error ? <div role="alert" className="flex flex-wrap items-center gap-2 typography-meta text-destructive">
      <span>{state.error}</span><Button size="sm" variant="ghost" disabled={state.busy} onClick={state.refresh}>{t('settings.page.harness.localSemantic.retry')}</Button>
    </div> : null}
    <div className="flex flex-wrap items-center gap-2">
      {canInstall ? <Button size="sm" variant="outline" disabled={state.busy} onClick={() => state.run(installLocalSemantic, true)}>
        {status?.error ? t('settings.page.harness.localSemantic.retry') : t('settings.page.harness.localSemantic.install')}
      </Button> : null}
      <Button size="sm" variant="outline" disabled={state.busy || installing} onClick={() => fileInput.current?.click()}>
        {t('settings.page.harness.localSemantic.import')}
      </Button>
      {installing ? <Button size="sm" variant="ghost" disabled={state.busy} onClick={() => state.run(cancelLocalSemantic)}>
        {t('settings.page.harness.localSemantic.cancel')}
      </Button> : null}
      <input ref={fileInput} type="file" className="sr-only" accept=".tar.gz,.tgz,application/gzip,application/x-gzip" disabled={state.busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) state.run(() => importLocalSemantic(file), true);
        }} />
    </div>
  </SettingsSection>;
}

function InferenceSettings({ harness, update, kind, localSemanticStatus }: HarnessSettingsPageProps & { kind: 'embedding' | 'rerank'; localSemanticStatus: LocalSemanticStatus | null }) {
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
  const defaultLabel = kind === 'embedding'
    ? t(localSemanticStatus?.installedBytes !== undefined ? 'settings.harness.retrieval.local' : 'settings.harness.retrieval.localUnavailable')
    : t('settings.harness.retrieval.off');
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
  const localSemantic = useLocalSemantic();
  React.useEffect(() => { void load(cwd).catch(() => undefined); }, [cwd, load]);
  return <>
    {error ? <p role="alert" className="typography-meta text-destructive">{String(error)}</p> : null}
    <LocalSemanticSettings state={localSemantic} />
    <InferenceSettings {...props} kind="embedding" localSemanticStatus={localSemantic.status} />
    <InferenceSettings {...props} kind="rerank" localSemanticStatus={localSemantic.status} />
  </>;
}
