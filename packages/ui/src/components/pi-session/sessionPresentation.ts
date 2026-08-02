import type { SessionSummary } from '@piarium/protocol';

export interface PiSessionNode {
  children: PiSessionNode[];
  session: SessionSummary;
}

export type PiSessionPinnedPredicate = (session: SessionSummary) => boolean;

const timestamp = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const piSessionTitle = (session: SessionSummary, untitled: string): string => {
  const name = session.name?.trim();
  if (name) return name;
  const firstLine = session.firstMessage
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ?? untitled;
};

export const comparePiSessions = (
  left: SessionSummary,
  right: SessionSummary,
  isPinned: PiSessionPinnedPredicate = () => false,
): number => {
  const leftPinned = isPinned(left);
  const rightPinned = isPinned(right);
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
  const updated = timestamp(right.updatedAt) - timestamp(left.updatedAt);
  if (updated !== 0) return updated;
  const created = timestamp(right.createdAt) - timestamp(left.createdAt);
  if (created !== 0) return created;
  return left.id.localeCompare(right.id);
};

export const collectPiSessionSubtreeIds = (
  summaries: SessionSummary[],
  rootId: string,
): string[] => {
  const root = summaries.find((summary) => summary.id === rootId);
  if (!root) return [];
  const archived = root.archivedAt !== undefined;
  const children = new Map<string, string[]>();
  for (const summary of summaries) {
    if (!summary.parentId || (summary.archivedAt !== undefined) !== archived) continue;
    const siblings = children.get(summary.parentId) ?? [];
    siblings.push(summary.id);
    children.set(summary.parentId, siblings);
  }

  const ids: string[] = [];
  const visited = new Set<string>();
  const pending = [rootId];
  while (pending.length > 0) {
    const sessionId = pending.pop();
    if (!sessionId || visited.has(sessionId)) continue;
    visited.add(sessionId);
    ids.push(sessionId);
    const childIds = children.get(sessionId) ?? [];
    for (let index = childIds.length - 1; index >= 0; index -= 1) {
      const childId = childIds[index];
      if (childId) pending.push(childId);
    }
  }
  return ids;
};

const createsParentCycle = (
  sessionId: string,
  parentId: string,
  sessions: ReadonlyMap<string, SessionSummary>,
): boolean => {
  const visited = new Set<string>([sessionId]);
  let candidateId: string | undefined = parentId;
  while (candidateId !== undefined) {
    if (visited.has(candidateId)) return true;
    visited.add(candidateId);
    const candidate = sessions.get(candidateId);
    candidateId = candidate?.parentId ?? undefined;
  }
  return false;
};

export const buildPiSessionForest = (
  input: SessionSummary[],
  isPinned: PiSessionPinnedPredicate = () => false,
): PiSessionNode[] => {
  const sessions = new Map<string, SessionSummary>();
  for (const session of input) {
    const current = sessions.get(session.id);
    if (!current || comparePiSessions(session, current) < 0) sessions.set(session.id, session);
  }

  const nodes = new Map<string, PiSessionNode>();
  for (const session of sessions.values()) {
    nodes.set(session.id, { children: [], session });
  }

  const roots: PiSessionNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.session.parentId;
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (
      parent === undefined
      || (parent.session.archivedAt === undefined) !== (node.session.archivedAt === undefined)
      || createsParentCycle(node.session.id, parentId!, sessions)
    ) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }

  const sortNodes = (items: PiSessionNode[]): void => {
    items.sort((left, right) => comparePiSessions(left.session, right.session, isPinned));
    for (const item of items) sortNodes(item.children);
  };
  sortNodes(roots);
  return roots;
};

export const filterPiSessionForest = (
  nodes: PiSessionNode[],
  query: string,
  untitled: string,
): PiSessionNode[] => {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return nodes;

  return nodes.flatMap((node) => {
    const session = node.session;
    const searchable = [
      piSessionTitle(session, untitled),
      session.cwd,
      session.firstMessage,
      session.allMessagesText,
    ].join('\n').toLocaleLowerCase();
    const children = filterPiSessionForest(node.children, normalizedQuery, untitled);
    if (searchable.includes(normalizedQuery) || children.length > 0) {
      return [{ ...node, children }];
    }
    return [];
  });
};
