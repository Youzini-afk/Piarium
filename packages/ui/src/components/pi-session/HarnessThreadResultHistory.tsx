import React from 'react';
import type {
  ThreadResultHistory,
  ThreadResultHistoryEntry,
  ThreadResultHistoryReleaseParams,
  ThreadResultHistoryReleaseResult,
  ThreadResultRetentionReason,
} from '@piarium/application-client';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import type { I18nKey } from '@/lib/i18n';
import {
  loadThreadResultHistory,
  releaseThreadResultHistory,
  ThreadResultHistoryRequestError,
} from './threadResultHistoryRequest';

const reasonKey: Record<ThreadResultRetentionReason, I18nKey> = {
  'branch-head': 'harness.threads.history.protected.branchHead',
  'current-result': 'harness.threads.history.protected.currentResult',
  'run-input': 'harness.threads.history.protected.runInput',
  review: 'harness.threads.history.protected.review',
  integration: 'harness.threads.history.protected.integration',
};

type ReleaseNotice = {
  result: ThreadResultHistoryReleaseResult;
  request: ThreadResultHistoryReleaseParams;
};

export const HarnessThreadResultHistory: React.FC<{
  parentSessionId: string;
  threadId: string;
  onReleased?: () => void | Promise<void>;
}> = ({ parentSessionId, threadId, onReleased }) => {
  const { t } = useI18n();
  const targetKey = `${parentSessionId}\u0000${threadId}`;
  const [open, setOpen] = React.useState(false);
  const [history, setHistory] = React.useState<ThreadResultHistory | null>(null);
  const [selected, setSelected] = React.useState<Set<number>>(() => new Set());
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [releaseNotice, setReleaseNotice] = React.useState<ReleaseNotice | null>(null);
  const [releaseError, setReleaseError] = React.useState<string | null>(null);
  const [frozenRequest, setFrozenRequest] = React.useState<ThreadResultHistoryReleaseParams | null>(null);
  const targetGeneration = React.useRef(0);
  const requestController = React.useRef<AbortController | null>(null);
  const onReleasedRef = React.useRef(onReleased);

  React.useEffect(() => { onReleasedRef.current = onReleased; }, [onReleased]);

  React.useEffect(() => {
    targetGeneration.current += 1;
    requestController.current?.abort();
    requestController.current = null;
    setOpen(false);
    setHistory(null);
    setSelected(new Set());
    setLoading(false);
    setBusy(false);
    setLoadError(null);
    setConfirmOpen(false);
    setReleaseNotice(null);
    setReleaseError(null);
    setFrozenRequest(null);
  }, [targetKey]);

  React.useEffect(() => () => {
    targetGeneration.current += 1;
    requestController.current?.abort();
  }, []);

  const formatBytes = React.useCallback((bytes: number) => (
    t('harness.threads.history.bytes', { bytes })
  ), [t]);

  const formatDate = React.useCallback((createdAt: string) => {
    const date = new Date(createdAt);
    return Number.isNaN(date.getTime()) ? createdAt : new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }, []);

  const isCurrent = React.useCallback((generation: number, expectedTarget = targetKey) => (
    generation === targetGeneration.current && expectedTarget === targetKey
  ), [targetKey]);

  const fetchHistory = React.useCallback(async () => {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    const generation = targetGeneration.current;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await loadThreadResultHistory(parentSessionId, threadId, controller.signal);
      if (!isCurrent(generation) || controller.signal.aborted) return;
      setHistory(next);
      setSelected(new Set());
      setReleaseNotice((current) => current?.result.cleanup.status === 'complete' ? null : current);
    } catch (error) {
      if (!isCurrent(generation) || controller.signal.aborted) return;
      setLoadError(error instanceof Error ? error.message : t('harness.threads.history.loadFailed'));
    } finally {
      if (isCurrent(generation) && requestController.current === controller) setLoading(false);
    }
  }, [isCurrent, parentSessionId, t, threadId]);

  const openHistory = React.useCallback(() => {
    setOpen(true);
    void fetchHistory();
  }, [fetchHistory]);

  const closeHistory = React.useCallback(() => {
    requestController.current?.abort();
    requestController.current = null;
    setOpen(false);
    setConfirmOpen(false);
  }, []);

  const toggleSelected = React.useCallback((entry: ThreadResultHistoryEntry, checked: boolean) => {
    if (entry.protectedReasons.length > 0 || busy) return;
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(entry.resultRevision);
      else next.delete(entry.resultRevision);
      return next;
    });
    setReleaseError(null);
  }, [busy]);

  const showConfirm = React.useCallback(() => {
    if (!history?.branchId || selected.size === 0 || busy) return;
    setFrozenRequest({ branchId: history.branchId, resultRevisions: [...selected].sort((a, b) => a - b) });
    setReleaseError(null);
    setConfirmOpen(true);
  }, [busy, history, selected]);

  const applyReleaseResult = React.useCallback((result: ThreadResultHistoryReleaseResult, request: ThreadResultHistoryReleaseParams) => {
    setHistory((current) => current ? {
      ...current,
      results: current.results.filter((entry) => (
        !result.releasedRevisions.includes(entry.resultRevision)
        && !result.missingRevisions.includes(entry.resultRevision)
      )),
    } : current);
    setSelected(new Set());
    setReleaseNotice({ result, request });
  }, []);

  const submitRelease = React.useCallback(async () => {
    if (!frozenRequest || busy) return;
    const request = frozenRequest;
    const generation = targetGeneration.current;
    setBusy(true);
    setReleaseError(null);
    try {
      const result = await releaseThreadResultHistory(parentSessionId, threadId, request);
      if (!isCurrent(generation)) return;
      applyReleaseResult(result, request);
      setConfirmOpen(false);
      await onReleasedRef.current?.();
    } catch (error) {
      if (!isCurrent(generation)) return;
      const message = error instanceof Error ? error.message : t('harness.threads.history.releaseFailed');
      setReleaseError(message);
      if (error instanceof ThreadResultHistoryRequestError && error.status === 409) {
        toast.error(message);
      }
    } finally {
      if (isCurrent(generation)) setBusy(false);
    }
  }, [applyReleaseResult, busy, frozenRequest, isCurrent, parentSessionId, t, threadId]);

  const retryCleanup = React.useCallback(() => {
    if (!releaseNotice?.request || busy) return;
    setFrozenRequest(releaseNotice.request);
    setReleaseError(null);
    setConfirmOpen(true);
  }, [busy, releaseNotice]);

  const selectedCount = selected.size;
  const results = history?.results ?? [];

  return (
    <div className="border-t border-border/40 px-2 py-1.5">
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-expanded={open}
        onClick={open ? closeHistory : openHistory}
        className="w-full justify-between !font-normal text-muted-foreground"
      >
        <span className="inline-flex items-center gap-1.5">
          <Icon name="history" className="size-3" />
          {t('harness.threads.history.open')}
        </span>
        <Icon name={open ? 'arrow-up-s' : 'arrow-down-s'} className="size-3" />
      </Button>

      {open ? (
        <section className="mt-1.5 rounded-md border border-border/50 bg-background/35 p-2" aria-label={t('harness.threads.history.title')}>
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('harness.threads.history.title')}</h4>
          </div>
          {loading ? (
            <p className="mt-2 inline-flex items-center gap-1.5 text-[10px] text-muted-foreground" aria-busy="true">
              <Icon name="loader-4" className="size-3 animate-spin" />{t('harness.threads.history.loading')}
            </p>
          ) : loadError ? (
            <div className="mt-2 space-y-1.5">
              <p className="text-[10px] text-[var(--status-error)]">{loadError}</p>
              <Button type="button" size="xs" variant="outline" onClick={() => void fetchHistory()}>{t('harness.threads.history.retry')}</Button>
            </div>
          ) : history && results.length === 0 ? (
            <p className="mt-2 text-[10px] text-muted-foreground">{t('harness.threads.history.empty')}</p>
          ) : history ? (
            <>
              <p className="mt-1 text-[9px] leading-4 text-muted-foreground">{t('harness.threads.history.retainedBytesNote')}</p>
              <div className="mt-2 space-y-1.5">
                {results.map((entry) => {
                  const protectedEntry = entry.protectedReasons.length > 0;
                  return (
                    <div key={entry.resultRevision} className="rounded border border-border/40 px-1.5 py-1.5">
                      <div className="flex items-start gap-1.5">
                        <Checkbox
                          checked={selected.has(entry.resultRevision)}
                          disabled={protectedEntry || busy}
                          ariaLabel={t('harness.threads.history.select', { revision: entry.resultRevision })}
                          onChange={(checked) => toggleSelected(entry, checked)}
                          className="mt-0.5"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-2 text-[10px]">
                            <span className="font-medium text-foreground">{t('harness.threads.history.revision', { revision: entry.resultRevision })}</span>
                            <span className="shrink-0 tabular-nums text-muted-foreground">{formatBytes(entry.retainedBytes)}</span>
                          </div>
                          <p className="mt-0.5 text-[9px] text-muted-foreground">{formatDate(entry.createdAt)}</p>
                          {entry.changedPaths.length > 0 ? (
                            <p className="mt-0.5 line-clamp-2 break-all text-[9px] text-muted-foreground">{entry.changedPaths.join(', ')}</p>
                          ) : null}
                          {protectedEntry ? (
                            <p className="mt-0.5 text-[9px] text-[var(--status-warning)]">
                              {t('harness.threads.history.protected', { reasons: entry.protectedReasons.map((reason) => t(reasonKey[reason])).join(', ') })}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {releaseNotice ? (
                <div className={releaseNotice.result.cleanup.status === 'complete'
                  ? 'mt-2 rounded border border-[var(--status-success-border)] bg-[var(--status-success-background)] p-1.5 text-[9px] text-[var(--status-success)]'
                  : 'mt-2 rounded border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-1.5 text-[9px] text-[var(--status-error)]'}>
                  <p>{t('harness.threads.history.released', { count: releaseNotice.result.releasedRevisions.length })}</p>
                  {releaseNotice.result.missingRevisions.length > 0 ? <p>{t('harness.threads.history.missing', { count: releaseNotice.result.missingRevisions.length })}</p> : null}
                  {releaseNotice.result.cleanup.status === 'complete' ? (
                    <p>{t('harness.threads.history.cleanupComplete', { objects: releaseNotice.result.cleanup.objectsDeleted, bytes: releaseNotice.result.cleanup.byteLengthReclaimed })}</p>
                  ) : (
                    <>
                      <p>{t('harness.threads.history.cleanupFailed', { message: releaseNotice.result.cleanup.message })}</p>
                      <Button type="button" size="xs" variant="outline" className="mt-1" disabled={busy} onClick={retryCleanup}>{t('harness.threads.history.retryCleanup')}</Button>
                    </>
                  )}
                </div>
              ) : null}
              {releaseError ? <p className="mt-2 text-[9px] text-[var(--status-error)]">{releaseError}</p> : null}
              <div className="mt-2 flex justify-end">
                <Button type="button" size="xs" variant="destructive" disabled={!history.branchId || selectedCount === 0 || busy} onClick={showConfirm}>
                  {t(busy ? 'harness.threads.history.releasing' : 'harness.threads.history.release', { count: selectedCount })}
                </Button>
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      <Dialog open={confirmOpen} onOpenChange={(next) => { if (!busy) setConfirmOpen(next); }}>
        <DialogContent className="max-w-sm gap-3">
          <DialogHeader>
            <DialogTitle>{t('harness.threads.history.confirmTitle')}</DialogTitle>
            <DialogDescription>{t('harness.threads.history.confirmDescription', { count: frozenRequest?.resultRevisions.length ?? 0 })}</DialogDescription>
          </DialogHeader>
          <p className="text-[10px] leading-4 text-muted-foreground">{t('harness.threads.history.confirmWarning')}</p>
          {releaseError ? <p className="rounded border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-2 text-[10px] text-[var(--status-error)]">{releaseError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)} disabled={busy}>{t('harness.threads.history.cancel')}</Button>
            <Button type="button" variant="destructive" onClick={() => void submitRelease()} disabled={busy || !frozenRequest}>
              {t(busy ? 'harness.threads.history.releasing' : 'harness.threads.history.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
