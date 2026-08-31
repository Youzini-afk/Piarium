import type { SessionSnapshot, SessionSummary } from '@piarium/protocol';
import type { ProjectEntry } from '@piarium/application-client';
import { findPiProjectForCwd } from './sessionNavigation';

export type PiTraySessionStatus = 'idle' | 'busy' | 'retry';

export interface PiTraySession {
  branch: string;
  directory: string;
  hasError: boolean;
  id: string;
  status: PiTraySessionStatus;
  subtitle: string;
  title: string;
  unseen: number;
}

export interface PiTraySessionRecord {
  snapshot?: SessionSnapshot;
}

const basenameOf = (path: string): string => {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const separator = normalized.lastIndexOf('/');
  return separator >= 0 ? normalized.slice(separator + 1) : normalized;
};

const readableTitle = (summary: SessionSummary, snapshot?: SessionSnapshot): string => {
  const candidate = snapshot?.name || summary.name || summary.firstMessage;
  return candidate?.replace(/\s+/g, ' ').trim() || 'Untitled session';
};

const statusForSnapshot = (snapshot?: SessionSnapshot): PiTraySessionStatus => {
  if (!snapshot) return 'idle';
  if (snapshot.retryAttempt > 0) return 'retry';
  return snapshot.busy || snapshot.isStreaming || snapshot.isCompacting ? 'busy' : 'idle';
};

const rollupStatus = (
  sessionIds: string[],
  records: Record<string, PiTraySessionRecord>,
): PiTraySessionStatus => {
  const statuses = sessionIds.map((id) => statusForSnapshot(records[id]?.snapshot));
  if (statuses.includes('busy')) return 'busy';
  if (statuses.includes('retry')) return 'retry';
  return 'idle';
};

const collectFamilyIds = (
  rootId: string,
  childrenByParent: Map<string, string[]>,
): string[] => {
  const family = [rootId];
  const seen = new Set(family);
  const pending = [...(childrenByParent.get(rootId) ?? [])];
  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    family.push(id);
    pending.push(...(childrenByParent.get(id) ?? []));
  }
  return family;
};

const subtitleForDirectory = (projects: ProjectEntry[], directory: string): string => {
  if (!directory) return '';
  const project = findPiProjectForCwd(projects, directory);
  return project?.label?.trim() || (project ? basenameOf(project.path) : basenameOf(directory));
};

export const projectPiTraySessions = (
  summaries: SessionSummary[],
  records: Record<string, PiTraySessionRecord>,
  projects: ProjectEntry[],
): PiTraySession[] => {
  const active = summaries.filter((summary) => summary.archivedAt === undefined);
  const activeIds = new Set(active.map((summary) => summary.id));
  const childrenByParent = new Map<string, string[]>();
  for (const summary of active) {
    if (!summary.parentId || !activeIds.has(summary.parentId)) continue;
    const children = childrenByParent.get(summary.parentId) ?? [];
    children.push(summary.id);
    childrenByParent.set(summary.parentId, children);
  }

  const naturalRoots = active.filter((summary) => !summary.parentId || !activeIds.has(summary.parentId));
  // Invalid cyclic metadata must not make every session disappear from the tray.
  const roots = naturalRoots.length > 0 ? naturalRoots : active;

  return roots
    .slice()
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((summary) => {
      const snapshot = records[summary.id]?.snapshot;
      const directory = snapshot?.cwd || summary.cwd;
      return {
        branch: '',
        directory,
        hasError: false,
        id: summary.id,
        status: rollupStatus(collectFamilyIds(summary.id, childrenByParent), records),
        subtitle: subtitleForDirectory(projects, directory),
        title: readableTitle(summary, snapshot),
        unseen: 0,
      };
    });
};
