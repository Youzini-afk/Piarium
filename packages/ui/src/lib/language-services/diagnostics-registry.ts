import type { PiariumLanguageDiagnostic } from '@/lib/api/types';
import { setWorkbenchProblems } from '@/lib/workbench/editors/panels';

const recordKey = (workspaceId: string, resourceId: string, languageId: string): string => (
  `${workspaceId}\0${resourceId}\0${languageId}`
);

const listeners = new Set<() => void>();
const byKey = new Map<string, PiariumLanguageDiagnostic[]>();
const byResource = new Map<string, readonly PiariumLanguageDiagnostic[]>();
const EMPTY_DIAGNOSTICS: readonly PiariumLanguageDiagnostic[] = [];

const resourceKey = (workspaceId: string, resourceId: string): string => (
  `${workspaceId}\0${resourceId}`
);

const rebuildResourceSnapshot = (workspaceId: string, resourceId: string): void => {
  const items: PiariumLanguageDiagnostic[] = [];
  const prefix = `${workspaceId}\0${resourceId}\0`;
  for (const [key, diagnostics] of byKey) {
    if (key.startsWith(prefix)) items.push(...diagnostics);
  }
  const key = resourceKey(workspaceId, resourceId);
  if (items.length === 0) byResource.delete(key);
  else byResource.set(key, items);
};

const emit = (): void => {
  for (const listener of listeners) listener();
};

export const subscribeLanguageDiagnostics = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getLanguageDiagnosticsForResource = (
  workspaceId: string,
  resourceId: string,
): readonly PiariumLanguageDiagnostic[] => (
  byResource.get(resourceKey(workspaceId, resourceId)) ?? EMPTY_DIAGNOSTICS
);

const publish = (workspaceId: string): void => {
  const items = [];
  for (const [key, diagnostics] of byKey) {
    if (!key.startsWith(`${workspaceId}\0`)) continue;
    for (const item of diagnostics) {
      if (item.severity === 'hint') continue;
      const next: {
        resourceId: string;
        message: string;
        severity: 'error' | 'warning' | 'info';
        line?: number;
        column?: number;
      } = {
        resourceId: item.resource.resourceId,
        message: item.message,
        severity: item.severity === 'error' || item.severity === 'warning' ? item.severity : 'info',
      };
      if (Number.isFinite(item.range.start.line)) next.line = item.range.start.line + 1;
      if (Number.isFinite(item.range.start.character)) next.column = item.range.start.character + 1;
      items.push(next);
    }
  }
  if (items.length === 0) {
    setWorkbenchProblems(workspaceId, { status: 'empty' });
    emit();
    return;
  }
  setWorkbenchProblems(workspaceId, { status: 'ready', items });
  emit();
};

export const replaceLanguageDiagnostics = (
  workspaceId: string,
  languageId: string,
  resourceId: string,
  items: PiariumLanguageDiagnostic[],
  acceptedVersion: (resourceId: string, documentVersion: number) => boolean,
): void => {
  const key = recordKey(workspaceId, resourceId, languageId);
  const accepted = items.filter((item) => acceptedVersion(item.resource.resourceId, item.documentVersion));
  if (items.length > 0 && accepted.length === 0) {
    return;
  }
  if (accepted.length === 0) {
    byKey.delete(key);
  } else {
    byKey.set(key, accepted);
  }
  rebuildResourceSnapshot(workspaceId, resourceId);
  publish(workspaceId);
};

export const clearLanguageDiagnosticsForWorkspace = (workspaceId: string): void => {
  for (const [key] of byKey) {
    if (key.startsWith(`${workspaceId}\0`)) byKey.delete(key);
  }
  for (const [key] of byResource) {
    if (key.startsWith(`${workspaceId}\0`)) byResource.delete(key);
  }
  setWorkbenchProblems(workspaceId, { status: 'empty' });
  emit();
};

export const resetLanguageDiagnostics = (): void => {
  byKey.clear();
  byResource.clear();
  emit();
};
