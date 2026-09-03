/**
 * Knowledge store v1 — TriviumDB-backed workspace knowledge base.
 *
 * Design: agent-harness.md §7.1, §7.2, §7.2.1
 * Plan: agent-harness-plan.md §2.1
 *
 * Node types: event, session, block, knowledge.
 * Edges: supersedes (knowledge → knowledge), defines (file → symbol),
 * references (symbol → symbol). Phase 2 only needs event/session/block/knowledge.
 *
 * Placeholder vector mode: dim=8, all-zero vectors, recall uses searchHybrid
 * with hybridAlpha=0 (text + graph only, no vector contribution).
 */

import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { TriviumDB, type Vector } from "triviumdb";

// ── Types ──────────────────────────────────────────────────────────

export type NodeId = number;

export type EventKind = "edit" | "command" | "diagnostic" | "turn" | "source" | "user-mark";
export type EventSource = "agent" | "user" | "external";

export interface EventRefs {
  path?: string;
  journalObject?: string;
  url?: string;
  handle?: string;
}

export interface EventInput {
  kind: EventKind;
  at: number; // epoch ms
  sessionId: string;
  turnIndex?: number;
  text: string;
  refs?: EventRefs;
  source: EventSource;
}

export interface SessionInput {
  sessionId: string;
  profile: string;
  workspaceId: string;
  startedAt: number;
  harness: unknown;
}

export type BlockUpdatedBy = "agent" | "memory-agent" | "user";

export interface Block {
  sessionId: string;
  label: string;
  content: string;
  updatedBy: BlockUpdatedBy;
  cursorTurn?: number;
  updatedAt: number;
}

export interface BlockInput {
  sessionId: string;
  label: string;
  content: string;
  updatedBy: BlockUpdatedBy;
  cursorTurn?: number;
}

export type KnowledgeScope = "workspace" | "user";
export type KnowledgeStatus = "suggested" | "accepted" | "dismissed";

export interface KnowledgeInput {
  scope: KnowledgeScope;
  status: KnowledgeStatus;
  content: string;
  trigger: string;
  source?: { sessionId: string; kind: string };
}

export interface Knowledge {
  id: NodeId;
  scope: KnowledgeScope;
  status: KnowledgeStatus;
  content: string;
  trigger: string;
  source?: { sessionId: string; kind: string };
  createdAt: number;
  invalidAt?: number;
  recallCount: number;
  recalledAt?: number;
}

export interface KnowledgeOrEvent {
  id: NodeId;
  type: "knowledge" | "event";
  payload: Record<string, unknown>;
}

export interface RecallResult {
  node: KnowledgeOrEvent;
  score: number;
  via: "text" | "vector" | "graph";
}

export interface EmbeddingProvider {
  id: string;
  model: string;
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

// ── Store interface ────────────────────────────────────────────────

export interface KnowledgeStore {
  readonly dim: number;
  putEvent(e: EventInput): Promise<NodeId>;
  putSession(s: SessionInput): Promise<NodeId>;
  getBlocks(sessionId: string): Promise<Block[]>;
  upsertBlock(b: BlockInput): Promise<Block>;
  deleteBlock(sessionId: string, label: string): Promise<void>;
  putKnowledge(k: KnowledgeInput): Promise<NodeId>;
  listKnowledge(filter: { scope?: KnowledgeScope; status?: KnowledgeStatus; activeOnly?: boolean }): Promise<Knowledge[]>;
  acceptKnowledge(id: NodeId, opts: { supersedes?: NodeId[] }): Promise<void>;
  dismissKnowledge(id: NodeId): Promise<void>;
  recordRecall(ids: NodeId[]): Promise<void>;
  recall(query: string, k: number): Promise<RecallResult[]>;
  deleteSession(sessionId: string): Promise<void>;
  runRetention(now: Date, policy: { eventRetentionDays: number }): Promise<{ removed: number }>;
  close(): Promise<void>;
}

// ── Implementation ─────────────────────────────────────────────────

const PLACEHOLDER_DIM = 8;
const DEFAULT_DIM = 1024;
const BLOCK_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_RETENTION_BATCH = 5000;

function zeroVector(dim: number): Vector {
  return new Array(dim).fill(0);
}

export interface OpenWorkspaceKnowledgeDeps {
  dataDir: string;
  hostId: string;
  workspaceId: string;
  embedding: EmbeddingProvider | null;
}

export async function openWorkspaceKnowledge(deps: OpenWorkspaceKnowledgeDeps): Promise<KnowledgeStore> {
  const { dataDir, workspaceId, embedding } = deps;

  // Ensure directory exists
  const dbDir = join(dataDir, "knowledge", deps.hostId);
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, `${workspaceId}.tdb`);

  const dim = embedding?.dim ?? PLACEHOLDER_DIM;
  const db = new TriviumDB(dbPath, {
    dim,
    syncMode: "normal",
    loadTextIndex: true,
  });

  // Create indexes for common queries
  db.createIndex("type");
  db.createIndex("sessionId");
  db.createOrderedIndex("at");
  db.createIndex("status");
  db.createIndex("scope");

  const placeholderVec = zeroVector(dim);

  // Helper: scan all nodes and filter in JS (avoids TQL syntax fragility)
  function scanNodes(filter: (payload: Record<string, unknown>) => boolean): Array<{ id: number; payload: Record<string, unknown> }> {
    const ids = db.allNodeIds();
    const results: Array<{ id: number; payload: Record<string, unknown> }> = [];
    for (const id of ids) {
      const payload = db.getPayload(id) as Record<string, unknown> | null;
      if (payload && filter(payload)) {
        results.push({ id, payload });
      }
    }
    return results;
  }

  // Write queue — all writes go through this to ensure single-writer ordering
  const writeQueue: Promise<unknown> = Promise.resolve();
  let writeTail = writeQueue;
  function enqueueWrite<T>(fn: () => T): Promise<T> {
    const result = writeTail.then(fn, fn);
    writeTail = result.then(() => undefined, () => undefined);
    return result;
  }

  const store: KnowledgeStore = {
    dim,

    async putEvent(e: EventInput): Promise<NodeId> {
      return enqueueWrite(() => {
        const payload = {
          type: "event",
          kind: e.kind,
          at: e.at,
          sessionId: e.sessionId,
          ...(e.turnIndex !== undefined ? { turnIndex: e.turnIndex } : {}),
          text: e.text,
          ...(e.refs ? { refs: e.refs } : {}),
          source: e.source,
        };
        const id = db.insert(placeholderVec, payload);
        db.indexText(id, e.text);
        db.flush();
        return id;
      });
    },

    async putSession(s: SessionInput): Promise<NodeId> {
      return enqueueWrite(() => {
        const payload = {
          type: "session",
          sessionId: s.sessionId,
          profile: s.profile,
          workspaceId: s.workspaceId,
          startedAt: s.startedAt,
          harness: s.harness,
        };
        const id = db.insert(placeholderVec, payload);
        db.flush();
        return id;
      });
    },

    async getBlocks(sessionId: string): Promise<Block[]> {
      const nodes = scanNodes((p) => p["type"] === "block" && p["sessionId"] === sessionId);
      const blocks: Block[] = nodes.map(({ payload: p }) => ({
        sessionId: p["sessionId"] as string,
        label: p["label"] as string,
        content: p["content"] as string,
        updatedBy: p["updatedBy"] as BlockUpdatedBy,
        ...(p["cursorTurn"] !== undefined ? { cursorTurn: p["cursorTurn"] as number } : {}),
        updatedAt: p["updatedAt"] as number,
      }));
      return blocks.sort((a, b) => a.label.localeCompare(b.label));
    },

    async upsertBlock(b: BlockInput): Promise<Block> {
      if (!BLOCK_NAME_RE.test(b.label)) {
        throw new Error(`Invalid block name: ${b.label}`);
      }
      return enqueueWrite(() => {
        const now = Date.now();
        // Find existing block by sessionId + label
        const existing = scanNodes((p) =>
          p["type"] === "block" && p["sessionId"] === b.sessionId && p["label"] === b.label,
        );
        const existingNode = existing[0] ?? null;

        const payload = {
          type: "block",
          sessionId: b.sessionId,
          label: b.label,
          content: b.content,
          updatedBy: b.updatedBy,
          ...(b.cursorTurn !== undefined ? { cursorTurn: b.cursorTurn } : {}),
          updatedAt: now,
        };

        let id: number;
        if (existingNode) {
          db.updatePayload(existingNode.id, payload);
          id = existingNode.id;
        } else {
          id = db.insert(placeholderVec, payload);
        }
        db.indexText(id, b.content);
        db.flush();

        return {
          sessionId: b.sessionId,
          label: b.label,
          content: b.content,
          updatedBy: b.updatedBy,
          ...(b.cursorTurn !== undefined ? { cursorTurn: b.cursorTurn } : {}),
          updatedAt: now,
        };
      });
    },

    async deleteBlock(sessionId: string, label: string): Promise<void> {
      return enqueueWrite(() => {
        const nodes = scanNodes((p) =>
          p["type"] === "block" && p["sessionId"] === sessionId && p["label"] === label,
        );
        for (const node of nodes) {
          db.delete(node.id);
        }
        db.flush();
      });
    },

    async putKnowledge(k: KnowledgeInput): Promise<NodeId> {
      return enqueueWrite(() => {
        const now = Date.now();
        const payload = {
          type: "knowledge",
          scope: k.scope,
          status: k.status,
          content: k.content,
          trigger: k.trigger,
          ...(k.source ? { source: k.source } : {}),
          createdAt: now,
          recallCount: 0,
        };
        const id = db.insert(placeholderVec, payload);
        db.indexText(id, k.content);
        if (k.trigger) db.indexKeyword(id, k.trigger);
        db.flush();
        return id;
      });
    },

    async listKnowledge(filter: { scope?: KnowledgeScope; status?: KnowledgeStatus; activeOnly?: boolean }): Promise<Knowledge[]> {
      const nodes = scanNodes((p) => {
        if (p["type"] !== "knowledge") return false;
        if (filter.scope && p["scope"] !== filter.scope) return false;
        if (filter.status && p["status"] !== filter.status) return false;
        if (filter.activeOnly && p["invalidAt"] !== undefined) return false;
        return true;
      });

      const results: Knowledge[] = nodes.map(({ id, payload: p }) => {
        const invalidAt = p["invalidAt"] as number | undefined;
        return {
          id,
          scope: p["scope"] as KnowledgeScope,
          status: p["status"] as KnowledgeStatus,
          content: p["content"] as string,
          trigger: p["trigger"] as string,
          ...(p["source"] ? { source: p["source"] as { sessionId: string; kind: string } } : {}),
          createdAt: p["createdAt"] as number,
          ...(invalidAt !== undefined ? { invalidAt } : {}),
          recallCount: (p["recallCount"] as number) ?? 0,
          ...(p["recalledAt"] !== undefined ? { recalledAt: p["recalledAt"] as number } : {}),
        };
      });
      return results.sort((a, b) => b.createdAt - a.createdAt);
    },

    async acceptKnowledge(id: NodeId, opts: { supersedes?: NodeId[] }): Promise<void> {
      return enqueueWrite(() => {
        db.patchPayload(id, { $set: { status: "accepted" } });
        if (opts.supersedes) {
          const now = Date.now();
          for (const oldId of opts.supersedes) {
            db.patchPayload(oldId, { $set: { invalidAt: now } });
            db.link(id, oldId, "supersedes", 1);
          }
        }
        db.flush();
      });
    },

    async dismissKnowledge(id: NodeId): Promise<void> {
      return enqueueWrite(() => {
        db.patchPayload(id, { $set: { status: "dismissed" } });
        db.flush();
      });
    },

    async recordRecall(ids: NodeId[]): Promise<void> {
      return enqueueWrite(() => {
        const now = Date.now();
        for (const id of ids) {
          const payload = db.getPayload(id);
          if (payload && payload["type"] === "knowledge") {
            db.patchPayload(id, {
              $set: { recalledAt: now },
              $inc: { recallCount: 1 },
            });
          }
        }
        db.flush();
      });
    },

    async recall(query: string, k: number): Promise<RecallResult[]> {
      // Placeholder vector mode: hybridAlpha=0 → text + graph only
      // In placeholder mode, searchHybrid with zero vectors may not return
      // useful results. Fall back to scanning knowledge nodes and matching
      // on trigger/content text.
      if (!embedding) {
        const nodes = scanNodes((p) =>
          p["type"] === "knowledge" && p["status"] === "accepted" && p["invalidAt"] === undefined,
        );
        const queryLower = query.toLowerCase();
        const scored = nodes.map(({ id, payload }) => {
          const content = (payload["content"] as string) ?? "";
          const trigger = (payload["trigger"] as string) ?? "";
          const text = `${content} ${trigger}`.toLowerCase();
          // Simple BM25-like scoring: count query term occurrences
          const terms = queryLower.split(/\s+/).filter(Boolean);
          let score = 0;
          for (const term of terms) {
            if (text.includes(term)) score += 1;
          }
          return { id, payload, score, via: "text" as const };
        }).filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, k);

        const results: RecallResult[] = scored.map(({ id, payload, score, via }) => ({
          node: { id, type: "knowledge", payload },
          score,
          via,
        }));

        // Record recall for knowledge nodes
        if (results.length > 0) {
          await store.recordRecall(results.map((r) => r.node.id));
        }
        return results;
      }

      // With embedding: use searchHybrid
      const alpha = 0.7;
      const hits = db.searchHybrid(placeholderVec, query, k, 2, 0.0, alpha);
      const results: RecallResult[] = hits.map((hit) => {
        const payload = hit.payload as Record<string, unknown>;
        const type = payload["type"] as "knowledge" | "event";
        return {
          node: { id: hit.id, type, payload },
          score: hit.score,
          via: "vector" as const,
        };
      });
      // Record recall for knowledge nodes
      const knowledgeIds = results
        .filter((r) => r.node.type === "knowledge")
        .map((r) => r.node.id);
      if (knowledgeIds.length > 0) {
        await store.recordRecall(knowledgeIds);
      }
      return results;
    },

    async deleteSession(sessionId: string): Promise<void> {
      return enqueueWrite(() => {
        // Delete all events, blocks, and session nodes for this session
        const nodes = scanNodes((p) =>
          p["type"] !== "knowledge" && p["sessionId"] === sessionId,
        );
        let count = 0;
        for (const node of nodes) {
          db.delete(node.id);
          count++;
          if (count >= MAX_RETENTION_BATCH) break;
        }
        db.flush();
      });
    },

    async runRetention(now: Date, policy: { eventRetentionDays: number }): Promise<{ removed: number }> {
      const cutoff = now.getTime() - policy.eventRetentionDays * 24 * 60 * 60 * 1000;
      return enqueueWrite(() => {
        const nodes = scanNodes((p) => {
          if (p["type"] !== "event") return false;
          const at = p["at"] as number;
          return at < cutoff;
        });

        let removed = 0;
        for (const node of nodes) {
          db.delete(node.id);
          removed++;
          if (removed >= MAX_RETENTION_BATCH) break;
        }
        db.flush();
        return { removed };
      });
    },

    async close(): Promise<void> {
      return enqueueWrite(() => {
        db.flush();
        db.close();
      });
    },
  };

  return store;
}
