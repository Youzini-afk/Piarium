import type { PiFleetProviderState } from '@piarium/protocol';

const fleetDurationSeconds = (startedAt: number, now: number): number => (
  Math.max(0, Math.floor((now - startedAt) / 1000))
);

export const formatFleetDuration = (startedAt: number, now: number): string => {
  const totalSeconds = fleetDurationSeconds(startedAt, now);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
};

export const fleetProviderTone = (
  state: PiFleetProviderState,
): 'error' | 'success' | 'warning' | 'muted' => {
  switch (state) {
    case 'active':
      return 'success';
    case 'degraded':
      return 'warning';
    case 'incompatible':
      return 'error';
    case 'unavailable':
    default:
      return 'muted';
  }
};
