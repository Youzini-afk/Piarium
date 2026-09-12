import { runtimeFetch } from '@piarium/application-client';
import type {
  ThreadResultHistory,
  ThreadResultHistoryEntry,
  ThreadResultHistoryReleaseParams,
  ThreadResultHistoryReleaseResult,
  ThreadResultRetentionReason,
} from '@piarium/application-client';

const retentionReasons: readonly ThreadResultRetentionReason[] = [
  'branch-head',
  'current-result',
  'run-input',
  'review',
  'integration',
];

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isFiniteNonNegativeNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0
);

const isRetentionReason = (value: unknown): value is ThreadResultRetentionReason => (
  typeof value === 'string' && retentionReasons.includes(value as ThreadResultRetentionReason)
);

export class ThreadResultHistoryRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ThreadResultHistoryRequestError';
    this.status = status;
  }
}

function responseMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.error === 'string') return payload.error;
  return fallback;
}

function parseHistoryEntry(value: unknown): ThreadResultHistoryEntry {
  if (!isRecord(value)
    || !Number.isInteger(value.resultRevision)
    || typeof value.createdAt !== 'string'
    || !Array.isArray(value.changedPaths)
    || !value.changedPaths.every((path) => typeof path === 'string')
    || !isFiniteNonNegativeNumber(value.retainedBytes)
    || !Array.isArray(value.protectedReasons)
    || !value.protectedReasons.every(isRetentionReason)) {
    throw new Error('Malformed thread result history entry');
  }
  const resultRevision = value.resultRevision as number;
  return {
    resultRevision,
    createdAt: value.createdAt,
    changedPaths: value.changedPaths,
    retainedBytes: value.retainedBytes,
    protectedReasons: value.protectedReasons,
  };
}

export function parseThreadResultHistory(value: unknown): ThreadResultHistory {
  if (!isRecord(value)
    || typeof value.workspaceId !== 'string'
    || typeof value.threadId !== 'string'
    || (value.branchId !== null && typeof value.branchId !== 'string')
    || !Array.isArray(value.results)) {
    throw new Error('Malformed thread result history');
  }
  return {
    workspaceId: value.workspaceId,
    threadId: value.threadId,
    branchId: value.branchId,
    results: value.results.map(parseHistoryEntry),
  };
}

function isCleanup(value: unknown): value is ThreadResultHistoryReleaseResult['cleanup'] {
  if (!isRecord(value) || (value.status !== 'complete' && value.status !== 'failed')) return false;
  if (value.status === 'failed') return typeof value.message === 'string';
  return Number.isInteger(value.objectsDeleted)
    && (value.objectsDeleted as number) >= 0
    && isFiniteNonNegativeNumber(value.byteLengthReclaimed);
}

export function parseThreadResultHistoryReleaseResult(value: unknown): ThreadResultHistoryReleaseResult {
  if (!isRecord(value)
    || !Array.isArray(value.releasedRevisions)
    || !value.releasedRevisions.every((revision) => Number.isInteger(revision))
    || !Array.isArray(value.missingRevisions)
    || !value.missingRevisions.every((revision) => Number.isInteger(revision))
    || !isCleanup(value.cleanup)) {
    throw new Error('Malformed thread result history release result');
  }
  return {
    releasedRevisions: value.releasedRevisions as number[],
    missingRevisions: value.missingRevisions as number[],
    cleanup: value.cleanup,
  };
}

function historyPath(parentSessionId: string, threadId: string): string {
  return `/api/harness/sessions/${encodeURIComponent(parentSessionId)}/threads/${encodeURIComponent(threadId)}/history`;
}

export async function loadThreadResultHistory(
  parentSessionId: string,
  threadId: string,
  signal?: AbortSignal,
): Promise<ThreadResultHistory> {
  const response = await runtimeFetch(historyPath(parentSessionId, threadId), {
    cache: 'no-store',
    ...(signal ? { signal } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ThreadResultHistoryRequestError(
      responseMessage(payload, `Unable to load thread result history (${response.status})`),
      response.status,
    );
  }
  return parseThreadResultHistory(payload);
}

export async function releaseThreadResultHistory(
  parentSessionId: string,
  threadId: string,
  params: ThreadResultHistoryReleaseParams,
  signal?: AbortSignal,
): Promise<ThreadResultHistoryReleaseResult> {
  const response = await runtimeFetch(`${historyPath(parentSessionId, threadId)}/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    ...(signal ? { signal } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ThreadResultHistoryRequestError(
      responseMessage(payload, `Unable to release thread result history (${response.status})`),
      response.status,
    );
  }
  return parseThreadResultHistoryReleaseResult(payload);
}
