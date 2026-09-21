import { runtimeFetch } from '@piarium/application-client';
import type { FollowUpDefinitionView } from '@piarium/protocol';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

export async function fetchFollowUps(options: { sessionId?: string; includeInactive?: boolean; signal?: AbortSignal } = {}): Promise<FollowUpDefinitionView[] | null> {
  const path = options.sessionId
    ? `/api/harness/sessions/${encodeURIComponent(options.sessionId)}/follow-ups`
    : '/api/harness/follow-ups';
  const response = await runtimeFetch(`${path}${options.includeInactive ? '?includeInactive=true' : ''}`, {
    cache: 'no-store', signal: options.signal,
  });
  if (response.status === 404 && options.sessionId) return null;
  if (!response.ok) throw new Error(`Follow-up list failed (${response.status})`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.followUps) || body.followUps.some((entry: unknown) => (
    !isRecord(entry) || typeof entry.id !== 'string' || typeof entry.sessionId !== 'string'
    || typeof entry.status !== 'string' || typeof entry.waitingSummary !== 'string' || typeof entry.instruction !== 'string'
  ))) throw new Error('Invalid follow-up list response');
  return body.followUps as FollowUpDefinitionView[];
}

export async function postFollowUpAction(
  sessionId: string,
  id: string,
  action: 'cancel' | 'check' | 'fire',
  expectedRevision?: string,
): Promise<void> {
  const response = await runtimeFetch(
    `/api/harness/sessions/${encodeURIComponent(sessionId)}/follow-ups/${encodeURIComponent(id)}/${action}`,
    {
      method: 'POST', cache: 'no-store',
      ...(expectedRevision === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision }),
      }),
    },
  );
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new Error(isRecord(body) && typeof body.error === 'string' ? body.error : `${action} failed (${response.status})`);
  }
}
