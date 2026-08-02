import type { SessionSnapshot } from '@piarium/protocol';

export type PiSessionActivityPhase = 'idle' | 'busy' | 'retry';

export interface PiSessionActivity {
  isBusy: boolean;
  isCooldown: boolean;
  isWorking: boolean;
  phase: PiSessionActivityPhase;
}

export const IDLE_PI_SESSION_ACTIVITY: PiSessionActivity = {
  isBusy: false,
  isCooldown: false,
  isWorking: false,
  phase: 'idle',
};

export const projectPiSessionActivity = (
  snapshot: SessionSnapshot | undefined,
): PiSessionActivity => {
  if (!snapshot) return IDLE_PI_SESSION_ACTIVITY;
  if (snapshot.retryAttempt > 0) {
    return {
      isBusy: false,
      isCooldown: true,
      isWorking: true,
      phase: 'retry',
    };
  }
  if (snapshot.busy || snapshot.isStreaming || snapshot.isCompacting) {
    return {
      isBusy: true,
      isCooldown: false,
      isWorking: true,
      phase: 'busy',
    };
  }
  return IDLE_PI_SESSION_ACTIVITY;
};
