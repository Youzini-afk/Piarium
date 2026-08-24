import type { PiariumDebugSessionStatus } from '@/lib/api/types';

export interface IdeDebugControlAvailability {
  canContinue: boolean;
  canStart: boolean;
  canStep: boolean;
  canStop: boolean;
}

export const ideDebugControlAvailability = (
  snapshot: PiariumDebugSessionStatus | null,
): IdeDebugControlAvailability => {
  const status = snapshot?.status ?? null;
  const active = status === 'starting' || status === 'running' || status === 'paused';
  const paused = status === 'paused';
  return {
    canContinue: paused,
    canStart: status !== null && !active,
    canStep: paused,
    canStop: active,
  };
};
