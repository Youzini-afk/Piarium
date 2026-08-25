import type { DocumentWorkspaceEditPreview } from '@/lib/documents/types';
import { subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';

export type WorkspaceEditReviewKind = 'rename' | 'code-action';

export type WorkspaceEditReviewRequest = {
  id: string;
  kind: WorkspaceEditReviewKind;
  label?: string;
  preview: DocumentWorkspaceEditPreview;
};

type QueuedReview = WorkspaceEditReviewRequest & {
  resolve(accepted: boolean): void;
};

const listeners = new Set<() => void>();
const queue: QueuedReview[] = [];
let active: QueuedReview | null = null;

const emit = (): void => {
  for (const listener of listeners) listener();
};

const advance = (): void => {
  active = queue.shift() ?? null;
  emit();
};

export const subscribeWorkspaceEditReview = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getWorkspaceEditReviewSnapshot = (): WorkspaceEditReviewRequest | null => active;

export const requestWorkspaceEditReview = (
  preview: DocumentWorkspaceEditPreview,
  options: { kind: WorkspaceEditReviewKind; label?: string },
): Promise<boolean> => new Promise((resolve) => {
  const request: QueuedReview = {
    id: crypto.randomUUID(),
    kind: options.kind,
    preview,
    resolve,
    ...(options.label ? { label: options.label } : {}),
  };
  if (active) queue.push(request);
  else {
    active = request;
    emit();
  }
});

export const resolveWorkspaceEditReview = (id: string, accepted: boolean): void => {
  if (!active || active.id !== id) return;
  const current = active;
  active = null;
  current.resolve(accepted);
  advance();
};

export const cancelAllWorkspaceEditReviews = (): void => {
  const pending = [...(active ? [active] : []), ...queue];
  active = null;
  queue.length = 0;
  for (const request of pending) request.resolve(false);
  emit();
};

subscribeRuntimeEndpointWillChange(cancelAllWorkspaceEditReviews);
