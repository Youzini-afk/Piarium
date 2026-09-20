import * as React from 'react';
import { runtimeFetch } from '@piarium/application-client';
import type { FollowUpDefinitionView, FollowUpListResult } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { subscribePiariumEvents } from '@/lib/piariumEvents';
import { toast } from '@/components/ui/toast';

/**
 * Session waiting entries (W3, D-307): the durable follow-ups the agent
 * registered on this session — what it waits for and what runs next. Check is
 * a program-side source evaluation; fire invokes the agent; cancel only stops
 * the wait, never the watched work.
 */

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const parseView = (value: unknown): FollowUpDefinitionView | null => {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || typeof value.status !== 'string') return null;
  if (typeof value.waitingSummary !== 'string' || typeof value.instruction !== 'string') return null;
  return value as unknown as FollowUpDefinitionView;
};

const loadFollowUps = async (sessionId: string, signal?: AbortSignal): Promise<FollowUpDefinitionView[] | null> => {
  const response = await runtimeFetch(
    `/api/harness/sessions/${encodeURIComponent(sessionId)}/follow-ups`,
    { cache: 'no-store', ...(signal ? { signal } : {}) },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Follow-up list failed (${response.status})`);
  const body = await response.json() as unknown;
  if (!isRecord(body) || !Array.isArray(body.followUps)) return [];
  return (body as unknown as FollowUpListResult).followUps
    .map(parseView)
    .filter((entry): entry is FollowUpDefinitionView => entry !== null);
};

const postFollowUpAction = async (
  sessionId: string,
  id: string,
  action: 'cancel' | 'check' | 'fire',
): Promise<void> => {
  const response = await runtimeFetch(
    `/api/harness/sessions/${encodeURIComponent(sessionId)}/follow-ups/${encodeURIComponent(id)}/${action}`,
    { method: 'POST', cache: 'no-store' },
  );
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message = isRecord(body) && typeof body.error === 'string' ? body.error : `${action} failed (${response.status})`;
    throw new Error(message);
  }
};

const STATUS_TONE: Record<string, string> = {
  waiting: 'text-[var(--status-warning)]',
  triggered: 'text-[var(--status-warning)]',
  delivered: 'text-[var(--status-success)]',
  cancelled: 'text-muted-foreground',
  superseded: 'text-muted-foreground',
  unavailable: 'text-[var(--status-error)]',
};

export const PiFollowUpsStrip: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const { t } = useI18n();
  const [followUps, setFollowUps] = React.useState<FollowUpDefinitionView[] | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const refresh = React.useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await loadFollowUps(sessionId, signal);
      if (!signal?.aborted) setFollowUps(result);
    } catch {
      if (!signal?.aborted) setFollowUps(null);
    }
  }, [sessionId]);

  React.useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const unsubscribe = subscribePiariumEvents((event) => {
      if (event.type === 'harness-experiment-changed' && event.fact === 'followup') {
        void refresh();
      }
    });
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [refresh]);

  const act = React.useCallback(async (id: string, action: 'cancel' | 'check' | 'fire') => {
    setBusyId(id);
    try {
      await postFollowUpAction(sessionId, id, action);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  }, [refresh, sessionId]);

  if (!followUps || followUps.length === 0) return null;

  return (
    <div className="mx-auto mb-2 flex w-full max-w-4xl min-w-0 flex-col gap-1 rounded-lg border border-border/70 bg-muted/15 px-3 py-2">
      {followUps.map((entry) => (
        <div key={entry.id} className="flex min-w-0 items-center gap-2">
          <Icon name="timer" className="size-3.5 shrink-0 text-muted-foreground" />
          <span
            className="min-w-0 flex-1 truncate typography-meta text-foreground"
            title={`${entry.waitingSummary} → ${entry.instruction}`}
          >
            {entry.waitingSummary}
            <span className="text-muted-foreground"> → {entry.instruction}</span>
          </span>
          <span className={`shrink-0 typography-meta ${STATUS_TONE[entry.status] ?? 'text-muted-foreground'}`}>
            {t(`chat.followup.status.${entry.status}` as never)}
          </span>
          {(entry.status === 'waiting' || entry.status === 'triggered') && (
            <span className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                disabled={busyId === entry.id}
                onClick={() => void act(entry.id, 'check')}
                title={t('chat.followup.action.checkHint')}
                className="rounded px-1.5 py-0.5 typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
              >
                {t('chat.followup.action.check')}
              </button>
              <button
                type="button"
                disabled={busyId === entry.id}
                onClick={() => void act(entry.id, 'fire')}
                title={t('chat.followup.action.fireHint')}
                className="rounded px-1.5 py-0.5 typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
              >
                {t('chat.followup.action.fire')}
              </button>
              <button
                type="button"
                disabled={busyId === entry.id}
                onClick={() => void act(entry.id, 'cancel')}
                title={t('chat.followup.action.cancelHint')}
                className="rounded px-1.5 py-0.5 typography-meta text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
              >
                {t('chat.followup.action.cancel')}
              </button>
            </span>
          )}
        </div>
      ))}
    </div>
  );
};
