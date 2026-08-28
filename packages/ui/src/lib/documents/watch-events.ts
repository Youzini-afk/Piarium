import type { PiariumWorkspaceFileEvent } from '@/lib/api/types';

type WatchPosition = Pick<PiariumWorkspaceFileEvent, 'sourceId' | 'generation' | 'sequence'>;

export const createDocumentWatchEventTracker = (
  listener: (event: PiariumWorkspaceFileEvent) => void,
) => {
  let previous: WatchPosition | null = null;

  const reset = (
    reason: Extract<PiariumWorkspaceFileEvent, { kind: 'reset' }>['reason'],
    position = previous,
  ) => {
    listener({
      kind: 'reset',
      reason,
      sourceId: position?.sourceId ?? 'client-transport',
      generation: position?.generation ?? 0,
      sequence: position?.sequence ?? 0,
    });
  };

  return {
    accept(event: PiariumWorkspaceFileEvent): void {
      if (previous && event.sourceId !== previous.sourceId) {
        previous = event;
        reset('authority-changed', event);
        return;
      }
      if (previous && event.generation !== previous.generation) {
        previous = event;
        reset(event.kind === 'reset' ? event.reason : 'authority-changed', event);
        return;
      }
      if (previous && event.sequence !== previous.sequence + 1) {
        previous = event;
        reset(event.kind === 'reset' ? event.reason : 'gap', event);
        return;
      }
      previous = event;
      listener(event);
    },
    transportReset(reason: 'reconnected' | 'authority-changed'): void {
      reset(reason);
      previous = null;
    },
  };
};
