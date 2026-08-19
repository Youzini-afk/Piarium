import type {
  PiFleetEntry,
  PiFleetEntryKind,
  PiFleetEntryState,
  PiFleetProviderSnapshot,
  PiFleetProviderState,
  PiFleetSnapshot,
} from '@piarium/protocol';

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

export const fleetEntryIdentity = (
  entry: Pick<PiFleetEntry, 'key' | 'providerId'>,
): string => `${entry.providerId}:${entry.key}`;

export type FleetKindFilter = 'all' | PiFleetEntryKind;
export type FleetStateFilter = 'all' | PiFleetEntryState;

interface FleetFilterState {
  kind: FleetKindFilter;
  providerId: 'all' | string;
  query: string;
  state: FleetStateFilter;
}

export const filterFleetEntries = (
  entries: readonly PiFleetEntry[],
  filters: FleetFilterState,
): PiFleetEntry[] => {
  const query = filters.query.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    if (filters.providerId !== 'all' && entry.providerId !== filters.providerId) return false;
    if (filters.kind !== 'all' && entry.kind !== filters.kind) return false;
    if (filters.state !== 'all' && entry.state !== filters.state) return false;
    if (!query) return true;
    const haystack = [
      entry.name,
      entry.description,
      entry.agent,
      entry.model,
      entry.role,
      entry.providerId,
    ]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' ')
      .toLocaleLowerCase();
    return haystack.includes(query);
  });
};

export const findFleetEntry = (
  snapshot: PiFleetSnapshot | null,
  identity: string | null,
): PiFleetEntry | undefined => {
  if (!snapshot || !identity) return undefined;
  return snapshot.entries.find((entry) => fleetEntryIdentity(entry) === identity);
};

export const providerAdvertisesAction = (
  provider: PiFleetProviderSnapshot | undefined,
  action: string,
): boolean => Boolean(provider?.actions?.some((item) => item.action === action));

export const entryAdvertisesAction = (entry: PiFleetEntry, action: string): boolean => (
  entry.actions.some((item) => item.action === action)
);

export const runningFleetEntries = (entries: readonly PiFleetEntry[]): PiFleetEntry[] => (
  entries.filter((entry) => entry.state === 'running')
);

export const findFleetProvider = (
  providers: readonly PiFleetProviderSnapshot[],
  providerId: string,
): PiFleetProviderSnapshot | undefined => (
  providers.find((provider) => provider.id === providerId)
);
