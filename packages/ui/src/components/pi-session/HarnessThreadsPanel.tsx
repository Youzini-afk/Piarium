import React from 'react';
import { runtimeFetch } from '@piarium/application-client';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { subscribePiariumEvents } from '@/lib/piariumEvents';
import { cn } from '@/lib/utils';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import {
  parseHarnessThreadMutation,
  parseHarnessThreadSpace,
  projectHarnessThreadState,
  type HarnessThreadSnapshot,
  type HarnessThreadState,
} from './harnessThreadPresentation';
import type { WorkspaceThreadSpace } from '@piarium/protocol';
import { parseHarnessSessionBlockResponse, type HarnessSessionBlock } from './harnessBlockPresentation';
import {
  harnessKnowledgeKey,
  parseHarnessKnowledgeSuggestions,
  type HarnessKnowledgeScope,
  type HarnessKnowledgeSuggestion,
} from './harnessKnowledgePresentation';
import { HarnessKnowledgeReviewSection, type KnowledgeDraft } from './HarnessKnowledgeReviewSection';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { HarnessSessionStateTrigger } from './HarnessSessionStateTrigger';
import { useHarnessThreadState } from './HarnessThreadStateContext';
import { HarnessThreadIntegrationPanel } from './HarnessThreadIntegrationPanel';
import { useWebSources, useWebSourcesStore } from '@/stores/useWebSourcesStore';

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
  dirty: 'harness.threads.state.dirty',
  'merge-ready': 'harness.threads.state.merge-ready',
  conflict: 'harness.threads.state.conflict',
  merged: 'harness.threads.state.merged',
  archived: 'harness.threads.state.archived',
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
  dirty: 'bg-[var(--status-warning)]',
  'merge-ready': 'bg-[var(--status-success)]',
  conflict: 'bg-[var(--status-error)]',
  merged: 'bg-[var(--status-success)]',
  archived: 'bg-muted-foreground/50',
};

export const HarnessThreadsPanel: React.FC<{
  workspaceId: string;
  parentSessionId: string;
  fallbackCwd?: string;
}> = ({ workspaceId, parentSessionId, fallbackCwd }) => {
  const { t } = useI18n();
  const openSession = usePiSessionStore((state) => state.openSession);
  const threadState = useHarnessThreadState();
  const threads = threadState.threads;
  const webSources = useWebSources(parentSessionId);
  const pinSource = useWebSourcesStore((state) => state.pinSource);
  const unpinSource = useWebSourcesStore((state) => state.unpinSource);
  const deleteSource = useWebSourcesStore((state) => state.deleteSource);
  const [blocks, setBlocks] = React.useState<HarnessSessionBlock[]>([]);
  const [blocksBranchLeafId, setBlocksBranchLeafId] = React.useState<string | null>(null);
  const [suggestions, setSuggestions] = React.useState<HarnessKnowledgeSuggestion[]>([]);
  const [knowledgeDrafts, setKnowledgeDrafts] = React.useState<Record<string, KnowledgeDraft>>({});
  const [knowledgeBusy, setKnowledgeBusy] = React.useState<string | null>(null);
  const [editingBlock, setEditingBlock] = React.useState<string | null>(null);
  const [blockDraft, setBlockDraft] = React.useState('');
  const [savingBlock, setSavingBlock] = React.useState(false);
  const [narrowOpen, setNarrowOpen] = React.useState(false);
  const [convertingThreadId, setConvertingThreadId] = React.useState<string | null>(null);
  const [space, setSpace] = React.useState<WorkspaceThreadSpace | null>(null);
  const [threadAction, setThreadAction] = React.useState<string | null>(null);

  const readError = (body: unknown, fallback: string): string => (
    body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
      ? (body as { error: string }).error
      : fallback
  );

  const reloadSpace = React.useCallback(async (signal?: AbortSignal) => {
    const response = await runtimeFetch(`/api/harness/sessions/${encodeURIComponent(parentSessionId)}/space`, {
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      if (response.status === 404) {
        setSpace(null);
        return;
      }
      throw new Error(`Unable to load thread space (${response.status})`);
    }
    setSpace(parseHarnessThreadSpace(await response.json()));
  }, [parentSessionId]);

  const applyThreadMutation = React.useCallback(async (path: string, failedKey: 'harness.threads.archiveFailed' | 'harness.threads.restoreFailed' | 'harness.threads.reclaimFailed' | 'harness.threads.keepFailed', body?: unknown) => {
    const response = await runtimeFetch(
      `/api/harness/sessions/${encodeURIComponent(parentSessionId)}/threads/${path}`,
      {
        method: 'POST',
        ...(body === undefined ? {} : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(readError(payload, t(failedKey)));
    const mutated = parseHarnessThreadMutation(payload);
    threadState.merge(mutated);
    if (payload && typeof payload === 'object' && 'space' in payload) {
      try { setSpace(parseHarnessThreadSpace((payload as { space: unknown }).space)); }
      catch { await reloadSpace(); }
    } else {
      await reloadSpace();
    }
    await threadState.reload();
  }, [parentSessionId, reloadSpace, t, threadState]);

  const convertDiscussion = React.useCallback(async (entry: HarnessThreadSnapshot) => {
    if (convertingThreadId) return;
    setConvertingThreadId(entry.thread.id);
    try {
      const response = await runtimeFetch(
        `/api/harness/sessions/${encodeURIComponent(parentSessionId)}/threads/${encodeURIComponent(entry.thread.id)}/convert`,
        { method: 'POST' },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
            ? body.error
            : `Unable to convert discussion thread (${response.status})`,
        );
      }
      const converted = parseHarnessThreadMutation(body);
      threadState.merge(converted);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('harness.threads.convertFailed'));
    } finally {
      setConvertingThreadId(null);
    }
  }, [convertingThreadId, parentSessionId, t, threadState]);

  const reloadBlocks = React.useCallback(async (signal?: AbortSignal) => {
    const response = await runtimeFetch(`/api/harness/sessions/${encodeURIComponent(parentSessionId)}/blocks`, {
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      if (response.status === 404) {
        setBlocks([]);
        setBlocksBranchLeafId(null);
        return;
      }
      throw new Error(`Unable to load session blocks (${response.status})`);
    }
    const body = await response.json();
    const parsed = parseHarnessSessionBlockResponse(body);
    setBlocks(parsed.blocks);
    setBlocksBranchLeafId(parsed.branchLeafId);
  }, [parentSessionId]);

  const reloadKnowledge = React.useCallback(async (signal?: AbortSignal) => {
    const response = await runtimeFetch(`/api/harness/sessions/${encodeURIComponent(parentSessionId)}/knowledge/suggestions`, {
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      if (response.status === 404) {
        setSuggestions([]);
        setKnowledgeDrafts({});
        return;
      }
      throw new Error(`Unable to load knowledge suggestions (${response.status})`);
    }
    const incoming = parseHarnessKnowledgeSuggestions(await response.json());
    setSuggestions(incoming);
    setKnowledgeDrafts(Object.fromEntries(incoming.map((suggestion) => [
      harnessKnowledgeKey(suggestion),
      { content: suggestion.content, trigger: suggestion.trigger, supersedes: [] },
    ])));
  }, [parentSessionId]);

  const rememberBlock = React.useCallback(async (block: HarnessSessionBlock, scope: HarnessKnowledgeScope) => {
    const busyKey = `create:${scope}:${block.label}`;
    if (knowledgeBusy) return;
    setKnowledgeBusy(busyKey);
    try {
      const response = await runtimeFetch(`/api/harness/sessions/${encodeURIComponent(parentSessionId)}/knowledge/suggestions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, content: block.content, trigger: '', kind: `block:${block.label}` }),
      });
      if (!response.ok) throw new Error(`Unable to create knowledge suggestion (${response.status})`);
      await reloadKnowledge();
      toast.success(t('harness.knowledge.created'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setKnowledgeBusy(null);
    }
  }, [knowledgeBusy, parentSessionId, reloadKnowledge, t]);

  const saveKnowledgeDraft = React.useCallback(async (suggestion: HarnessKnowledgeSuggestion): Promise<boolean> => {
    const key = harnessKnowledgeKey(suggestion);
    const draft = knowledgeDrafts[key];
    if (!draft?.content.trim()) {
      toast.error(t('harness.knowledge.contentRequired'));
      return false;
    }
    const response = await runtimeFetch(
      `/api/harness/sessions/${encodeURIComponent(parentSessionId)}/knowledge/suggestions/${suggestion.scope}/${suggestion.id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: draft.content,
          trigger: draft.trigger,
          expectedContent: suggestion.content,
          expectedTrigger: suggestion.trigger,
        }),
      },
    );
    if (response.status === 409) {
      await reloadKnowledge();
      toast.error(t('harness.knowledge.conflict'));
      return false;
    }
    if (!response.ok) throw new Error(`Unable to update knowledge suggestion (${response.status})`);
    return true;
  }, [knowledgeDrafts, parentSessionId, reloadKnowledge, t]);

  const actOnKnowledge = React.useCallback(async (
    suggestion: HarnessKnowledgeSuggestion,
    action: 'save' | 'accept' | 'dismiss',
  ) => {
    const key = harnessKnowledgeKey(suggestion);
    if (knowledgeBusy) return;
    setKnowledgeBusy(key);
    try {
      if (action === 'save') {
        if (!await saveKnowledgeDraft(suggestion)) return;
      } else {
        const draft = knowledgeDrafts[key];
        const response = await runtimeFetch(
          `/api/harness/sessions/${encodeURIComponent(parentSessionId)}/knowledge/suggestions/${suggestion.scope}/${suggestion.id}/${action}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(action === 'accept' ? {
              supersedes: draft?.supersedes ?? [],
              content: draft?.content ?? suggestion.content,
              trigger: draft?.trigger ?? suggestion.trigger,
              expectedContent: suggestion.content,
              expectedTrigger: suggestion.trigger,
            } : { supersedes: [] }),
          },
        );
        if (response.status === 409) {
          await reloadKnowledge();
          toast.error(t('harness.knowledge.conflict'));
          return;
        }
        if (!response.ok) throw new Error(`Unable to ${action} knowledge suggestion (${response.status})`);
      }
      await reloadKnowledge();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setKnowledgeBusy(null);
    }
  }, [knowledgeBusy, knowledgeDrafts, parentSessionId, reloadKnowledge, saveKnowledgeDraft, t]);

  const saveBlock = React.useCallback(async (block: HarnessSessionBlock) => {
    if (savingBlock) return;
    setSavingBlock(true);
    try {
      const response = await runtimeFetch(
        `/api/harness/sessions/${encodeURIComponent(parentSessionId)}/blocks/${encodeURIComponent(block.label)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: blockDraft,
            expectedUpdatedAt: block.updatedAt,
            expectedBranchLeafId: blocksBranchLeafId,
          }),
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
  }, [blockDraft, blocksBranchLeafId, parentSessionId, reloadBlocks, savingBlock, t]);

  React.useEffect(() => {
    const controller = new AbortController();
    setBlocks([]);
    setBlocksBranchLeafId(null);
    setSuggestions([]);
    setKnowledgeDrafts({});
    setEditingBlock(null);
    setNarrowOpen(false);
    setConvertingThreadId(null);
    void reloadBlocks(controller.signal).catch((error) => {
      if (!controller.signal.aborted) console.warn('[HarnessThreadsPanel] Failed to load session blocks:', error);
    });
    void reloadKnowledge(controller.signal).catch((error) => {
      if (!controller.signal.aborted) console.warn('[HarnessThreadsPanel] Failed to load knowledge suggestions:', error);
    });
    void reloadSpace(controller.signal).catch((error) => {
      if (!controller.signal.aborted) console.warn('[HarnessThreadsPanel] Failed to load thread space:', error);
    });
    const unsubscribe = subscribePiariumEvents((event) => {
      if (event.type === 'stream-ready') {
        void reloadBlocks(controller.signal).catch(() => undefined);
        void reloadKnowledge(controller.signal).catch(() => undefined);
        void reloadSpace(controller.signal).catch(() => undefined);
        return;
      }
      if (event.type === 'harness-blocks-changed' && event.workspaceId === workspaceId && event.sessionId === parentSessionId) {
        void reloadBlocks(controller.signal).catch(() => undefined);
        return;
      }
      if (event.type === 'harness-knowledge-changed' && (event.scope === 'user' || event.sessionId === parentSessionId)) {
        void reloadKnowledge(controller.signal).catch(() => undefined);
        return;
      }
    });
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [parentSessionId, reloadBlocks, reloadKnowledge, reloadSpace, workspaceId]);

  const hasThreadRecords = threads.length > 0 || (space?.threads.length ?? 0) > 0;
  if (threads.length === 0 && !hasThreadRecords && blocks.length === 0 && suggestions.length === 0 && webSources.length === 0) return null;

  const itemCount = blocks.length + Math.max(threads.length, space?.threads.length ?? 0) + suggestions.length + webSources.length;
  const formatLogical = (bytes: number | null, unknown: boolean): string => (
    unknown || bytes === null ? t('harness.threads.space.unknownSize') : t('harness.threads.space.bytes', { bytes })
  );
  const content = (
    <div className="min-h-0 flex-1 overflow-y-auto">
        <HarnessKnowledgeReviewSection
          suggestions={suggestions}
          drafts={knowledgeDrafts}
          busy={knowledgeBusy !== null}
          onDraftChange={(key, draft) => setKnowledgeDrafts((current) => ({ ...current, [key]: draft }))}
          onAction={(suggestion, action) => { void actOnKnowledge(suggestion, action); }}
        />
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
                      <button type="button" disabled={knowledgeBusy !== null} className="rounded px-1 py-0.5 text-[9px] text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50" onClick={() => void rememberBlock(block, 'workspace')}>
                        {t('harness.knowledge.rememberWorkspace')}
                      </button>
                      <button type="button" disabled={knowledgeBusy !== null} className="rounded px-1 py-0.5 text-[9px] text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50" onClick={() => void rememberBlock(block, 'user')}>
                        {t('harness.knowledge.rememberUser')}
                      </button>
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
        {webSources.length > 0 ? (
          <section className="border-b border-border/50 p-2" aria-label={t('harness.sources.title')}>
            <h3 className="px-1 pb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('harness.sources.title')}</h3>
            <div className="space-y-1">
              {[...webSources].sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.fetchedAt - left.fetchedAt).map((source) => (
                <div key={source.id} className="group/source flex items-start gap-1.5 rounded-md px-1.5 py-1.5 hover:bg-interactive-hover">
                  <Icon name={source.tool === 'websearch' ? 'search' : 'global'} className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                  <a href={source.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1" title={source.url}>
                    <span className="block truncate text-[11px] text-foreground">{source.title}</span>
                    <span className="block truncate text-[9px] text-muted-foreground">{source.url}</span>
                  </a>
                  <button
                    type="button"
                    onClick={() => source.pinned ? unpinSource(source.id) : pinSource(source.id)}
                    aria-label={t(source.pinned ? 'harness.sources.unpin' : 'harness.sources.pin')}
                    className="rounded p-0.5 text-muted-foreground opacity-70 hover:bg-background hover:text-foreground group-hover/source:opacity-100"
                  >
                    <Icon name={source.pinned ? 'pushpin-2-fill' : 'pushpin'} className="size-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteSource(source.id)}
                    aria-label={t('harness.sources.remove')}
                    className="rounded p-0.5 text-muted-foreground opacity-70 hover:bg-background hover:text-[var(--status-error)] group-hover/source:opacity-100"
                  >
                    <Icon name="close" className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        {hasThreadRecords ? (
          <section className="p-2" aria-label={t('harness.threads.title')}>
            <div className="flex items-center justify-between gap-2 px-1 pb-1.5">
              <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('harness.threads.title')}</h3>
              <button
                type="button"
                onClick={() => threadState.setIncludeArchived(!threadState.includeArchived)}
                className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-background/70 hover:text-foreground"
              >
                {t(threadState.includeArchived ? 'harness.threads.hideArchived' : 'harness.threads.showArchived')}
              </button>
            </div>
            {space ? (
              <div className="mb-2 rounded-md border border-border/50 bg-background/40 px-2 py-1.5 text-[10px] leading-4 text-muted-foreground">
                <p>{t('harness.threads.space.title')}: {formatLogical(space.materializedLogicalBytes, space.status === 'unknown')}</p>
                <p>{space.note}</p>
                {space.status === 'over-budget' ? <p className="text-[var(--status-warning)]">{t('harness.threads.space.overBudget')}</p> : null}
                {space.status === 'low-free' ? <p className="text-[var(--status-warning)]">{t('harness.threads.space.lowFree')}</p> : null}
                {space.status === 'enospc' ? <p className="text-[var(--status-error)]">{t('harness.threads.space.enospc')}</p> : null}
              </div>
            ) : null}
            <div className="space-y-1.5">
        {threads.length === 0 ? (
          <p className="px-1 text-[10px] text-muted-foreground">{t('harness.threads.empty')}</p>
        ) : null}
        {threads.map((entry) => {
          const state = projectHarnessThreadState(entry);
          const sessionId = entry.activeRun?.sessionId;
          const cwd = entry.thread.worktree?.path ?? fallbackCwd;
          const converting = convertingThreadId === entry.thread.id;
          const occupancy = space?.threads.find((item) => item.threadId === entry.thread.id);
          const busy = threadAction === entry.thread.id;
          const label = entry.thread.role ?? (
            entry.thread.kind === 'discussion'
              ? t('harness.threads.discussion')
              : t('harness.threads.userThread')
          );
          return (
            <div key={entry.thread.id} className="overflow-hidden rounded-lg border border-transparent transition-colors hover:border-border/60 hover:bg-interactive-hover">
              <button
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
                className="group w-full px-2.5 py-2 text-left disabled:cursor-default disabled:opacity-80"
              >
                <div className="flex items-center gap-2">
                  {state === 'running' || state === 'starting' ? (
                    <Icon name="loader-4" className="size-3 shrink-0 animate-spin text-[var(--status-info)]" />
                  ) : (
                    <span className={cn('size-2 shrink-0 rounded-full', stateTone[state])} aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 truncate typography-meta font-medium text-foreground">{label}</span>
                  <span className="rounded bg-muted/60 px-1 py-0.5 text-[9px] text-muted-foreground">
                    {t(entry.thread.kind === 'discussion' ? 'harness.threads.kind.discussion' : 'harness.threads.kind.implementation')}
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
                  {occupancy ? (
                    <span>{t('harness.threads.space.logical', { bytes: formatLogical(occupancy.materialized.logicalBytes, occupancy.materialized.unknown) })}</span>
                  ) : null}
                </div>
                {occupancy && occupancy.keepReasons.length > 0 ? (
                  <p className="mt-1 line-clamp-3 text-[10px] leading-4 text-muted-foreground">
                    {t('harness.threads.space.kept', { reason: occupancy.keepReasons.join('; ') })}
                  </p>
                ) : null}
                {entry.thread.worktree?.retentionReason ? (
                  <p className="mt-1 line-clamp-3 text-[10px] leading-4 text-[var(--status-warning)]">{entry.thread.worktree.retentionReason}</p>
                ) : null}
              </button>
              {entry.thread.kind === 'implementation'
                && (entry.thread.integration === 'dirty'
                  || entry.thread.integration === 'merge-ready'
                  || entry.thread.integration === 'conflict') ? (
                <HarnessThreadIntegrationPanel
                  workspaceId={workspaceId}
                  parentSessionId={parentSessionId}
                  entry={entry}
                  onThread={(next) => threadState.merge({ thread: next, activeRun: entry.activeRun })}
                />
              ) : null}
              <div className="flex flex-wrap justify-end gap-1 border-t border-border/40 px-2 py-1">
                {entry.thread.kind === 'discussion' && entry.thread.lifecycle === 'active' ? (
                  <button
                    type="button"
                    disabled={convertingThreadId !== null}
                    onClick={() => { void convertDiscussion(entry); }}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-background/70 hover:text-foreground disabled:opacity-50"
                  >
                    <Icon name={converting ? 'loader-4' : 'git-branch'} className={cn('size-3', converting && 'animate-spin')} />
                    {t(converting ? 'harness.threads.converting' : 'harness.threads.convert')}
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setThreadAction(entry.thread.id);
                    void applyThreadMutation(
                      `${encodeURIComponent(entry.thread.id)}/keep-worktree`,
                      'harness.threads.keepFailed',
                      { keepWorktree: !entry.thread.keepWorktree },
                    ).catch((error) => {
                      toast.error(error instanceof Error ? error.message : t('harness.threads.keepFailed'));
                    }).finally(() => setThreadAction(null));
                  }}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-background/70 hover:text-foreground disabled:opacity-50"
                >
                  {t(entry.thread.keepWorktree ? 'harness.threads.keepWorktreeOn' : 'harness.threads.keepWorktree')}
                </button>
                {occupancy?.reclaimable ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setThreadAction(entry.thread.id);
                      void applyThreadMutation(
                        `${encodeURIComponent(entry.thread.id)}/reclaim`,
                        'harness.threads.reclaimFailed',
                      ).catch((error) => {
                        toast.error(error instanceof Error ? error.message : t('harness.threads.reclaimFailed'));
                      }).finally(() => setThreadAction(null));
                    }}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-background/70 hover:text-foreground disabled:opacity-50"
                  >
                    {t(busy ? 'harness.threads.reclaiming' : 'harness.threads.reclaim')}
                  </button>
                ) : null}
                {entry.thread.lifecycle === 'archived' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setThreadAction(entry.thread.id);
                      void applyThreadMutation(
                        `${encodeURIComponent(entry.thread.id)}/restore`,
                        'harness.threads.restoreFailed',
                      ).catch((error) => {
                        toast.error(error instanceof Error ? error.message : t('harness.threads.restoreFailed'));
                      }).finally(() => setThreadAction(null));
                    }}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-background/70 hover:text-foreground disabled:opacity-50"
                  >
                    {t(busy ? 'harness.threads.restoring' : 'harness.threads.restore')}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setThreadAction(entry.thread.id);
                      void applyThreadMutation(
                        `${encodeURIComponent(entry.thread.id)}/archive`,
                        'harness.threads.archiveFailed',
                        { keepWorktree: entry.thread.keepWorktree === true },
                      ).catch((error) => {
                        toast.error(error instanceof Error ? error.message : t('harness.threads.archiveFailed'));
                      }).finally(() => setThreadAction(null));
                    }}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-background/70 hover:text-foreground disabled:opacity-50"
                  >
                    {t(busy ? 'harness.threads.archiving' : 'harness.threads.archive')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
            </div>
          </section>
        ) : null}
    </div>
  );

  return (
    <>
      <aside className="hidden w-72 shrink-0 flex-col border-l border-border/60 bg-[var(--surface-subtle)]/35 xl:flex" aria-label={t('harness.context.title')}>
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/50 px-3">
          <span className="typography-meta font-medium text-foreground">{t('harness.context.title')}</span>
          <span className="rounded-full bg-muted/60 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">{itemCount}</span>
        </div>
        {content}
      </aside>
      <HarnessSessionStateTrigger count={itemCount} onOpen={() => setNarrowOpen(true)} />
      <MobileOverlayPanel
        open={narrowOpen}
        onClose={() => setNarrowOpen(false)}
        title={t('harness.context.title')}
        className="h-[min(82dvh,720px)]"
        contentMaxHeightClassName="flex-1"
      >
        {content}
      </MobileOverlayPanel>
    </>
  );
};
