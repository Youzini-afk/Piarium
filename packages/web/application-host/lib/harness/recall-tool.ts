/**
 * recall tool — search workspace + user memory of past sessions and decisions.
 *
 * Design: agent-harness.md §7.2
 * Plan: agent-harness-plan.md §2.10
 *
 * recall(query, k=5): text `${n} memories for "${query}"\n` + each
 * `- [${scope}] ${title or first line} (${via}, #${id})`
 *
 * Workspace store + user store merged by score. User store only allows
 * knowledge nodes. Promotion = a new suggestion with scope: 'user'.
 */

import type { KnowledgeStore, RecallResult } from "../knowledge/store.js";

// ── Types ──────────────────────────────────────────────────────────

export interface RecallToolResult {
  text: string;
  results: RecallResult[];
}

export interface RecallToolDeps {
  workspaceStore: KnowledgeStore;
  userStore: KnowledgeStore | null;
}

// ── Tool execution ─────────────────────────────────────────────────

export async function executeRecall(
  query: string,
  k: number,
  deps: RecallToolDeps,
): Promise<RecallToolResult> {
  const { workspaceStore, userStore } = deps;

  const workspaceResults = await workspaceStore.recall(query, k);
  const userResults = userStore ? await userStore.recall(query, k) : [];

  // Merge by score, take top k
  const all = [...workspaceResults, ...userResults]
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  const lines = all.map((r) => {
    const payload = r.node.payload as Record<string, unknown>;
    const scope = (payload["scope"] as string) ?? "workspace";
    const content = (payload["content"] as string) ?? "";
    const title = content.split("\n")[0] ?? content;
    return `- [${scope}] ${title} (${r.via}, #${r.node.id})`;
  });

  const text = `${all.length} memories for "${query}"\n${lines.join("\n")}`;
  return { text, results: all };
}

// ── Prompt ─────────────────────────────────────────────────────────

export const RECALL_PROMPT_SNIPPET =
  "recall: search this workspace's memory of past sessions and decisions";

// ── User store ─────────────────────────────────────────────────────

/**
 * Open the user-level knowledge store at
 * {dataDir}/knowledge/{hostId}/user.tdb.
 * Only allows knowledge nodes (no events, sessions, or blocks).
 */
export async function openUserKnowledgeStore(
  deps: { dataDir: string; hostId: string; embedding: import("../knowledge/store.js").EmbeddingProvider | null },
): Promise<KnowledgeStore> {
  // Reuse openWorkspaceKnowledge with a special workspaceId "user"
  const { openWorkspaceKnowledge } = await import("../knowledge/store.js");
  const store = await openWorkspaceKnowledge({
    dataDir: deps.dataDir,
    hostId: deps.hostId,
    workspaceId: "user",
    embedding: deps.embedding,
  });

  // Wrap to reject non-knowledge writes
  const origPutEvent = store.putEvent.bind(store);
  const origPutSession = store.putSession.bind(store);
  const origUpsertBlock = store.upsertBlock.bind(store);
  const origPutKnowledge = store.putKnowledge.bind(store);

  return {
    ...store,
    async putEvent() {
      throw new Error("user.tdb only allows knowledge nodes");
    },
    async putSession() {
      throw new Error("user.tdb only allows knowledge nodes");
    },
    async upsertBlock() {
      throw new Error("user.tdb only allows knowledge nodes");
    },
    async putKnowledge(input) {
      if (input.scope !== "user") throw new Error("user.tdb only allows user-scoped knowledge");
      return origPutKnowledge(input);
    },
  };
  // Suppress unused var warnings
  void origPutEvent; void origPutSession; void origUpsertBlock;
}
