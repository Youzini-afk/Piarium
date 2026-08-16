import type { PiRuntimeSnapshot } from '@piarium/protocol';

export const shouldApplyPiRuntimeSnapshot = (
  currentRevision: number,
  next: PiRuntimeSnapshot,
): boolean => next.revision >= currentRevision;
