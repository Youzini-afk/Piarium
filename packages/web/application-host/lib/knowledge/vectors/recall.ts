import type { Knowledge, KnowledgeScope, KnowledgeStore, RecallResult } from "../store.js";
import type {
  KnowledgeVectorRuntime,
  KnowledgeVectorScopeSearch,
  KnowledgeVectorStatus,
} from "./runtime.js";

const RRF_K = 60;

export type KnowledgeRecallDetails = {
  vector: KnowledgeVectorStatus;
  spaceId?: string;
};

type Candidate = {
  key: string;
  item: Knowledge;
  authority: KnowledgeStore;
};

const candidateKey = (scope: KnowledgeScope, id: number): string => `${scope}:${id}`;

const textScore = (query: string, item: Knowledge): number => {
  const haystack = `${item.content} ${item.trigger}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean)
    .reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
};

const rankText = (candidates: readonly Candidate[], query: string): Map<string, number> => {
  const ranked = candidates
    .map((candidate) => ({ candidate, score: textScore(query, candidate.item) }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || left.candidate.key.localeCompare(right.candidate.key));
  return new Map(ranked.map((row, index) => [row.candidate.key, index + 1]));
};

const nodeOf = (current: Knowledge): RecallResult["node"] => ({
  id: current.id,
  type: "knowledge",
  payload: {
    type: "knowledge",
    scope: current.scope,
    status: current.status,
    content: current.content,
    trigger: current.trigger,
    createdAt: current.createdAt,
    recallCount: current.recallCount,
    ...(current.source ? { source: current.source } : {}),
    ...(current.invalidAt !== undefined ? { invalidAt: current.invalidAt } : {}),
    ...(current.recalledAt !== undefined ? { recalledAt: current.recalledAt } : {}),
  },
});

const combineStatus = (statuses: readonly KnowledgeVectorStatus[]): KnowledgeVectorStatus => {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("partial")) return "partial";
  if (statuses.includes("unavailable")) return "unavailable";
  if (statuses.includes("used")) return "used";
  if (statuses.includes("empty")) return "empty";
  return "unconfigured";
};

const acceptedCandidates = async (
  authority: KnowledgeStore,
  scope: KnowledgeScope,
): Promise<Candidate[]> => (await authority.listKnowledge({ status: "accepted", activeOnly: true }))
  .filter((item) => item.scope === scope)
  .map((item) => ({ key: candidateKey(scope, item.id), item, authority }));

async function recallCandidates(input: {
  candidates: Candidate[];
  query: string;
  k: number;
  vectors?: KnowledgeVectorRuntime;
  vectorScopes?: readonly KnowledgeVectorScopeSearch[];
  workspaceId?: string;
  signal?: AbortSignal;
}): Promise<{ results: RecallResult[]; details: KnowledgeRecallDetails }> {
  input.signal?.throwIfAborted();
  const textRanks = rankText(input.candidates, input.query);
  const vectorRanks = new Map<string, number>();
  let vectorStatus: KnowledgeVectorStatus = input.vectors ? "unavailable" : "unconfigured";
  let spaceId: string | undefined;

  if (input.vectors && input.workspaceId && input.vectorScopes && input.vectorScopes.length > 0) {
    const vectorResults = await input.vectors.searchScopes({
      scopes: input.vectorScopes,
      workspaceId: input.workspaceId,
      query: input.query,
      // Runtime aggregates blocks before applying this limit, so this covers
      // every valid knowledge candidate before RRF truncates the final list.
      limit: Math.max(input.k, input.candidates.length),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    vectorStatus = combineStatus(vectorResults.map((row) => row.result.status));
    spaceId = vectorResults.find((row) => row.result.spaceId !== undefined)?.result.spaceId;
    const vectorRows = vectorResults.flatMap((row) => row.result.hits.map((hit) => ({
      key: candidateKey(row.scope, hit.knowledgeId),
      similarity: hit.similarity,
    })));
    vectorRows.sort((left, right) => right.similarity - left.similarity || left.key.localeCompare(right.key));
    for (const [index, row] of vectorRows.entries()) {
      if (!vectorRanks.has(row.key)) vectorRanks.set(row.key, index + 1);
    }
  }

  const merged = input.candidates
    .map((candidate) => {
      const text = textRanks.get(candidate.key);
      const vector = vectorRanks.get(candidate.key);
      return {
        candidate,
        score: (text === undefined ? 0 : 1 / (RRF_K + text))
          + (vector === undefined ? 0 : 1 / (RRF_K + vector)),
        via: vector === undefined ? "text" as const : "vector" as const,
      };
    })
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || left.candidate.key.localeCompare(right.candidate.key));

  const results: RecallResult[] = [];
  for (const row of merged) {
    input.signal?.throwIfAborted();
    const current = await row.candidate.authority.getKnowledge(row.candidate.item.id);
    if (!current || current.scope !== row.candidate.item.scope
      || current.status !== "accepted" || current.invalidAt !== undefined
      || current.content !== row.candidate.item.content || current.trigger !== row.candidate.item.trigger) continue;
    results.push({ node: nodeOf(current), score: row.score, via: row.via });
    if (results.length >= input.k) break;
  }

  // Record only final, authority-checked results. Intermediate per-scope
  // rankings must not inflate recall counts for entries dropped by RRF.
  const byAuthority = new Map<KnowledgeStore, number[]>();
  for (const result of results) {
    const candidate = input.candidates.find((row) => row.item.id === result.node.id
      && row.item.scope === (result.node.payload as Record<string, unknown>)["scope"]);
    if (!candidate) continue;
    const ids = byAuthority.get(candidate.authority) ?? [];
    ids.push(result.node.id);
    byAuthority.set(candidate.authority, ids);
  }
  await Promise.all([...byAuthority.entries()].map(([authority, ids]) => authority.recordRecall(ids)));
  return {
    results,
    details: spaceId === undefined ? { vector: vectorStatus } : { vector: vectorStatus, spaceId },
  };
}

export async function recallKnowledge(input: {
  authority: KnowledgeStore;
  scope: KnowledgeScope;
  scopeId: string;
  workspaceId?: string;
  query: string;
  k: number;
  vectors?: KnowledgeVectorRuntime;
  signal?: AbortSignal;
}): Promise<{ results: RecallResult[]; details: KnowledgeRecallDetails }> {
  const candidates = await acceptedCandidates(input.authority, input.scope);
  return recallCandidates({
    candidates,
    query: input.query,
    k: input.k,
    ...(input.vectors ? { vectors: input.vectors } : {}),
    ...(input.vectors && input.workspaceId ? {
      vectorScopes: [{ authority: input.authority, scope: input.scope, scopeId: input.scopeId }],
      workspaceId: input.workspaceId,
    } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

export async function recallWorkspaceAndUser(input: {
  workspaceStore: KnowledgeStore;
  userStore: KnowledgeStore | null;
  workspaceId?: string;
  query: string;
  k: number;
  vectors?: KnowledgeVectorRuntime;
  signal?: AbortSignal;
}): Promise<{ results: RecallResult[]; details: KnowledgeRecallDetails }> {
  const workspace = await acceptedCandidates(input.workspaceStore, "workspace");
  const user = input.userStore ? await acceptedCandidates(input.userStore, "user") : [];
  return recallCandidates({
    candidates: [...workspace, ...user],
    query: input.query,
    k: input.k,
    ...(input.vectors ? { vectors: input.vectors } : {}),
    ...(input.vectors && input.workspaceId ? {
      vectorScopes: [
        { authority: input.workspaceStore, scope: "workspace" as const, scopeId: input.workspaceId },
        ...(input.userStore ? [{ authority: input.userStore, scope: "user" as const, scopeId: "user" }] : []),
      ],
      workspaceId: input.workspaceId,
    } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}
