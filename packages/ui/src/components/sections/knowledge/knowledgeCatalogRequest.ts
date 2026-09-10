import { runtimeFetch } from '@piarium/application-client';

export type KnowledgeCatalogScope = 'workspace' | 'user';
export type KnowledgeCatalogStatus = 'suggested' | 'accepted' | 'dismissed';

export interface KnowledgeCatalogItem {
  id: number;
  scope: KnowledgeCatalogScope;
  status: KnowledgeCatalogStatus;
  content: string;
  trigger: string;
  createdAt: number;
  invalidAt?: number;
  recallCount: number;
  recalledAt?: number;
  source?: { sessionId: string; kind: string };
}

export interface KnowledgeCatalogChain {
  current: KnowledgeCatalogItem;
  predecessors: KnowledgeCatalogItem[];
  successors: KnowledgeCatalogItem[];
  chain: KnowledgeCatalogItem[];
}

const recordOf = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const scopeOf = (value: unknown): KnowledgeCatalogScope | null => (
  value === 'workspace' || value === 'user' ? value : null
);

const statusOf = (value: unknown): KnowledgeCatalogStatus | null => (
  value === 'suggested' || value === 'accepted' || value === 'dismissed' ? value : null
);

export const parseKnowledgeCatalogItem = (value: unknown): KnowledgeCatalogItem => {
  const item = recordOf(value);
  const scope = scopeOf(item?.scope);
  const status = statusOf(item?.status);
  const source = recordOf(item?.source);
  if (
    !item
    || !scope
    || !status
    || !Number.isSafeInteger(item.id)
    || Number(item.id) <= 0
    || typeof item.content !== 'string'
    || typeof item.trigger !== 'string'
    || typeof item.createdAt !== 'number'
    || !Number.isFinite(item.createdAt)
    || typeof item.recallCount !== 'number'
    || (item.invalidAt !== undefined && (typeof item.invalidAt !== 'number' || !Number.isFinite(item.invalidAt)))
    || (item.recalledAt !== undefined && (typeof item.recalledAt !== 'number' || !Number.isFinite(item.recalledAt)))
    || (source !== null && (typeof source.sessionId !== 'string' || typeof source.kind !== 'string'))
  ) throw new Error('Malformed knowledge catalog item');
  return {
    id: Number(item.id),
    scope,
    status,
    content: item.content,
    trigger: item.trigger,
    createdAt: item.createdAt,
    recallCount: item.recallCount,
    ...(typeof item.invalidAt === 'number' ? { invalidAt: item.invalidAt } : {}),
    ...(typeof item.recalledAt === 'number' ? { recalledAt: item.recalledAt } : {}),
    ...(source ? { source: { sessionId: source.sessionId as string, kind: source.kind as string } } : {}),
  };
};

export const parseKnowledgeCatalogList = (value: unknown): KnowledgeCatalogItem[] => {
  const response = recordOf(value);
  if (!response || !Array.isArray(response.items)) throw new Error('Malformed knowledge catalog list');
  return response.items.map(parseKnowledgeCatalogItem);
};

export const parseKnowledgeCatalogChain = (value: unknown): KnowledgeCatalogChain => {
  const response = recordOf(value);
  const chain = recordOf(response?.chain) ?? response;
  if (
    !chain
    || !Array.isArray(chain.predecessors)
    || !Array.isArray(chain.successors)
    || !Array.isArray(chain.chain)
  ) throw new Error('Malformed knowledge supersede chain');
  return {
    current: parseKnowledgeCatalogItem(chain.current),
    predecessors: chain.predecessors.map(parseKnowledgeCatalogItem),
    successors: chain.successors.map(parseKnowledgeCatalogItem),
    chain: chain.chain.map(parseKnowledgeCatalogItem),
  };
};

const workspaceQuery = (scope: KnowledgeCatalogScope, workspaceId?: string): string => {
  const params = new URLSearchParams({ scope });
  if (scope === 'workspace' && workspaceId) params.set('workspaceId', workspaceId);
  return params.toString();
};

const workspaceBody = (scope: KnowledgeCatalogScope, workspaceId?: string): Record<string, string> => (
  scope === 'workspace' && workspaceId ? { workspaceId } : {}
);

const readError = async (response: Response): Promise<string> => {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) return body.error;
  } catch {
    /* keep status text */
  }
  return `Knowledge request failed (${response.status})`;
};

export async function loadKnowledgeCatalog(
  scope: KnowledgeCatalogScope,
  workspaceId?: string,
  signal?: AbortSignal,
): Promise<KnowledgeCatalogItem[]> {
  const response = await runtimeFetch(`/api/harness/knowledge?${workspaceQuery(scope, workspaceId)}`, {
    cache: 'no-store',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(await readError(response));
  return parseKnowledgeCatalogList(await response.json());
}

export async function loadKnowledgeChain(
  scope: KnowledgeCatalogScope,
  id: number,
  workspaceId?: string,
  signal?: AbortSignal,
): Promise<KnowledgeCatalogChain> {
  const query = workspaceQuery(scope, workspaceId);
  const response = await runtimeFetch(`/api/harness/knowledge/${scope}/${id}/chain?${query}`, {
    cache: 'no-store',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(await readError(response));
  return parseKnowledgeCatalogChain(await response.json());
}

export async function saveKnowledgeCatalogItem(
  item: KnowledgeCatalogItem,
  draft: { content: string; trigger: string },
  workspaceId?: string,
): Promise<void> {
  const response = await runtimeFetch(`/api/harness/knowledge/${item.scope}/${item.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...workspaceBody(item.scope, workspaceId),
      content: draft.content,
      trigger: draft.trigger,
      expectedContent: item.content,
      expectedTrigger: item.trigger,
    }),
  });
  if (response.status === 409) throw Object.assign(new Error('conflict'), { code: 'conflict' });
  if (!response.ok) throw new Error(await readError(response));
}

export async function retireKnowledgeCatalogItem(
  item: KnowledgeCatalogItem,
  workspaceId?: string,
): Promise<void> {
  const response = await runtimeFetch(`/api/harness/knowledge/${item.scope}/${item.id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...workspaceBody(item.scope, workspaceId),
      expectedContent: item.content,
      expectedTrigger: item.trigger,
      expectedStatus: item.status,
      ...(item.invalidAt === undefined ? {} : { expectedInvalidAt: item.invalidAt }),
    }),
  });
  if (response.status === 409) throw Object.assign(new Error('conflict'), { code: 'conflict' });
  if (!response.ok) throw new Error(await readError(response));
}

export async function reviewKnowledgeCatalogItem(
  item: KnowledgeCatalogItem,
  action: 'accept' | 'dismiss',
  workspaceId?: string,
  supersedes: number[] = [],
): Promise<void> {
  const response = await runtimeFetch(`/api/harness/knowledge/${item.scope}/${item.id}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...workspaceBody(item.scope, workspaceId),
      supersedes,
    }),
  });
  if (response.status === 409) throw Object.assign(new Error('conflict'), { code: 'conflict' });
  if (!response.ok) throw new Error(await readError(response));
}
