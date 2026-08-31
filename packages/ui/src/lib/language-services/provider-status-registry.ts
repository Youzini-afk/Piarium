import type { PiariumLanguageProviderStatus } from '@piarium/application-client';

const listeners = new Set<() => void>();
const snapshots = new Map<string, PiariumLanguageProviderStatus>();

const keyFor = (workspaceId: string, languageId: string): string => `${workspaceId}\0${languageId}`;

const generationOf = (snapshot: PiariumLanguageProviderStatus | undefined): number => (
  snapshot && 'generation' in snapshot && typeof snapshot.generation === 'number'
    ? snapshot.generation
    : -1
);

const emit = (): void => {
  for (const listener of listeners) listener();
};

export const subscribeLanguageProviderStatus = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getLanguageProviderStatus = (
  workspaceId: string,
  languageId: string,
): PiariumLanguageProviderStatus => snapshots.get(keyFor(workspaceId, languageId)) ?? {
  status: 'absent',
  workspaceId,
  languageId,
};

export const peekLanguageProviderStatus = (
  workspaceId: string,
  languageId: string,
): PiariumLanguageProviderStatus | undefined => snapshots.get(keyFor(workspaceId, languageId));

export const replaceLanguageProviderStatus = (next: PiariumLanguageProviderStatus): void => {
  const key = keyFor(next.workspaceId, next.languageId);
  const current = snapshots.get(key);
  if (generationOf(next) >= 0 && generationOf(current) > generationOf(next)) return;
  if (
    current?.status === next.status
    && generationOf(current) === generationOf(next)
    && ('message' in current ? current.message : '') === ('message' in next ? next.message : '')
    && JSON.stringify('features' in current ? current.features : undefined) === JSON.stringify('features' in next ? next.features : undefined)
  ) return;
  snapshots.set(key, next);
  emit();
};

export const clearLanguageProviderStatusForWorkspace = (workspaceId: string): void => {
  let changed = false;
  for (const key of snapshots.keys()) {
    if (!key.startsWith(`${workspaceId}\0`)) continue;
    snapshots.delete(key);
    changed = true;
  }
  if (changed) emit();
};

export const resetLanguageProviderStatus = (): void => {
  if (snapshots.size === 0) return;
  snapshots.clear();
  emit();
};
