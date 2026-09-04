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
import { join } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

// triviumdb is a CJS package — use createRequire to avoid ESM named-import
// issues when running under pure Node (outside vite-node/vitest).
const require = createRequire(import.meta.url);
const { TriviumDB } = require("triviumdb") as typeof import("triviumdb");
type Vector = import("triviumdb").Vector;
type TransactionOperation = import("triviumdb").TransactionOperation;

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
  data?: Record<string, unknown>;
  source: EventSource;
}

export interface StoredEvent extends EventInput {
  id: NodeId;
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
  expectedUpdatedAt?: number | null;
}

export class KnowledgeBlockConflictError extends Error {
  readonly current: Block | null;

  constructor(current: Block | null) {
    super("Session block changed after it was opened");
    this.name = "KnowledgeBlockConflictError";
    this.current = current;
  }
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

export class KnowledgeMutationError extends Error {
  readonly code: "conflict" | "not-found" | "invalid";

  constructor(code: KnowledgeMutationError["code"], message: string) {
    super(message);
    this.name = "KnowledgeMutationError";
    this.code = code;
  }
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

export interface SymbolGraphRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface SymbolGraphSymbolInput {
  name: string;
  kind: string;
  range: SymbolGraphRange;
}

export interface SymbolGraphSearchResult extends SymbolGraphSymbolInput {
  id: NodeId;
  path: string;
  score: number;
}

// ── Store interface ────────────────────────────────────────────────

export interface KnowledgeStore {
  readonly dim: number;
  putEvent(e: EventInput): Promise<NodeId>;
  listEvents(filter: { sessionId: string; afterId?: NodeId; minTurnIndex?: number }): Promise<StoredEvent[]>;
  putSession(s: SessionInput): Promise<NodeId>;
  getBlocks(sessionId: string): Promise<Block[]>;
  upsertBlock(b: BlockInput): Promise<Block>;
  deleteBlock(sessionId: string, label: string): Promise<void>;
  putKnowledge(k: KnowledgeInput): Promise<NodeId>;
  updateSuggestedKnowledge(
    id: NodeId,
    patch: { content: string; trigger: string },
    expectedScope?: KnowledgeScope,
    expected?: { content: string; trigger: string },
  ): Promise<void>;
  listKnowledge(filter: { scope?: KnowledgeScope; status?: KnowledgeStatus; activeOnly?: boolean }): Promise<Knowledge[]>;
  acceptKnowledge(id: NodeId, opts: {
    supersedes?: NodeId[] | undefined;
    expectedScope?: KnowledgeScope;
    edit?: { content: string; trigger: string; expectedContent: string; expectedTrigger: string };
  }): Promise<void>;
  dismissKnowledge(id: NodeId, expectedScope?: KnowledgeScope): Promise<void>;
  recordRecall(ids: NodeId[]): Promise<void>;
  recall(query: string, k: number): Promise<RecallResult[]>;
  touchFile(path: string, language: string): Promise<NodeId>;
  replaceFileSymbols(path: string, language: string, symbols: SymbolGraphSymbolInput[]): Promise<{ fileId: NodeId; symbols: number; edges: number }>;
  removeFileSymbols(path: string): Promise<{ removedFiles: number; removedSymbols: number }>;
  searchSymbols(query: string, k: number): Promise<SymbolGraphSearchResult[]>;
  getDefinedSymbols(path: string): Promise<Array<Omit<SymbolGraphSearchResult, "score">>>;
  deleteSession(sessionId: string): Promise<void>;
  runRetention(now: Date, policy: { eventRetentionDays: number }): Promise<{ removed: number }>;
  close(): Promise<void>;
}

// ── Implementation ─────────────────────────────────────────────────

const PLACEHOLDER_DIM = 8;
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
  onBlocksChanged?: (sessionId: string) => void;
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
  db.createIndex("path");
  db.createIndex("active");

  const placeholderVec = zeroVector(dim);
  const publishBlocksChanged = (sessionId: string): void => {
    try {
      deps.onBlocksChanged?.(sessionId);
    } catch {
      // UI projection is observational and cannot turn a committed block write
      // into a reported storage failure.
    }
  };

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

  const graphFileIds = new Map<string, Set<number>>();
  const graphSymbolIds = new Map<string, Set<number>>();
  for (const id of db.allNodeIds()) {
    const payload = db.getPayload(id) as Record<string, unknown> | null;
    if (!payload || typeof payload["path"] !== "string") continue;
    const target = payload["type"] === "file" ? graphFileIds : payload["type"] === "symbol" ? graphSymbolIds : null;
    if (!target) continue;
    const ids = target.get(payload["path"]) ?? new Set<number>();
    ids.add(id);
    target.set(payload["path"], ids);
  }
  const graphNodes = (index: Map<string, Set<number>>, path: string) => (
    [...(index.get(path) ?? [])].flatMap((id) => {
      const payload = db.getPayload(id) as Record<string, unknown> | null;
      return payload ? [{ id, payload }] : [];
    })
  );
  const fileNodes = (path: string) => graphNodes(graphFileIds, path);
  const symbolNodes = (path: string) => graphNodes(graphSymbolIds, path);
  const assertGraphText = (value: string, label: string): string => {
    const text = value.trim();
    if (!text) throw new KnowledgeMutationError("invalid", `${label} is required`);
    return text;
  };
  const validRange = (range: SymbolGraphRange): boolean => (
    [range.startLine, range.startCharacter, range.endLine, range.endCharacter]
      .every((value) => Number.isSafeInteger(value) && value >= 0)
    && (range.endLine > range.startLine || (range.endLine === range.startLine && range.endCharacter >= range.startCharacter))
  );

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
          ...(e.data ? { data: e.data } : {}),
          source: e.source,
        };
        const id = db.insert(placeholderVec, payload);
        db.indexText(id, e.text);
        db.flush();
        return id;
      });
    },

    async listEvents(filter): Promise<StoredEvent[]> {
      const nodes = scanNodes((payload) => {
        if (payload["type"] !== "event" || payload["sessionId"] !== filter.sessionId) return false;
        const turnIndex = payload["turnIndex"];
        return filter.minTurnIndex === undefined
          || (typeof turnIndex === "number" && turnIndex >= filter.minTurnIndex);
      }).filter(({ id }) => filter.afterId === undefined || id > filter.afterId);
      return nodes.map(({ id, payload }) => ({
        id,
        kind: payload["kind"] as EventKind,
        at: payload["at"] as number,
        sessionId: payload["sessionId"] as string,
        ...(typeof payload["turnIndex"] === "number" ? { turnIndex: payload["turnIndex"] as number } : {}),
        text: payload["text"] as string,
        ...(payload["refs"] && typeof payload["refs"] === "object" ? { refs: payload["refs"] as EventRefs } : {}),
        ...(payload["data"] && typeof payload["data"] === "object" ? { data: payload["data"] as Record<string, unknown> } : {}),
        source: payload["source"] as EventSource,
      })).sort((left, right) => left.id - right.id);
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
      const result = await enqueueWrite(() => {
        // Find existing block by sessionId + label
        const existing = scanNodes((p) =>
          p["type"] === "block" && p["sessionId"] === b.sessionId && p["label"] === b.label,
        );
        const existingNode = existing[0] ?? null;
        const current = existingNode ? {
          sessionId: existingNode.payload["sessionId"] as string,
          label: existingNode.payload["label"] as string,
          content: existingNode.payload["content"] as string,
          updatedBy: existingNode.payload["updatedBy"] as BlockUpdatedBy,
          ...(existingNode.payload["cursorTurn"] !== undefined ? { cursorTurn: existingNode.payload["cursorTurn"] as number } : {}),
          updatedAt: existingNode.payload["updatedAt"] as number,
        } satisfies Block : null;
        if (
          b.expectedUpdatedAt !== undefined
          && ((b.expectedUpdatedAt === null && current !== null)
            || (typeof b.expectedUpdatedAt === "number" && current?.updatedAt !== b.expectedUpdatedAt))
        ) {
          throw new KnowledgeBlockConflictError(current);
        }
        const now = Math.max(Date.now(), (current?.updatedAt ?? 0) + 1);

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
      publishBlocksChanged(b.sessionId);
      return result;
    },

    async deleteBlock(sessionId: string, label: string): Promise<void> {
      await enqueueWrite(() => {
        const nodes = scanNodes((p) =>
          p["type"] === "block" && p["sessionId"] === sessionId && p["label"] === label,
        );
        for (const node of nodes) {
          db.delete(node.id);
        }
        db.flush();
      });
      publishBlocksChanged(sessionId);
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

    async updateSuggestedKnowledge(id, patch, expectedScope, expected): Promise<void> {
      return enqueueWrite(() => {
        const payload = db.getPayload(id) as Record<string, unknown> | null;
        if (!payload || payload["type"] !== "knowledge") {
          throw new KnowledgeMutationError("not-found", `Knowledge suggestion not found: ${id}`);
        }
        if (expectedScope && payload["scope"] !== expectedScope) {
          throw new KnowledgeMutationError("not-found", `Knowledge suggestion not found in ${expectedScope} scope: ${id}`);
        }
        if (payload["status"] !== "suggested") {
          throw new KnowledgeMutationError("conflict", `Knowledge ${id} is no longer awaiting review`);
        }
        if (expected && (payload["content"] !== expected.content || payload["trigger"] !== expected.trigger)) {
          throw new KnowledgeMutationError("conflict", `Knowledge suggestion ${id} changed after it was opened`);
        }
        if (!patch.content.trim()) throw new KnowledgeMutationError("invalid", "Knowledge content is required");
        db.patchPayload(id, { $set: { content: patch.content, trigger: patch.trigger } });
        db.indexText(id, patch.content);
        if (patch.trigger) db.indexKeyword(id, patch.trigger);
        db.flush();
      });
    },

    async acceptKnowledge(id: NodeId, opts: {
      supersedes?: NodeId[];
      expectedScope?: KnowledgeScope;
      edit?: { content: string; trigger: string; expectedContent: string; expectedTrigger: string };
    }): Promise<void> {
      return enqueueWrite(() => {
        const payload = db.getPayload(id) as Record<string, unknown> | null;
        if (!payload || payload["type"] !== "knowledge") {
          throw new KnowledgeMutationError("not-found", `Knowledge suggestion not found: ${id}`);
        }
        if (opts.expectedScope && payload["scope"] !== opts.expectedScope) {
          throw new KnowledgeMutationError("not-found", `Knowledge suggestion not found in ${opts.expectedScope} scope: ${id}`);
        }
        if (payload["status"] === "accepted") return;
        if (payload["status"] !== "suggested") {
          throw new KnowledgeMutationError("conflict", `Knowledge ${id} is no longer awaiting review`);
        }
        if (opts.edit) {
          if (payload["content"] !== opts.edit.expectedContent || payload["trigger"] !== opts.edit.expectedTrigger) {
            throw new KnowledgeMutationError("conflict", `Knowledge suggestion ${id} changed after it was opened`);
          }
          if (!opts.edit.content.trim()) throw new KnowledgeMutationError("invalid", "Knowledge content is required");
        }
        const superseded = [...new Set(opts.supersedes ?? [])].filter((oldId) => oldId !== id);
        for (const oldId of superseded) {
          const old = db.getPayload(oldId) as Record<string, unknown> | null;
          if (
            !old
            || old["type"] !== "knowledge"
            || old["status"] !== "accepted"
            || old["invalidAt"] !== undefined
            || old["scope"] !== payload["scope"]
          ) {
            throw new KnowledgeMutationError("invalid", `Knowledge ${oldId} cannot be superseded by ${id}`);
          }
        }
        db.patchPayload(id, { $set: {
          status: "accepted",
          ...(opts.edit ? { content: opts.edit.content, trigger: opts.edit.trigger } : {}),
        } });
        if (opts.edit) {
          db.indexText(id, opts.edit.content);
          if (opts.edit.trigger) db.indexKeyword(id, opts.edit.trigger);
        }
        if (superseded.length > 0) {
          const now = Date.now();
          for (const oldId of superseded) {
            db.patchPayload(oldId, { $set: { invalidAt: now } });
            db.link(id, oldId, "supersedes", 1);
          }
        }
        db.flush();
      });
    },

    async dismissKnowledge(id: NodeId, expectedScope): Promise<void> {
      return enqueueWrite(() => {
        const payload = db.getPayload(id) as Record<string, unknown> | null;
        if (!payload || payload["type"] !== "knowledge") {
          throw new KnowledgeMutationError("not-found", `Knowledge suggestion not found: ${id}`);
        }
        if (expectedScope && payload["scope"] !== expectedScope) {
          throw new KnowledgeMutationError("not-found", `Knowledge suggestion not found in ${expectedScope} scope: ${id}`);
        }
        if (payload["status"] === "dismissed") return;
        if (payload["status"] !== "suggested") {
          throw new KnowledgeMutationError("conflict", `Accepted knowledge ${id} cannot be dismissed as a suggestion`);
        }
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
      const hits = db.searchHybrid(placeholderVec, query, k, 2, 0.0, alpha).filter((hit) => {
        const payload = hit.payload as Record<string, unknown>;
        return payload["type"] === "knowledge" && payload["status"] === "accepted" && payload["invalidAt"] === undefined;
      });
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

    async touchFile(path, language): Promise<NodeId> {
      return enqueueWrite(() => {
        const normalizedPath = assertGraphText(path, "File path");
        const normalizedLanguage = assertGraphText(language, "File language");
        const existing = fileNodes(normalizedPath);
        const payload = {
          type: "file",
          path: normalizedPath,
          language: normalizedLanguage,
          modifiedAt: Date.now(),
          active: true,
        };
        const fileId = existing[0]?.id ?? db.insert(placeholderVec, payload);
        graphFileIds.set(normalizedPath, new Set([fileId, ...existing.slice(1).map(({ id }) => id)]));
        const operations: TransactionOperation[] = [
          { type: "updatePayload", id: fileId, payload },
          ...existing.slice(1).map(({ id }) => ({ type: "delete" as const, id })),
        ];
        db.commitTransaction(operations);
        graphFileIds.set(normalizedPath, new Set([fileId]));
        db.indexText(fileId, normalizedPath);
        db.flush();
        return fileId;
      });
    },

    async replaceFileSymbols(path, language, symbols) {
      return enqueueWrite(() => {
        const normalizedPath = assertGraphText(path, "File path");
        const normalizedLanguage = assertGraphText(language, "File language");
        for (const symbol of symbols) {
          assertGraphText(symbol.name, "Symbol name");
          assertGraphText(symbol.kind, "Symbol kind");
          if (!validRange(symbol.range)) throw new KnowledgeMutationError("invalid", `Invalid range for symbol ${symbol.name}`);
        }
        const generation = randomUUID();
        const previousFiles = fileNodes(normalizedPath);
        const previousSymbols = symbolNodes(normalizedPath);
        const fileId = previousFiles[0]?.id ?? db.insert(placeholderVec, {
          type: "file",
          path: normalizedPath,
          language: normalizedLanguage,
          modifiedAt: Date.now(),
          active: true,
          generation,
        });
        graphFileIds.set(normalizedPath, new Set([fileId, ...previousFiles.slice(1).map(({ id }) => id)]));
        const pendingPayloads = symbols.map((symbol) => ({
          type: "symbol",
          path: normalizedPath,
          language: normalizedLanguage,
          name: symbol.name,
          kind: symbol.kind,
          range: { ...symbol.range },
          generation,
          active: false,
        }));
        const symbolIds = pendingPayloads.length > 0
          ? db.batchInsert(pendingPayloads.map(() => placeholderVec), pendingPayloads)
          : [];
        graphSymbolIds.set(normalizedPath, new Set([...previousSymbols.map(({ id }) => id), ...symbolIds]));
        const activePayloads = pendingPayloads.map((payload) => ({ ...payload, active: true }));
        const filePayload = {
          type: "file",
          path: normalizedPath,
          language: normalizedLanguage,
          modifiedAt: Date.now(),
          active: true,
          generation,
        };
        const operations: TransactionOperation[] = [
          { type: "updatePayload", id: fileId, payload: filePayload },
          ...previousFiles.slice(1).map(({ id }) => ({ type: "delete" as const, id })),
          ...previousSymbols.map(({ id }) => ({ type: "delete" as const, id })),
          ...symbolIds.flatMap((id, index): TransactionOperation[] => [
            { type: "updatePayload", id, payload: activePayloads[index] },
            { type: "upsertEdge", src: fileId, dst: id, label: "defines", weight: 1 },
          ]),
        ];
        db.commitTransaction(operations);
        graphFileIds.set(normalizedPath, new Set([fileId]));
        if (symbolIds.length > 0) graphSymbolIds.set(normalizedPath, new Set(symbolIds));
        else graphSymbolIds.delete(normalizedPath);
        db.indexText(fileId, normalizedPath);
        for (let index = 0; index < symbolIds.length; index += 1) {
          const id = symbolIds[index]!;
          const symbol = symbols[index]!;
          db.indexText(id, `${symbol.name} ${normalizedPath}`);
          db.indexKeyword(id, symbol.name);
        }
        db.flush();
        return { fileId, symbols: symbolIds.length, edges: symbolIds.length };
      });
    },

    async removeFileSymbols(path) {
      return enqueueWrite(() => {
        const normalizedPath = assertGraphText(path, "File path");
        const files = fileNodes(normalizedPath);
        const symbols = symbolNodes(normalizedPath);
        const operations: TransactionOperation[] = [
          ...symbols.map(({ id }) => ({ type: "delete" as const, id })),
          ...files.map(({ id }) => ({ type: "delete" as const, id })),
        ];
        if (operations.length > 0) db.commitTransaction(operations);
        graphFileIds.delete(normalizedPath);
        graphSymbolIds.delete(normalizedPath);
        db.flush();
        return { removedFiles: files.length, removedSymbols: symbols.length };
      });
    },

    async searchSymbols(query, k) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (terms.length === 0 || !Number.isSafeInteger(k) || k <= 0) return [];
      return scanNodes((payload) => payload["type"] === "symbol" && payload["active"] === true)
        .flatMap(({ id, payload }) => {
          const name = typeof payload["name"] === "string" ? payload["name"] : "";
          const path = typeof payload["path"] === "string" ? payload["path"] : "";
          const kind = typeof payload["kind"] === "string" ? payload["kind"] : "";
          const range = payload["range"] as SymbolGraphRange | undefined;
          if (!name || !path || !range || !validRange(range)) return [];
          const normalizedName = name.toLowerCase();
          const haystack = `${normalizedName} ${path.toLowerCase()}`;
          const score = terms.reduce((total, term) => total + (normalizedName === term ? 4 : normalizedName.includes(term) ? 2 : haystack.includes(term) ? 1 : 0), 0);
          return score > 0 ? [{ id, name, path, kind, range: { ...range }, score }] : [];
        })
        .toSorted((left, right) => right.score - left.score || left.name.localeCompare(right.name) || left.path.localeCompare(right.path))
        .slice(0, k);
    },

    async getDefinedSymbols(path) {
      const normalizedPath = assertGraphText(path, "File path");
      const file = fileNodes(normalizedPath)[0];
      if (!file) return [];
      return db.getEdges(file.id)
        .filter((edge) => edge.label === "defines")
        .flatMap((edge) => {
          const payload = db.getPayload(edge.targetId) as Record<string, unknown> | null;
          const range = payload?.["range"] as SymbolGraphRange | undefined;
          return payload?.["type"] === "symbol"
            && payload["active"] === true
            && typeof payload["name"] === "string"
            && typeof payload["path"] === "string"
            && typeof payload["kind"] === "string"
            && range
            && validRange(range)
            ? [{
                id: edge.targetId,
                name: payload["name"],
                path: payload["path"],
                kind: payload["kind"],
                range: { ...range },
              }]
            : [];
        })
        .toSorted((left, right) => left.range.startLine - right.range.startLine || left.range.startCharacter - right.range.startCharacter || left.name.localeCompare(right.name));
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
