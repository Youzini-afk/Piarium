import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_HELPER_CLASS,
  SettingsFieldRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useWorkbenchWorkspace } from '@/lib/extensions/workbench-workspace';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { subscribePiariumEvents } from '@/lib/piariumEvents';
import {
  loadKnowledgeCatalog,
  loadKnowledgeChain,
  retireKnowledgeCatalogItem,
  reviewKnowledgeCatalogItem,
  saveKnowledgeCatalogItem,
  type KnowledgeCatalogChain,
  type KnowledgeCatalogItem,
  type KnowledgeCatalogScope,
} from './knowledgeCatalogRequest';

const statusKey = (item: KnowledgeCatalogItem): I18nKey => (
  item.invalidAt !== undefined
    ? 'settings.knowledge.status.retired'
    : `settings.knowledge.status.${item.status}`
);

export const KnowledgeSettingsPage: React.FC = () => {
  const { t } = useI18n();
  const workspace = useWorkbenchWorkspace();
  const [scope, setScope] = React.useState<KnowledgeCatalogScope>('workspace');
  const [showRetired, setShowRetired] = React.useState(false);
  const [items, setItems] = React.useState<KnowledgeCatalogItem[]>([]);
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [chain, setChain] = React.useState<KnowledgeCatalogChain | null>(null);
  const [draft, setDraft] = React.useState({ content: '', trigger: '' });
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  const workspaceId = workspace.status === 'ready' ? workspace.workspaceId : undefined;
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const visible = items.filter((item) => showRetired || item.invalidAt === undefined);

  const refresh = React.useCallback(async (signal?: AbortSignal) => {
    if (scope === 'workspace' && workspace.status !== 'ready') {
      setItems([]);
      setChain(null);
      return;
    }
    setLoading(true);
    try {
      const next = await loadKnowledgeCatalog(scope, workspaceId, signal);
      if (signal?.aborted) return;
      setItems(next);
      setSelectedId((current) => current && next.some((item) => item.id === current) ? current : next[0]?.id ?? null);
    } catch (error) {
      if (!signal?.aborted) toast.error(error instanceof Error ? error.message : t('settings.knowledge.empty.none'));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [scope, t, workspace.status, workspaceId]);

  React.useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const unsubscribe = subscribePiariumEvents((event) => {
      if (event.type !== 'harness-knowledge-changed') return;
      if (event.scope !== scope) return;
      if (scope === 'workspace' && event.workspaceId && workspaceId && event.workspaceId !== workspaceId) return;
      void refresh(controller.signal);
    });
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [refresh, scope, workspaceId]);

  React.useEffect(() => {
    if (!selected) {
      setDraft({ content: '', trigger: '' });
      setChain(null);
      return;
    }
    setDraft({ content: selected.content, trigger: selected.trigger });
    const controller = new AbortController();
    void loadKnowledgeChain(selected.scope, selected.id, workspaceId, controller.signal).then((next) => {
      if (!controller.signal.aborted) setChain(next);
    }).catch(() => {
      if (!controller.signal.aborted) setChain(null);
    });
    return () => controller.abort();
  }, [selected, workspaceId]);

  const run = React.useCallback(async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await operation();
      await refresh();
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'conflict') {
        toast.error(t('harness.knowledge.conflict'));
        await refresh();
      } else {
        toast.error(error instanceof Error ? error.message : t('settings.knowledge.empty.none'));
      }
    } finally {
      setBusy(false);
    }
  }, [busy, refresh, t]);

  return (
    <SettingsPageLayout
      title={t('settings.page.knowledge.title')}
      description={t('settings.page.knowledge.description')}
    >
      <SettingsSection
        title={t(scope === 'workspace' ? 'settings.knowledge.section.workspace' : 'settings.knowledge.section.user')}
        divider={false}
        settingsItem={scope === 'workspace' ? 'knowledge.workspace' : 'knowledge.user'}
        headerAction={(
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant={scope === 'workspace' ? 'secondary' : 'ghost'} size="xs" className="!font-normal" onClick={() => setScope('workspace')}>
              {t('harness.knowledge.scope.workspace')}
            </Button>
            <Button type="button" variant={scope === 'user' ? 'secondary' : 'ghost'} size="xs" className="!font-normal" onClick={() => setScope('user')}>
              {t('harness.knowledge.scope.user')}
            </Button>
            <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => setShowRetired((value) => !value)}>
              {t(showRetired ? 'settings.knowledge.filter.all' : 'settings.knowledge.filter.current')}
            </Button>
            <Button type="button" variant="ghost" size="xs" disabled={loading} onClick={() => void refresh()} className="!font-normal gap-1.5">
              <Icon name="refresh" className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
              {t('settings.languageSupport.actions.refresh')}
            </Button>
          </div>
        )}
      >
        {scope === 'workspace' && workspace.status === 'none' ? (
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.knowledge.empty.noWorkspace')}</p>
        ) : null}
        {scope === 'workspace' && workspace.status === 'error' ? (
          <p className="typography-micro text-[var(--status-error)]">{workspace.errorMessage}</p>
        ) : null}
        {visible.length === 0 && (scope === 'user' || workspace.status === 'ready') ? (
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.knowledge.empty.none')}</p>
        ) : null}
        <div className="grid gap-3 @xl:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
          <div className="space-y-2">
            {visible.map((item) => (
              <button
                key={`${item.scope}:${item.id}`}
                type="button"
                onClick={() => setSelectedId(item.id)}
                className={`w-full rounded-lg border px-3 py-2 text-left ${selectedId === item.id ? 'border-primary bg-primary/5' : 'border-border/60'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="typography-micro text-muted-foreground">#{item.id}</span>
                  <span className="typography-micro text-muted-foreground">{t(statusKey(item))}</span>
                </div>
                <p className="mt-1 line-clamp-2 typography-ui text-foreground">{item.content}</p>
              </button>
            ))}
          </div>
          {selected ? (
            <div className="space-y-3 rounded-lg border border-border/60 px-3 py-3">
              <SettingsFieldRow label={t('harness.knowledge.content')}>
                <textarea
                  value={draft.content}
                  aria-label={t('harness.knowledge.content')}
                  disabled={busy || selected.invalidAt !== undefined || selected.status === 'dismissed'}
                  onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
                  className="min-h-24 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 typography-ui text-foreground"
                />
              </SettingsFieldRow>
              <SettingsFieldRow label={t('harness.knowledge.trigger')}>
                <input
                  value={draft.trigger}
                  aria-label={t('harness.knowledge.trigger')}
                  disabled={busy || selected.invalidAt !== undefined || selected.status === 'dismissed'}
                  onChange={(event) => setDraft((current) => ({ ...current, trigger: event.target.value }))}
                  className="w-full rounded-md border border-border bg-background px-2 py-1 typography-ui text-foreground"
                />
              </SettingsFieldRow>
              <p className={SETTINGS_HELPER_CLASS}>
                {t('settings.knowledge.source')}: {selected.source
                  ? `${selected.source.kind} · ${selected.source.sessionId}`
                  : t('settings.knowledge.source.none')}
              </p>
              <p className={SETTINGS_HELPER_CLASS}>
                {t('settings.knowledge.recallCount', { count: selected.recallCount })}
                {' · '}
                {selected.recalledAt
                  ? t('settings.knowledge.recalledAt', { at: String(selected.recalledAt) })
                  : t('settings.knowledge.neverRecalled')}
              </p>
              <div className="flex flex-wrap gap-2">
                {selected.status !== 'dismissed' && selected.invalidAt === undefined ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={busy || !draft.content.trim()}
                    onClick={() => void run(async () => {
                      if (!draft.content.trim()) throw new Error(t('harness.knowledge.contentRequired'));
                      await saveKnowledgeCatalogItem(selected, draft, workspaceId);
                    })}
                  >
                    {t('harness.knowledge.save')}
                  </Button>
                ) : null}
                {selected.status === 'suggested' && selected.invalidAt === undefined ? (
                  <>
                    <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => void run(() => reviewKnowledgeCatalogItem(selected, 'dismiss', workspaceId))}>
                      {t('harness.knowledge.dismiss')}
                    </Button>
                    <Button type="button" size="xs" disabled={busy} onClick={() => void run(() => reviewKnowledgeCatalogItem(selected, 'accept', workspaceId))}>
                      {t('harness.knowledge.accept')}
                    </Button>
                  </>
                ) : null}
                {selected.invalidAt === undefined ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(t('settings.knowledge.deleteConfirm'))) return;
                      void run(() => retireKnowledgeCatalogItem(selected, workspaceId));
                    }}
                  >
                    {t('settings.knowledge.delete')}
                  </Button>
                ) : null}
              </div>
              <div>
                <h4 className="typography-ui-label text-muted-foreground">{t('settings.knowledge.chain')}</h4>
                {chain && chain.chain.length > 1 ? (
                  <ol className="mt-2 space-y-1">
                    {chain.chain.map((item) => (
                      <li key={item.id} className={SETTINGS_HELPER_CLASS}>
                        #{item.id} {item.content}
                        {item.invalidAt !== undefined ? ` · ${t('settings.knowledge.status.retired')}` : ''}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className={SETTINGS_HELPER_CLASS}>{t('settings.knowledge.chain.empty')}</p>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </SettingsSection>
    </SettingsPageLayout>
  );
};
