import React from 'react';
import type {
  LanguageSupportLanguageRow,
  LanguageSupportStatus,
  PiariumLanguageProviderStatus,
} from '@piarium/application-client';
import { LanguageSupportError } from '@piarium/application-client';
import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_HELPER_CLASS,
  SettingsFieldRow,
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
  languageServerStatus?: PiariumLanguageProviderStatus['status'];
  onCancel(): void;
  onImport(): void;
  onInstall(): void;
  row: LanguageSupportLanguageRow;
}> = ({ busy, languageServerStatus, onCancel, onImport, onInstall, row }) => {
  const { t } = useI18n();
  const lspStatus = languageServerStatus ?? 'absent';
  const noteKey = structureNoteKey(row);
  const capabilityKeys: I18nKey[] = [];
  if (row.capabilities.outline) capabilityKeys.push('settings.languageSupport.capability.outline');
  if (row.capabilities.classifyHits) capabilityKeys.push('settings.languageSupport.capability.classifyHits');
  if (row.capabilities.literalCalls) capabilityKeys.push('settings.languageSupport.capability.literalCalls');
  if (row.capabilities.imports) capabilityKeys.push('settings.languageSupport.capability.imports');

  return (
    <div className="rounded-lg border border-border/60 px-3 py-3">
      <div className="flex flex-col gap-3 @xl:flex-row @xl:items-start @xl:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Icon name="code-box" className="size-4 text-muted-foreground" />
            <span className="typography-ui-label text-foreground">{row.languageId}</span>
            {row.wanted ? (
              <span className="rounded-md bg-primary/10 px-1.5 py-0.5 typography-micro text-primary">
                {t('settings.languageSupport.detected')}
              </span>
            ) : null}
            <span className={SETTINGS_HELPER_CLASS}>
              {t('settings.languageSupport.files.count', { count: row.fileCount })}
            </span>
            {row.pack ? (
              <span className={SETTINGS_HELPER_CLASS}>
                {t('settings.languageSupport.field.abi', { abi: row.pack.abi })}
                {' · '}
                {formatPackBytes(row.pack.bytes)}
              </span>
            ) : null}
          </div>
          <SettingsFieldRow
            label={t('settings.languageSupport.row.languageServer')}
            settingsItem={`language-support.lsp.${row.languageId}`}
          >
            <StatusValue tone={languageServerStatusTone(lspStatus)} label={t(languageServerStatusKey(lspStatus))} />
          </SettingsFieldRow>
          <SettingsFieldRow
            label={t('settings.languageSupport.row.structurePack')}
            settingsItem={`language-support.grammar.${row.languageId}`}
          >
            <StatusValue
              tone={grammarStatusTone(row.grammarStatus, row.capabilities)}
              label={t(grammarStatusKey(row.grammarStatus))}
            />
          </SettingsFieldRow>
          {capabilityKeys.length > 0 ? (
            <p className={SETTINGS_HELPER_CLASS}>
              {capabilityKeys.map((key) => t(key)).join(' · ')}
            </p>
          ) : null}
          {noteKey ? (
            <p className="typography-micro text-[var(--status-warning)]">{t(noteKey)}</p>
          ) : null}
        </div>
        {canInstallGrammar(row.grammarStatus) || canImportGrammar(row.grammarStatus) ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {busy ? (
              <Button type="button" variant="outline" size="xs" onClick={onCancel} className="!font-normal">
                {t('settings.languageSupport.actions.cancel')}
              </Button>
            ) : canInstallGrammar(row.grammarStatus) ? (
              <Button type="button" variant="outline" size="xs" onClick={onInstall} className="!font-normal">
                {t('settings.languageSupport.actions.install')}
              </Button>
            ) : null}
            {canImportGrammar(row.grammarStatus) && !busy ? (
              <Button type="button" variant="outline" size="xs" onClick={onImport} className="!font-normal">
                {t('settings.languageSupport.actions.import')}
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
  const [status, setStatus] = React.useState<LanguageSupportStatus | null>(null);
  const [lspByLanguage, setLspByLanguage] = React.useState<
    Partial<Record<string, PiariumLanguageProviderStatus['status']>>
  >({});
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const refresh = React.useCallback(async () => {
    if (workspace.status !== 'ready') {
      setStatus(null);
      setLspByLanguage({});
      return;
    }
    setLoading(true);
    try {
      const next = await languageSupport.getStatus({ workspaceId: workspace.workspaceId });
      setStatus(next);
      const snapshots = await Promise.all(next.languages.map(async (row) => {
        const snapshot = await language.getStatus(workspace.workspaceId, row.languageId);
        return [row.languageId, snapshot.status] as const;
      }));
      setLspByLanguage(Object.fromEntries(snapshots));
    } catch (error) {
      toast.error(error instanceof LanguageSupportError
        ? error.message
        : error instanceof Error ? error.message : t('settings.languageSupport.empty.none'));
    } finally {
      setLoading(false);
    }
  }, [language, languageSupport, t, workspace]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

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
        <div className="space-y-3">
          {status?.languages.map((row) => (
            <LanguageRow
              key={row.languageId}
              row={row}
              busy={busyId === row.languageId}
              languageServerStatus={lspByLanguage[row.languageId]}
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
