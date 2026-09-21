import React from 'react';
import type {
  LanguageSupportLanguageRow,
  LanguageSupportStatus,
  VarinLanguageProviderStatus,
} from '@varin/application-client';
import { LanguageSupportError } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_HELPER_CLASS,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { requestFileAccess } from '@/lib/desktop';
import { useWorkbenchWorkspace } from '@/lib/extensions/workbench-workspace';
import { useI18n, type I18nKey } from '@/lib/i18n';
import {
  canImportGrammar,
  canInstallGrammar,
  formatPackBytes,
  grammarStatusKey,
  grammarStatusTone,
  languageServerStatusKey,
  languageServerStatusTone,
  languageDisplayName,
  serverAvailabilityKey,
  statusToneClass,
  structureNoteKey,
} from './presentation';

const StatusValue: React.FC<{ tone: ReturnType<typeof grammarStatusTone>; label: string }> = ({
  tone,
  label,
}) => (
  <span className={`typography-micro ${statusToneClass(tone)}`}>{label}</span>
);

const LanguageRow: React.FC<{
  busy: boolean;
  languageServerStatus?: VarinLanguageProviderStatus;
  preparing: boolean;
  onPrepare(): void;
  onCancelPreparation(): void;
  onCancel(): void;
  onImport(): void;
  onInstall(): void;
  row: LanguageSupportLanguageRow;
}> = ({ busy, preparing, languageServerStatus, onPrepare, onCancelPreparation, onCancel, onImport, onInstall, row }) => {
  const { t } = useI18n();
  const lspStatus = languageServerStatus?.status ?? 'absent';
  const server = row.server;
  const serverFailure = lspStatus === 'failed' || lspStatus === 'degraded' || server?.status === 'failed' || server?.status === 'needs-runtime';
  const serverMessage = languageServerStatus && 'message' in languageServerStatus ? languageServerStatus.message : server?.message;
  const availability = server?.status ?? 'unsupported';
  const serverLabel = preparing ? t('settings.languageSupport.server.preparing')
    : lspStatus === 'absent' ? t(serverAvailabilityKey(availability)) : t(languageServerStatusKey(lspStatus));
  const serverTone = preparing ? 'warning' : lspStatus !== 'absent' ? languageServerStatusTone(lspStatus)
    : serverFailure ? 'warning' : availability === 'bundled' || availability === 'installed' ? 'success' : 'muted';
  const noteKey = structureNoteKey(row);
  const capabilityKeys: I18nKey[] = [];
  if (row.capabilities.outline) capabilityKeys.push('settings.languageSupport.capability.outline');
  if (row.capabilities.classifyHits) capabilityKeys.push('settings.languageSupport.capability.classifyHits');
  if (row.capabilities.literalCalls) capabilityKeys.push('settings.languageSupport.capability.literalCalls');
  if (row.capabilities.imports) capabilityKeys.push('settings.languageSupport.capability.imports');

  return (
    <div className="py-4" data-settings-item={`language-support.language.${row.languageId}`}>
      <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Icon name="code-box" className="size-4 text-muted-foreground" />
            <span className="typography-ui-label text-foreground">{languageDisplayName(row.languageId)}</span>
            <span className={SETTINGS_HELPER_CLASS}>
              {t('settings.languageSupport.files.count', { count: row.fileCount })}
            </span>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1" data-settings-item={`language-support.grammar.${row.languageId}`}>
            <span className={SETTINGS_HELPER_CLASS}>{t('settings.languageSupport.row.structurePack')}</span>
            <StatusValue
              tone={grammarStatusTone(row.grammarStatus, row.capabilities)}
              label={t(grammarStatusKey(row.grammarStatus))}
            />
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1" data-settings-item={`language-support.lsp.${row.languageId}`}>
            <span className={SETTINGS_HELPER_CLASS}>{t('settings.languageSupport.row.languageServer')}</span>
            <StatusValue tone={serverTone} label={serverLabel} />
          </div>
          {serverFailure && serverMessage ? <p className="typography-micro break-words text-[var(--status-warning)]">{serverMessage}</p> : null}
          {noteKey ? (
            <p className="typography-micro text-[var(--status-warning)]">{t(noteKey)}</p>
          ) : null}
          <details className="group typography-micro text-muted-foreground">
            <summary className="w-fit cursor-pointer rounded-sm hover:text-foreground focus-visible:outline focus-visible:outline-ring">{t('settings.languageSupport.details')}</summary>
            <div className="space-y-2 pt-2">
              {capabilityKeys.length > 0 ? <p>{capabilityKeys.map((key) => t(key)).join(' · ')}</p> : null}
              {server?.name ? <p>{server.name}</p> : null}
              {row.pack ? <p>{row.pack.packageName} · {row.pack.version} · {formatPackBytes(row.pack.bytes)} · {t('settings.languageSupport.field.abi', { abi: row.pack.abi })}</p> : null}
              {canImportGrammar(row.grammarStatus) && !busy ? (
                <Button type="button" variant="outline" size="xs" onClick={onImport} className="!font-normal">{t('settings.languageSupport.actions.import')}</Button>
              ) : null}
            </div>
          </details>
        </div>
        {canInstallGrammar(row.grammarStatus) || serverFailure || availability === 'available' || preparing ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {serverFailure || availability === 'available' || preparing ? (
              <Button type="button" variant="outline" size="xs" disabled={preparing} onClick={onPrepare} className="!font-normal">
                {preparing ? t('settings.languageSupport.server.preparing') : serverFailure ? t('settings.languageSupport.actions.retry') : t('settings.languageSupport.actions.prepare')}
              </Button>
            ) : null}
            {preparing && lspStatus === 'absent' ? <Button type="button" variant="ghost" size="xs" onClick={onCancelPreparation}>{t('settings.languageSupport.actions.cancel')}</Button> : null}
            {busy ? (
              <Button type="button" variant="outline" size="xs" onClick={onCancel} className="!font-normal">
                {t('settings.languageSupport.actions.cancel')}
              </Button>
            ) : canInstallGrammar(row.grammarStatus) ? (
              <Button type="button" variant="outline" size="xs" onClick={onInstall} className="!font-normal">
                {t('settings.languageSupport.actions.install')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export const LanguageSupportPage: React.FC = () => {
  const { t } = useI18n();
  const { language, languageSupport } = useRuntimeAPIs();
  const workspace = useWorkbenchWorkspace();
  const workspaceId = workspace.status === 'ready' ? workspace.workspaceId : null;
  const [status, setStatus] = React.useState<LanguageSupportStatus | null>(null);
  const [lspByLanguage, setLspByLanguage] = React.useState<
    Partial<Record<string, VarinLanguageProviderStatus>>
  >({});
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [preparingIds, setPreparingIds] = React.useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = React.useState(false);
  const refreshId = React.useRef(0);
  const invalidateRefresh = React.useCallback(() => { refreshId.current++; }, []);
  const currentWorkspace = React.useRef(workspaceId);
  currentWorkspace.current = workspaceId;

  const refresh = React.useCallback(async () => {
    const requestId = ++refreshId.current;
    if (!workspaceId) {
      setStatus(null);
      setLspByLanguage({});
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await languageSupport.getStatus({ workspaceId });
      if (requestId !== refreshId.current || currentWorkspace.current !== workspaceId) return;
      setStatus(next);
      const snapshots = await Promise.all(next.languages.map(async (row) => {
        const snapshot = await language.getStatus(workspaceId, row.languageId);
        return [row.languageId, snapshot] as const;
      }));
      if (requestId !== refreshId.current || currentWorkspace.current !== workspaceId) return;
      setLspByLanguage(Object.fromEntries(snapshots));
    } catch (error) {
      if (requestId !== refreshId.current || currentWorkspace.current !== workspaceId) return;
      toast.error(error instanceof LanguageSupportError
        ? error.message
        : error instanceof Error ? error.message : t('settings.languageSupport.empty.none'));
    } finally {
      if (requestId === refreshId.current) setLoading(false);
    }
  }, [language, languageSupport, t, workspaceId]);

  React.useEffect(() => {
    setStatus(null);
    setLspByLanguage({});
    setPreparingIds(new Set());
    void refresh();
    return invalidateRefresh;
  }, [refresh, invalidateRefresh]);

  React.useEffect(() => {
    if (!workspaceId) return;
    const subscription = language.subscribe(workspaceId, (event) => {
      if (event.kind === 'status') setLspByLanguage((previous) => ({ ...previous, [event.snapshot.languageId]: event.snapshot }));
    });
    return () => subscription.close();
  }, [language, workspaceId]);

  const runPrepare = React.useCallback(async (languageId: string, silent = false) => {
    if (!workspaceId) return;
    setPreparingIds((previous) => new Set([...previous, languageId]));
    try {
      const running = lspByLanguage[languageId]?.status;
      if (running === 'failed' || running === 'degraded') await language.restart(workspaceId, languageId);
      else await languageSupport.prepareServer({ workspaceId, languageId });
    } catch (error) {
      if (!silent && currentWorkspace.current === workspaceId) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (currentWorkspace.current === workspaceId) {
        setPreparingIds((previous) => { const next = new Set(previous); next.delete(languageId); return next; });
        await refresh();
      }
    }
  }, [language, languageSupport, lspByLanguage, refresh, workspaceId]);

  // Native servers are prepared in the background for languages that are
  // actually present in the workspace. Opening this page must not be a
  // prerequisite for using them; the runtime also prepares on first request.
  // Keep one preflight per workspace/server so aliases such as C and C++ do
  // not start duplicate downloads or duplicate error toasts.
  const autoPreparedServers = React.useRef(new Set<string>());
  React.useEffect(() => {
    if (!workspaceId || !status) return;
    for (const row of status.languages) {
      if (row.fileCount === 0 || row.server?.status !== 'available') continue;
      const serverKey = row.server.name ?? row.languageId;
      const key = `${workspaceId}:${serverKey}`;
      if (autoPreparedServers.current.has(key)) continue;
      autoPreparedServers.current.add(key);
      void runPrepare(row.languageId, true);
    }
  }, [runPrepare, status, workspaceId]);

  const cancelPreparation = React.useCallback(async (languageId: string) => {
    if (!workspaceId) return;
    try { await languageSupport.cancelServerPreparation({ workspaceId, languageId }); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
  }, [languageSupport, workspaceId]);

  const runInstall = React.useCallback(async (languageId: string) => {
    setBusyId(languageId);
    try {
      const result = await languageSupport.install({ languageId });
      if (result.status === 'failed') {
        toast.error(result.message);
        return;
      }
      if (result.status === 'cancelled') {
        toast.error(t('settings.languageSupport.actions.cancel'));
        return;
      }
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.languageSupport.empty.none'));
    } finally {
      setBusyId(null);
    }
  }, [languageSupport, refresh, t]);

  const runImport = React.useCallback(async (languageId: string) => {
    const picked = await requestFileAccess({
      filters: [{ name: 'WebAssembly', extensions: ['wasm'] }],
    });
    if (!picked.success || !picked.path) {
      if (picked.error && picked.error !== 'File selection cancelled') {
        toast.error(picked.error);
      }
      return;
    }
    setBusyId(languageId);
    try {
      const result = await languageSupport.importUserGrammar({ languageId, path: picked.path });
      if (result.status === 'failed') {
        toast.error(result.message);
        return;
      }
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.languageSupport.empty.none'));
    } finally {
      setBusyId(null);
    }
  }, [languageSupport, refresh, t]);

  const runCancel = React.useCallback(async (languageId: string) => {
    try {
      await languageSupport.cancelInstall({ languageId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.languageSupport.empty.none'));
    } finally {
      setBusyId(null);
      await refresh();
    }
  }, [languageSupport, refresh, t]);

  return (
    <SettingsPageLayout
      title={t('settings.page.languageSupport.title')}
      description={t('settings.page.languageSupport.description')}
    >
      <SettingsSection
        title={t('settings.languageSupport.section.workspace')}
        divider={false}
        settingsItem="language-support.workspace"
        headerAction={(
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={loading || workspace.status !== 'ready'}
            onClick={() => void refresh()}
            className="!font-normal gap-1.5"
          >
            <Icon name="refresh" className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
            {t('settings.languageSupport.actions.refresh')}
          </Button>
        )}
      >
        {workspace.status === 'none' ? (
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.languageSupport.empty.noWorkspace')}</p>
        ) : null}
        {workspace.status === 'loading' ? (
          <p className={SETTINGS_HELPER_CLASS}>{t('common.loading')}</p>
        ) : null}
        {workspace.status === 'error' ? (
          <div className="space-y-2">
            <p className="typography-micro text-[var(--status-error)]">{workspace.errorMessage}</p>
            <Button type="button" variant="outline" size="xs" onClick={workspace.retry} className="!font-normal">
              {t('settings.languageSupport.actions.refresh')}
            </Button>
          </div>
        ) : null}
        {workspace.status === 'ready' && status?.grammarStore === 'unreadable' ? (
          <p className="typography-micro text-[var(--status-error)]">
            {t('settings.languageSupport.storeUnreadable')}
          </p>
        ) : null}
        {workspace.status === 'ready' && status?.partial ? (
          <p className="typography-micro text-[var(--status-warning)]">
            {t('settings.languageSupport.partial', { limit: status.fileLimit })}
          </p>
        ) : null}
        {workspace.status === 'ready' && status && status.languages.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 px-4 py-8 text-center typography-ui text-muted-foreground">
            {t('settings.languageSupport.empty.none')}
          </div>
        ) : null}
        <div className="divide-y divide-border/50">
          {status?.languages.map((row) => (
            <LanguageRow
              key={row.languageId}
              row={row}
              busy={busyId === row.languageId}
              languageServerStatus={lspByLanguage[row.languageId]}
              preparing={preparingIds.has(row.languageId)}
              onPrepare={() => void runPrepare(row.languageId)}
              onCancelPreparation={() => void cancelPreparation(row.languageId)}
              onInstall={() => void runInstall(row.languageId)}
              onImport={() => void runImport(row.languageId)}
              onCancel={() => void runCancel(row.languageId)}
            />
          ))}
        </div>
      </SettingsSection>
    </SettingsPageLayout>
  );
};
