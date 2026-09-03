/**
 * related tool — graph neighbors by PageRank.
 *
 * Design: agent-harness.md §6.2
 * Plan: agent-harness-plan.md §3.3
 *
 * related(anchor, hops=1, labels?): host uses TQL to return neighbors
 * sorted by PageRank.
 * Text: `related to ${anchor} (${hops} hops):\n` + each line.
 */

import type { KnowledgeStore, NodeId } from "../knowledge/store.js";

// ── Types ──────────────────────────────────────────────────────────

export interface RelatedResult {
  text: string;
  neighbors: Array<{ path: string; symbol?: string; score: number }>;
}

export interface RelatedDeps {
  store: KnowledgeStore;
  /** Find node ID by path or symbol name */
  findNode: (anchor: string) => Promise<NodeId | null>;
  /** Get neighbors with PageRank scores */
  getNeighbors: (id: NodeId, hops: number, labels?: string[]) => Promise<Array<{ id: NodeId; score: number; payload: Record<string, unknown> }>>;
}

// ── Tool execution ─────────────────────────────────────────────────

export async function executeRelated(
  anchor: string,
  hops: number,
  labels: string[] | undefined,
  deps: RelatedDeps,
): Promise<RelatedResult> {
  const nodeId = await deps.findNode(anchor);
  if (nodeId === null) {
    return {
      text: `related to ${anchor} (${hops} hops):\n- not found`,
      neighbors: [],
    };
  }

  const neighbors = await deps.getNeighbors(nodeId, hops, labels);
  const lines = neighbors.map((n) => {
    const path = (n.payload["path"] as string) ?? (n.payload["text"] as string) ?? `#${n.id}`;
    const symbol = n.payload["name"] as string | undefined;
    const symbolPart = symbol ? `:${symbol}` : "";
    return `- ${path}${symbolPart} · rank ${n.score.toFixed(3)}`;
  });

  const text = `related to ${anchor} (${hops} hops):\n${lines.join("\n")}`;
  return {
    text,
    neighbors: neighbors.map((n) => ({
      path: (n.payload["path"] as string) ?? `#${n.id}`,
      ...(n.payload["name"] ? { symbol: n.payload["name"] as string } : {}),
      score: n.score,
    })),
  };
}
