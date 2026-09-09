import type { Knowledge, KnowledgeScope, KnowledgeStore, RecallResult } from "../store.js";
import type { KnowledgeVectorRuntime, KnowledgeVectorStatus } from "./runtime.js";
import { knowledgeContentRevision } from "./identity.js";

const RRF_K = 60;

export type KnowledgeRecallDetails = {
  vector: KnowledgeVectorStatus;
  spaceId?: string;
};

const textScore = (query: string, item: Knowledge): number => {
  const haystack = `${item.content} ${item.trigger}`.toLowerCase();
  let score = 0;
  for (const term of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (haystack.includes(term)) score += 1;
  }
  return score;
};

const rrfMerge = (
  textRanks: Map<number, number>,
  vectorRanks: Map<number, number>,
): Map<number, number> => {
  const ids = new Set([...textRanks.keys(), ...vectorRanks.keys()]);
  const scores = new Map<number, number>();
  for (const id of ids) {
    const text = textRanks.get(id);
    const vector = vectorRanks.get(id);
    scores.set(id, (text === undefined ? 0 : 1 / (RRF_K + text)) + (vector === undefined ? 0 : 1 / (RRF_K + vector)));
  }
  return scores;
};

export async function recallKnowledge(input: {
  authority: KnowledgeStore;
  scope: KnowledgeScope;
  scopeId: string;
  workspaceId: string;
  query: string;
  k: number;
  vectors?: KnowledgeVectorRuntime;
  signal?: AbortSignal;
}): Promise<{ results: RecallResult[]; details: KnowledgeRecallDetails }> {
  const accepted = (await input.authority.listKnowledge({ status: "accepted", activeOnly: true }))
    .filter((item) => item.scope === input.scope);
  const byId = new Map(accepted.map((item) => [item.id, item]));
  const textHits = accepted
    .map((item) => ({ item, score: textScore(input.query, item) }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, input.k);
  const textRanks = new Map(textHits.map((row, index) => [row.item.id, index + 1]));

  let vectorStatus: KnowledgeVectorStatus = "unconfigured";
  let spaceId: string | undefined;
  const vectorRanks = new Map<number, number>();
  if (input.vectors) {
    const vector = await input.vectors.search({
      authority: input.authority,
      scope: input.scope,
      scopeId: input.scopeId,
      workspaceId: input.workspaceId,
      query: input.query,
      limit: input.k,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    vectorStatus = vector.status;
    spaceId = vector.spaceId;
    for (const hit of vector.hits) vectorRanks.set(hit.knowledgeId, hit.rank);
  }

  const merged = [...rrfMerge(textRanks, vectorRanks).entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .slice(0, input.k);

  const results: RecallResult[] = [];
  for (const [id, score] of merged) {
    const current = await input.authority.getKnowledge(id);
    if (!current || current.scope !== input.scope || current.status !== "accepted" || current.invalidAt !== undefined) {
      continue;
    }
    const expected = byId.get(id);
    if (!expected || knowledgeContentRevision(expected.content, expected.trigger) !== knowledgeContentRevision(current.content, current.trigger)) {
      continue;
    }
    results.push({
      node: {
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
      },
      score,
      via: vectorRanks.has(id) ? "vector" : "text",
    });
  }
  if (results.length > 0) await input.authority.recordRecall(results.map((result) => result.node.id));
  return {
    results,
    details: spaceId === undefined ? { vector: vectorStatus } : { vector: vectorStatus, spaceId },
  };
}

export async function recallWorkspaceAndUser(input: {
  workspaceStore: KnowledgeStore;
  userStore: KnowledgeStore | null;
  workspaceId: string;
  query: string;
  k: number;
  vectors?: KnowledgeVectorRuntime;
  signal?: AbortSignal;
}): Promise<{ results: RecallResult[]; details: KnowledgeRecallDetails }> {
  const workspace = await recallKnowledge({
    authority: input.workspaceStore,
    scope: "workspace",
    scopeId: input.workspaceId,
    workspaceId: input.workspaceId,
    query: input.query,
    k: input.k,
    ...(input.vectors ? { vectors: input.vectors } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const user = input.userStore
    ? await recallKnowledge({
      authority: input.userStore,
      scope: "user",
      scopeId: "user",
      workspaceId: input.workspaceId,
      query: input.query,
      k: input.k,
      ...(input.vectors ? { vectors: input.vectors } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    })
    : { results: [] as RecallResult[], details: { vector: "unconfigured" as KnowledgeVectorStatus } };

  const workspaceRanks = new Map(workspace.results.map((result, index) => [result.node.id, index + 1]));
  const userRanks = new Map(user.results.map((result, index) => [`user:${result.node.id}`, index + 1] as const));
  const keyed = [
    ...workspace.results.map((result) => ({ key: String(result.node.id), result, rank: workspaceRanks.get(result.node.id) })),
    ...user.results.map((result) => ({ key: `user:${result.node.id}`, result, rank: userRanks.get(`user:${result.node.id}`) })),
  ];
  const scores = new Map<string, { result: RecallResult; score: number }>();
  for (const row of keyed) {
    if (row.rank === undefined) continue;
    const previous = scores.get(row.key);
    const next = 1 / (RRF_K + row.rank);
    scores.set(row.key, { result: row.result, score: (previous?.score ?? 0) + next });
  }
  const results = [...scores.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, input.k)
    .map((row) => ({ ...row.result, score: row.score }));
  const vector = workspace.details.vector === "used" || user.details.vector === "used"
    ? "used"
    : workspace.details.vector === "partial" || user.details.vector === "partial"
      ? "partial"
      : workspace.details.vector === "failed" || user.details.vector === "failed"
        ? "failed"
        : workspace.details.vector === "unavailable" || user.details.vector === "unavailable"
          ? "unavailable"
          : workspace.details.vector;
  return {
    results,
    details: workspace.details.spaceId === undefined ? { vector } : { vector, spaceId: workspace.details.spaceId },
  };
}
