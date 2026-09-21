import type { PiRuntimeSnapshot } from '@varin/protocol';

export const shouldApplyPiRuntimeSnapshot = (
  currentRevision: number,
  next: PiRuntimeSnapshot,
): boolean => next.revision >= currentRevision;
