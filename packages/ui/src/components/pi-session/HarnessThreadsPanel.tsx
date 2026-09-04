import React from 'react';
import { runtimeFetch } from '@piarium/application-client';
import type { ThreadParent } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { subscribePiariumEvents } from '@/lib/piariumEvents';
import { cn } from '@/lib/utils';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import {
  parseHarnessThreadList,
  projectHarnessThreadState,
  type HarnessThreadSnapshot,
  type HarnessThreadState,
} from './harnessThreadPresentation';
import { parseHarnessSessionBlocks, type HarnessSessionBlock } from './harnessBlockPresentation';

const stateKey: Record<HarnessThreadState, `harness.threads.state.${HarnessThreadState}`> = {
  queued: 'harness.threads.state.queued',
  starting: 'harness.threads.state.starting',
  running: 'harness.threads.state.running',
  waiting: 'harness.threads.state.waiting',
  stalled: 'harness.threads.state.stalled',
  looping: 'harness.threads.state.looping',
  completed: 'harness.threads.state.completed',
  failed: 'harness.threads.state.failed',
  cancelled: 'harness.threads.state.cancelled',
  interrupted: 'harness.threads.state.interrupted',
  'merge-ready': 'harness.threads.state.merge-ready',
  conflict: 'harness.threads.state.conflict',
  merged: 'harness.threads.state.merged',
};

const stateTone: Record<HarnessThreadState, string> = {
  queued: 'bg-muted-foreground/50',
  starting: 'bg-[var(--status-info)]',
  running: 'bg-[var(--status-info)]',
  waiting: 'bg-[var(--status-warning)]',
  stalled: 'bg-[var(--status-warning)]',
  looping: 'bg-[var(--status-warning)]',
  completed: 'bg-[var(--status-success)]',
  failed: 'bg-[var(--status-error)]',
  cancelled: 'bg-muted-foreground/50',
  interrupted: 'bg-[var(--status-error)]',
  'merge-ready': 'bg-[var(--status-success)]',
  conflict: 'bg-[var(--status-error)]',
  merged: 'bg-[var(--status-success)]',
};

const scopeMatches = (left: ThreadParent, right: ThreadParent): boolean => (
  left.kind === right.kind && left.id === right.id
);

const mergeSnapshot = (
  current: HarnessThreadSnapshot[],
  incoming: HarnessThreadSnapshot,
): HarnessThreadSnapshot[] => {
  const existing = current.find((entry) => entry.thread.id === incoming.thread.id);
  if (existing && existing.thread.eventSeq > incoming.thread.eventSeq) return current;
  const next = current.filter((entry) => entry.thread.id !== incoming.thread.id);
  if (!incoming.thread.hidden && incoming.thread.lifecycle !== 'archived') next.push(incoming);
  return next.sort((left, right) => right.thread.updatedAt.localeCompare(left.thread.updatedAt));
};

export const HarnessThreadsPanel: React.FC<{
  workspaceId: string;
  parentSessionId: string;
  fallbackCwd?: string;
}> = ({ workspaceId, parentSessionId, fallbackCwd }) => {
  const { t } = useI18n();
  const openSession = usePiSessionStore((state) => state.openSession);
  const [threads, setThreads] = React.useState<HarnessThreadSnapshot[]>([]);
  const [blocks, setBlocks] = React.useState<HarnessSessionBlock[]>([]);
  const [editingBlock, setEditingBlock] = React.useState<string | null>(null);
  const [blockDraft, setBlockDraft] = React.useState('');
  const [savingBlock, setSavingBlock] = React.useState(false);
  const eventRevision = React.useRef(0);
  const parent = React.useMemo<ThreadParent>(() => ({ kind: 'session', id: parentSessionId }), [parentSessionId]);

  const reload = React.useCallback(async (signal?: AbortSignal) => {
    const revisionAtStart = eventRevision.current;
    const query = new URLSearchParams({ workspaceId, parentId: parent.id, parentKind: parent.kind });
    const response = await runtimeFetch(`/api/harness/threads?${query.toString()}`, {
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      if (response.status === 404) return;
      throw new Error(`Unable to load threads (${response.status})`);
    }
    const incoming = parseHarnessThreadList(await response.json());
    setThreads((current) => {
      if (eventRevision.current === revisionAtStart) return incoming;
      return incoming.reduce(mergeSnapshot, current);
    });
  }, [parent, workspaceId]);

  const reloadBlocks = React.useCallback(async (signal?: AbortSignal) => {
    const response = await runtimeFetch(`/api/harness/sessions/${encodeURIComponent(parentSessionId)}/blocks`, {
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      if (response.status === 404) {
        setBlocks([]);
        return;
      }
      throw new Error(`Unable to load session blocks (${response.status})`);
    }
    setBlocks(parseHarnessSessionBlocks(await response.json()));
  }, [parentSessionId]);

  const saveBlock = React.useCallback(async (block: HarnessSessionBlock) => {
    if (savingBlock) return;
    setSavingBlock(true);
    try {
      const response = await runtimeFetch(
        `/api/harness/sessions/${encodeURIComponent(parentSessionId)}/blocks/${encodeURIComponent(block.label)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: blockDraft, expectedUpdatedAt: block.updatedAt }),
        },
      );
      if (response.status === 409) {
        setEditingBlock(null);
        await reloadBlocks();
        throw new Error(t('harness.blocks.conflict'));
      }
      if (!response.ok) throw new Error(`Unable to save session block (${response.status})`);
      await reloadBlocks();
      setEditingBlock(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingBlock(false);
    }
  }, [blockDraft, parentSessionId, reloadBlocks, savingBlock, t]);

  React.useEffect(() => {
    const controller = new AbortController();
    eventRevision.current = 0;
    setThreads([]);
    setBlocks([]);
    setEditingBlock(null);
    void reload(controller.signal).catch((error) => {
      if (!controller.signal.aborted) console.warn('[HarnessThreadsPanel] Failed to load threads:', error);
    });
    void reloadBlocks(controller.signal).catch((error) => {
      if (!controller.signal.aborted) console.warn('[HarnessThreadsPanel] Failed to load session blocks:', error);
    });
    const unsubscribe = subscribePiariumEvents((event) => {
      if (event.type === 'stream-ready') {
        void reload(controller.signal).catch(() => undefined);
        void reloadBlocks(controller.signal).catch(() => undefined);
        return;
      }
      if (event.type === 'harness-blocks-changed' && event.workspaceId === workspaceId && event.sessionId === parentSessionId) {
        void reloadBlocks(controller.signal).catch(() => undefined);
        return;
      }
      if (
        event.type !== 'harness-thread-changed'
        || event.workspaceId !== workspaceId
        || !scopeMatches(event.parent, parent)
      ) return;
      eventRevision.current += 1;
      setThreads((current) => mergeSnapshot(current, { thread: event.thread, activeRun: event.activeRun }));
    });
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [parent, parentSessionId, reload, reloadBlocks, workspaceId]);

  if (threads.length === 0 && blocks.length === 0) return null;

  return (
    <aside className="hidden w-72 shrink-0 flex-col border-l border-border/60 bg-[var(--surface-subtle)]/35 xl:flex" aria-label={t('harness.context.title')}>
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/50 px-3">
        <span className="typography-meta font-medium text-foreground">{t('harness.context.title')}</span>
        <span className="rounded-full bg-muted/60 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">{blocks.length + threads.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {blocks.length > 0 ? (
          <section className="border-b border-border/50 p-2" aria-label={t('harness.blocks.title')}>
            <h3 className="px-1 pb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('harness.blocks.title')}</h3>
            <div className="space-y-1.5">
              {blocks.map((block) => {
                const editing = editingBlock === block.label;
                return (
                  <div key={block.label} className="rounded-lg border border-border/50 bg-background/45 p-2">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">{block.label}</span>
                      <span className="text-[9px] text-muted-foreground">{block.updatedBy}</span>
                      <button
                        type="button"
                        title={t('harness.blocks.edit')}
                        aria-label={t('harness.blocks.edit')}
                        onClick={() => {
                          setEditingBlock(editing ? null : block.label);
                          setBlockDraft(block.content);
                        }}
                        className="rounded p-0.5 text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                      >
                        <Icon name={editing ? 'close' : 'edit'} className="size-3" />
                      </button>
                    </div>
                    {editing ? (
                      <div className="mt-2 space-y-2">
                        <textarea
                          value={blockDraft}
                          onChange={(event) => setBlockDraft(event.target.value)}
                          className="min-h-28 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-[11px] leading-4 text-foreground outline-none focus:border-primary"
                        />
                        <div className="flex justify-end gap-1.5">
                          <button type="button" className="rounded px-2 py-1 text-[10px] text-muted-foreground hover:bg-interactive-hover" onClick={() => setEditingBlock(null)}>
                            {t('harness.blocks.cancel')}
                          </button>
                          <button type="button" disabled={savingBlock} className="rounded bg-primary px-2 py-1 text-[10px] text-primary-foreground disabled:opacity-50" onClick={() => void saveBlock(block)}>
                            {t('harness.blocks.save')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-[10px] leading-4 text-muted-foreground">{block.content}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
        {threads.length > 0 ? (
          <section className="p-2" aria-label={t('harness.threads.title')}>
            <h3 className="px-1 pb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('harness.threads.title')}</h3>
            <div className="space-y-1.5">
        {threads.map((entry) => {
          const state = projectHarnessThreadState(entry);
          const sessionId = entry.activeRun?.sessionId;
          const cwd = entry.thread.worktree?.path ?? fallbackCwd;
          return (
            <button
              key={entry.thread.id}
              type="button"
              disabled={!sessionId}
              title={sessionId ? t('harness.threads.open') : undefined}
              onClick={() => {
                if (!sessionId) return;
                void openSession({
                  sessionId,
                  ...(cwd ? { cwd } : {}),
                  ...(entry.thread.model ? { model: entry.thread.model } : {}),
                  ...(entry.thread.manifest.scope.length > 0 ? { scope: entry.thread.manifest.scope } : {}),
                  tools: entry.thread.manifest.tools,
                }).catch((error) => {
                  toast.error(error instanceof Error ? error.message : String(error));
                });
              }}
              className="group w-full rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors hover:border-border/60 hover:bg-interactive-hover disabled:cursor-default disabled:opacity-80"
            >
              <div className="flex items-center gap-2">
                {state === 'running' || state === 'starting' ? (
                  <Icon name="loader-4" className="size-3 shrink-0 animate-spin text-[var(--status-info)]" />
                ) : (
                  <span className={cn('size-2 shrink-0 rounded-full', stateTone[state])} aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1 truncate typography-meta font-medium text-foreground">
                  {entry.thread.role ?? entry.thread.id}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{t(stateKey[state])}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{entry.thread.brief}</p>
              {entry.thread.waitingFor ? (
                <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-[var(--status-warning)]">
                  ? {entry.thread.waitingFor.text}
                </p>
              ) : null}
              <div className="mt-1.5 flex items-center gap-2 text-[10px] tabular-nums text-muted-foreground/80">
                <span>↳ {entry.activeRun?.steps ?? 0}</span>
                {entry.thread.diffStats && entry.thread.diffStats.files > 0 ? (
                  <span>Δ {entry.thread.diffStats.files} · +{entry.thread.diffStats.insertions} −{entry.thread.diffStats.deletions}</span>
                ) : null}
              </div>
            </button>
          );
        })}
            </div>
          </section>
        ) : null}
      </div>
    </aside>
  );
};
