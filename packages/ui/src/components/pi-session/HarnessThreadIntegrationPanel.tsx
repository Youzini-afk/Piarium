import React from 'react';
import type { ThreadConflictResolution, ThreadIntegrationPreview, Thread } from '@piarium/protocol';
import { runtimeFetch } from '@piarium/application-client';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { getDocumentRegistry } from '@/lib/documents/session';
import { cn } from '@/lib/utils';
import type { HarnessThreadSnapshot } from './harnessThreadPresentation';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const parsePreview = (value: unknown): ThreadIntegrationPreview => {
  if (!isRecord(value) || typeof value.operationId !== 'string' || typeof value.threadId !== 'string') {
    throw new Error('Malformed integration preview');
  }
  return value as unknown as ThreadIntegrationPreview;
};

const parseThread = (value: unknown): Thread => {
  if (!isRecord(value) || typeof value.id !== 'string') throw new Error('Malformed thread record');
  return value as unknown as Thread;
};

export const HarnessThreadIntegrationPanel: React.FC<{
  workspaceId: string;
  parentSessionId: string;
  entry: HarnessThreadSnapshot;
  onThread: (thread: Thread) => void;
}> = ({ parentSessionId, entry, onThread }) => {
  const { t } = useI18n();
  const thread = entry.thread;
  const [preview, setPreview] = React.useState<ThreadIntegrationPreview | null>(null);
  const [resolutions, setResolutions] = React.useState<Record<string, ThreadConflictResolution>>({});
  const [busy, setBusy] = React.useState(false);
  const [lastOperationId, setLastOperationId] = React.useState<string | null>(null);
  const onThreadRef = React.useRef(onThread);
  const previewRequest = React.useRef(0);

  React.useEffect(() => { onThreadRef.current = onThread; }, [onThread]);

  const loadPreview = React.useCallback(async (signal?: AbortSignal) => {
    const request = ++previewRequest.current;
    const response = await runtimeFetch(
      `/api/harness/sessions/${encodeURIComponent(parentSessionId)}/threads/${encodeURIComponent(thread.id)}/integration`,
      {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resultRevision: thread.resultRevision,
          sourceOwner: getDocumentRegistry().surfaceOwner(),
        }),
        ...(signal ? { signal } : {}),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (signal?.aborted || request !== previewRequest.current) return null;
    if (!response.ok) throw new Error(isRecord(body) && typeof body.error === 'string' ? body.error : `Unable to preview integration (${response.status})`);
    const next = parsePreview(body.preview);
    setPreview(next);
    if (isRecord(body) && body.thread) onThreadRef.current(parseThread(body.thread));
    return next;
  }, [parentSessionId, thread.id, thread.resultRevision]);

  React.useEffect(() => {
    const controller = new AbortController();
    setPreview(null);
    setResolutions({});
    void loadPreview(controller.signal).catch((error) => {
      if (!controller.signal.aborted) console.warn('[HarnessThreadIntegration] preview failed:', error);
    });
    return () => controller.abort();
  }, [loadPreview, thread.resultRevision, thread.integrationBinding?.bindingFingerprint, thread.integrationBinding?.valid]);

  const choose = (path: string, choice: ThreadConflictResolution['choice'], text?: string) => {
    setResolutions((current) => ({
      ...current,
      [path]: { path, choice, ...(text !== undefined ? { text } : {}) },
    }));
  };

  const merge = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const current = preview ?? await loadPreview();
      if (!current) return;
      const boundResolutions = Object.values(resolutions).map((resolution) => {
        const binding = current.binding[resolution.path];
        return {
          ...resolution,
          expectedParentRevision: binding?.revision,
          ...(binding?.localEditRevision === undefined ? {} : { expectedLocalEditRevision: binding.localEditRevision }),
        };
      });
      const response = await runtimeFetch(
        `/api/harness/sessions/${encodeURIComponent(parentSessionId)}/threads/${encodeURIComponent(thread.id)}/merge`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            resultRevision: current.resultRevision,
            sourceOwner: getDocumentRegistry().surfaceOwner(),
            expectedBindingFingerprint: current.bindingFingerprint,
            resolutions: boundResolutions,
          }),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(isRecord(body) && typeof body.error === 'string' ? body.error : t('harness.threads.mergeFailed'));
      }
      if (isRecord(body) && body.thread) onThread(parseThread(body.thread));
      const result = isRecord(body) ? body.result : null;
      const operationId = isRecord(result) && typeof result.operationId === 'string' ? result.operationId : current.operationId;
      setLastOperationId(operationId);
      setResolutions({});
      await loadPreview();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('harness.threads.mergeFailed'));
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!lastOperationId) return;
    try {
      const response = await runtimeFetch(
        `/api/harness/sessions/${encodeURIComponent(parentSessionId)}/threads/${encodeURIComponent(thread.id)}/integration/undo`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operationId: lastOperationId, sourceOwner: getDocumentRegistry().surfaceOwner() }),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(isRecord(body) && typeof body.error === 'string' ? body.error : t('harness.threads.undoUnavailable'));
      if (isRecord(body) && body.thread) onThread(parseThread(body.thread));
      setLastOperationId(null);
      await loadPreview();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('harness.threads.undoUnavailable'));
    }
  };

  const conflicts = preview?.paths.filter((path) => path.decision === 'conflict') ?? [];
  const unavailable = preview?.unavailablePaths ?? [];
  const show = thread.integration === 'dirty'
    || thread.integration === 'merge-ready'
    || thread.integration === 'conflict'
    || Boolean(preview);

  if (!show) return null;

  return (
    <div className="border-t border-border/40 px-2 py-2">
      <p className="px-0.5 text-[10px] text-muted-foreground">{t('harness.threads.previewApplicability')}</p>
      {preview && !preview.valid ? (
        <p className="mt-1 text-[10px] text-[var(--status-warning)]">{t('harness.threads.previewStale')}</p>
      ) : null}
      {unavailable.length > 0 ? (
        <p className="mt-1 text-[10px] text-[var(--status-warning)]">
          {t('harness.threads.unavailable')}: {unavailable.join(', ')}
        </p>
      ) : null}
      {preview?.surfaceTargetPaths.length ? (
        <p className="mt-1 text-[10px] text-muted-foreground">
          {t('harness.threads.surfacePending')}: {preview.surfaceTargetPaths.join(', ')}
        </p>
      ) : null}
      {conflicts.map((path) => (
        <div key={path.path} className="mt-2 rounded-md border border-border/50 bg-background/60 p-2">
          <div className="text-[11px] font-medium text-foreground">{path.path}</div>
          {path.conflictReason ? (
            <p className="mt-0.5 text-[10px] text-[var(--status-error)]">{path.conflictReason}</p>
          ) : null}
          <div className="mt-1 grid gap-1 md:grid-cols-3">
            <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-1 text-[10px]">{path.baselineText ?? '—'}</pre>
            <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-1 text-[10px]">{path.parentText ?? '—'}</pre>
            <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-1 text-[10px]">{path.childText ?? '—'}</pre>
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            <button type="button" className="rounded px-1.5 py-0.5 text-[10px] hover:bg-interactive-hover" onClick={() => choose(path.path, 'base')}>
              {t('harness.threads.chooseBase')}
            </button>
            <button type="button" className="rounded px-1.5 py-0.5 text-[10px] hover:bg-interactive-hover" onClick={() => choose(path.path, 'parent')}>
              {t('harness.threads.chooseParent')}
            </button>
            <button type="button" className="rounded px-1.5 py-0.5 text-[10px] hover:bg-interactive-hover" onClick={() => choose(path.path, 'child')}>
              {t('harness.threads.chooseChild')}
            </button>
          </div>
          {path.isText ? (
            <textarea
              className="mt-1 min-h-16 w-full rounded border border-border bg-background px-1.5 py-1 text-[10px]"
              value={resolutions[path.path]?.choice === 'text' ? resolutions[path.path]?.text ?? '' : path.parentText ?? ''}
              onChange={(event) => choose(path.path, 'text', event.target.value)}
            />
          ) : null}
        </div>
      ))}
      <div className="mt-2 flex justify-end gap-1.5">
        {lastOperationId ? (
          <button type="button" className="rounded px-2 py-1 text-[10px] text-muted-foreground hover:bg-interactive-hover" onClick={() => { void undo(); }}>
            {t('harness.threads.undoMerge')}
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy || !preview?.valid || unavailable.length > 0 || conflicts.some((path) => !resolutions[path.path])}
          onClick={() => { void merge(); }}
          className={cn('inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-[10px] text-primary-foreground disabled:opacity-50')}
        >
          <Icon name={busy ? 'loader-4' : 'git-merge'} className={cn('size-3', busy && 'animate-spin')} />
          {t(busy ? 'harness.threads.merging' : 'harness.threads.merge')}
        </button>
      </div>
    </div>
  );
};
