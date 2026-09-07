/**
 * Knowledge store v1 — TriviumDB-backed workspace knowledge base.
 *
 * Design: agent-harness.md §7.1, §7.2, §7.2.1
 * Plan: agent-harness-plan.md §2.1
 *
 * Node types: event, session, block, knowledge, file, symbol, link.
 * Edges: supersedes (knowledge → knowledge), defines (file → symbol),
 * imports / connects / associates (file → link). Additive link kinds share the
 * file generation; there is no schema version or migration runner (D-105).
 * `associates` is gated on the literal already being a confirmed connection
 * value elsewhere, so `connectionLiterals` must track the connects set (D-109).
 *
 * Placeholder vector mode: dim=8, all-zero vectors, recall uses searchHybrid
 * with hybridAlpha=0 (text + graph only, no vector contribution).
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { normalizeGraphPath, resolveImportSpecifier } from "./import-resolve.js";

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
  /**
   * The Pi session leaf entry ID at the time this block was written.
   * Used for branch-aware visibility: a block is visible on the current
   * branch if its sourceLeafId is in the current branch's ancestor path
   * (i.e. in `sessionManager.getBranch().map(e => e.id)`).
   * null/undefined = legacy block written before branch tracking.
   */
  sourceLeafId?: string | null;
}

export interface BlockInput {
  sessionId: string;
  label: string;
  content: string;
  updatedBy: BlockUpdatedBy;
  cursorTurn?: number;
  expectedUpdatedAt?: number | null;
  /**
   * The Pi session leaf entry ID at write time. See Block.sourceLeafId.
   */
  sourceLeafId?: string | null;
  /** Active branch ancestor path used to resolve the visible prior revision. */
  branchEntryIds?: readonly string[];
}

export interface BlockChange {
  previous: Block | null;
  current: Block | null;
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

export type SymbolMatchTier = "exact" | "name-contains" | "path-contains";

export interface SymbolGraphSearchResult extends SymbolGraphSymbolInput {
  id: NodeId;
  path: string;
  score: number;
  /** Which score bucket produced this hit. Definition ranking depends on the distinction. */
  match: SymbolMatchTier;
  /**
   * Disk revision the range was computed from, or null for rows written before
   * ranges carried a text identity (D-087). A consumer that cannot match it
   * against the current text must degrade instead of trusting the range.
   */
  documentRevision: string | null;
}

export interface SymbolGraphCatalogStats {
  symbolCount: number;
  fileCount: number;
  linkCount: number;
  languages: string[];
  paths: string[];
}

export interface SymbolGraphImportersResult {
  path: string;
  resolved: Array<{ path: string; specifier: string }>;
}

export type SymbolGraphLinkKind = "import" | "connects" | "associates";

export interface SymbolGraphLinkInput {
  kind: SymbolGraphLinkKind;
  value: string;
  /** Inclusive, 1-based. */
  line: number;
  /** Required for connects/associates; omitted for import specifiers. */
  callee?: string;
}

export interface SymbolGraphFileRelations {
  path: string;
  documentRevision: string | null;
  generation: string | null;
  /**
   * Link extraction was blocked when this generation was written, so the edge
   * set is a floor. Distinct from a file that genuinely has no edges.
   */
  linksIncomplete: boolean;
  imports: Array<{ specifier: string; line: number; documentRevision: string | null }>;
  connections: Array<{ callee: string; literal: string; line: number; documentRevision: string | null }>;
  associations: Array<{ callee: string; literal: string; line: number; documentRevision: string | null }>;
  /**
   * Outgoing file edges whose target payload is gone. Used to assert that a
   * re-collect participates in the same generation lifecycle.
   */
  danglingEdges: number;
}

export interface SymbolGraphLinkSearchResult {
  path: string;
  kind: SymbolGraphLinkKind;
  value: string;
  line: number;
  callee?: string;
  documentRevision: string | null;
}

// ── Store interface ────────────────────────────────────────────────

export interface KnowledgeStore {
  readonly dim: number;
  putEvent(e: EventInput): Promise<NodeId>;
  listEvents(filter: { sessionId: string; afterId?: NodeId; minTurnIndex?: number }): Promise<StoredEvent[]>;
  putSession(s: SessionInput): Promise<NodeId>;
  /**
   * Read blocks for a session. If `branchEntryIds` is provided, only blocks
   * whose `sourceLeafId` is in that array (or null/undefined for legacy
   * blocks) are returned — this is the ancestor-resolution view. If omitted,
   * all blocks for the session are returned (legacy/debug behavior).
   */
  getBlocks(sessionId: string, branchEntryIds?: readonly string[]): Promise<Block[]>;
  upsertBlock(b: BlockInput): Promise<Block>;
  /**
   * Delete a block. A branch-scoped delete writes a tombstone at the active
   * leaf so sibling branches retain their inherited revision. If
   * `expectedUpdatedAt` is provided, deletion is conditional on the visible
   * block revision matching.
   */
  deleteBlock(
    sessionId: string,
    label: string,
    options?: {
      branchEntryIds?: readonly string[];
      expectedUpdatedAt?: number | null;
      sourceLeafId?: string | null;
      updatedBy?: BlockUpdatedBy;
      cursorTurn?: number;
    },
  ): Promise<void>;
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
  /**
   * Replace one file's symbols. `documentRevision` is the disk revision the
   * ranges were computed from; the graph records committed facts, so a range
   * derived from an editor buffer is never stored (D-087).
   */
  replaceFileSymbols(
    path: string,
    language: string,
    symbols: SymbolGraphSymbolInput[],
    documentRevision: string,
    links?: readonly SymbolGraphLinkInput[],
    options?: { linksIncomplete?: boolean },
  ): Promise<{ fileId: NodeId; symbols: number; edges: number }>;
  removeFileSymbols(path: string): Promise<{ removedFiles: number; removedSymbols: number }>;
  searchSymbols(query: string, k: number): Promise<SymbolGraphSearchResult[]>;
  getDefinedSymbols(path: string): Promise<Array<Omit<SymbolGraphSearchResult, "score" | "match">>>;
  getFileRelations(path: string): Promise<SymbolGraphFileRelations | null>;
  findLinks(value: string): Promise<SymbolGraphLinkSearchResult[]>;
  catalogStats(): Promise<SymbolGraphCatalogStats>;
  findImporters(path: string): Promise<SymbolGraphImportersResult>;
  /**
   * Values that are a confirmed connection literal somewhere in the graph.
   * Gates association candidates: plan 3.11 marks a *same-name* string as a
   * candidate, not every string-literal call (D-109).
   */
  connectionLiterals(values: readonly string[]): Promise<Set<string>>;
  deleteSession(sessionId: string): Promise<void>;
  runRetention(now: Date, policy: { eventRetentionDays: number }): Promise<{ removed: number }>;
  close(): Promise<void>;
}

// ── Implementation ─────────────────────────────────────────────────

const PLACEHOLDER_DIM = 8;
/** `substringLookup` rejects shorter needles (TriviumDB 0.8.6 n-gram index). */
const NGRAM_MIN_CHARS = 3;
/**
 * `maxResults` on `indexedLookup` / `substringLookup` is a fail-closed row
 * budget, not a LIMIT: exceeding it throws `TDB_QUERY_BUDGET`, and the default
 * is 10,000 — below one repository's symbol count. The graph's whole-type reads
 * (counters, file shape, import resolution) and substring candidates need to
 * see everything, so they raise the ceiling to the API's maximum (1,000,000).
 * It still throws rather than truncating, which is the honest failure for
 * derived data (D-141).
 */
const GRAPH_RESULT_CEILING = 1_000_000;
/** Quiet period before a derived graph write is persisted (D-140). */
const GRAPH_FLUSH_QUIET_MS = 250;
/** Upper bound on deferral, so a long catalog scan still persists as it goes. */
const GRAPH_FLUSH_MAX_DEFER_MS = 30_000;
const BLOCK_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_RETENTION_BATCH = 5000;

function zeroVector(dim: number): Vector {
  return new Array(dim).fill(0);
}

function scoreSymbolMatch(
  nameLower: string,
  pathLower: string,
  terms: readonly string[],
): { score: number; match: SymbolMatchTier } | null {
  const normalizedName = nameLower;
  const haystack = `${nameLower} ${pathLower}`;
  let score = 0;
  let match: SymbolMatchTier | undefined;
  for (const term of terms) {
    if (normalizedName === term) {
      score += 4;
      match = "exact";
    } else if (normalizedName.includes(term)) {
      score += 2;
      if (match !== "exact") match = "name-contains";
    } else if (haystack.includes(term)) {
      score += 1;
      if (!match) match = "path-contains";
    }
  }
  return score > 0 && match ? { score, match } : null;
}

export interface OpenWorkspaceKnowledgeDeps {
  dataDir: string;
  hostId: string;
  workspaceId: string;
  embedding: EmbeddingProvider | null;
  onBlocksChanged?: (sessionId: string, change: BlockChange) => void;
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
    // 0.8.6's parsed-payload LRU cache makes every payload access O(store
    // size): getPayload measured 60 µs at 50K nodes against 1.7 µs on 0.8.5,
    // and indexedLookup/substringLookup over a large result set went
    // quadratic (2.7 s for 50K ids). Disabling the cache restores 0.8.5
    // behaviour (2 µs, 42 ms) — the bug is in the cache bookkeeping, not in
    // capacity, since 1024 MB was no better than 64 MB (D-141).
    payloadCacheMb: 0,
  });

  // Property indexes. All are persistent and idempotent to create, and
  // creating one over existing rows backfills it, so an older database picks
  // these up on its first open after an upgrade (D-141).
  db.createIndex("type");
  db.createIndex("sessionId");
  db.createOrderedIndex("at");
  db.createIndex("status");
  db.createIndex("scope");
  db.createIndex("path");
  db.createIndex("active");
  // Symbol graph: equality lookups that used to be JS-side maps rebuilt on
  // every open (D-134 / D-139), and substring search over lowercased names and
  // paths. `substringLookup` needs three characters, so exact matches on short
  // names go through the hash index on `nameLower` instead.
  db.createIndex("kind");
  db.createIndex("value");
  db.createIndex("nameLower");
  db.createNgramIndex("nameLower");
  db.createNgramIndex("pathLower");

  const placeholderVec = zeroVector(dim);
  const publishBlocksChanged = (sessionId: string, change: BlockChange): void => {
    try {
      deps.onBlocksChanged?.(sessionId, change);
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

  type StoredBlockNode = { id: number; payload: Record<string, unknown> };
  const blockFromPayload = (payload: Record<string, unknown>): Block => ({
    sessionId: payload["sessionId"] as string,
    label: payload["label"] as string,
    content: typeof payload["content"] === "string" ? payload["content"] : "",
    updatedBy: payload["updatedBy"] as BlockUpdatedBy,
    ...(payload["cursorTurn"] !== undefined ? { cursorTurn: payload["cursorTurn"] as number } : {}),
    updatedAt: payload["updatedAt"] as number,
    ...(payload["sourceLeafId"] !== undefined ? { sourceLeafId: payload["sourceLeafId"] as string | null } : {}),
  });
  const blockNodes = (sessionId: string, label?: string): StoredBlockNode[] => scanNodes((payload) => (
    payload["type"] === "block"
    && payload["sessionId"] === sessionId
    && (label === undefined || payload["label"] === label)
  ));
  const isDeletedBlock = (node: StoredBlockNode): boolean => node.payload["deleted"] === true;
  const sourceLeafOf = (node: StoredBlockNode): string | null => (
    typeof node.payload["sourceLeafId"] === "string" ? node.payload["sourceLeafId"] as string : null
  );
  const newestNode = (nodes: StoredBlockNode[]): StoredBlockNode | null => (
    nodes.toSorted((left, right) => (
      Number(right.payload["updatedAt"] ?? 0) - Number(left.payload["updatedAt"] ?? 0)
      || right.id - left.id
    ))[0] ?? null
  );
  /** Resolve one label to the closest revision on the active ancestor path. */
  const visibleBlockNode = (
    nodes: StoredBlockNode[],
    branchEntryIds: readonly string[],
  ): StoredBlockNode | null => {
    const rank = new Map(branchEntryIds.map((entryId, index) => [entryId, index]));
    let selected: StoredBlockNode | null = null;
    let selectedRank = Number.NEGATIVE_INFINITY;
    for (const node of nodes) {
      const sourceLeafId = sourceLeafOf(node);
      const nodeRank = sourceLeafId === null ? -1 : rank.get(sourceLeafId);
      if (nodeRank === undefined) continue;
      const updatedAt = Number(node.payload["updatedAt"] ?? 0);
      const selectedUpdatedAt = Number(selected?.payload["updatedAt"] ?? 0);
      if (
        selected === null
        || nodeRank > selectedRank
        || (nodeRank === selectedRank && (updatedAt > selectedUpdatedAt || (updatedAt === selectedUpdatedAt && node.id > selected.id)))
      ) {
        selected = node;
        selectedRank = nodeRank;
      }
    }
    return selected;
  };

  /**
   * Symbol graph reads go through TriviumDB's property indexes. Before 0.8.6 the
   * store kept eight JS-side maps (path → ids, links by value, connection literal
   * refcounts, denormalized symbol and link rows, file languages) that every
   * write had to keep consistent and every open rebuilt by walking all nodes
   * (D-109 / D-134 / D-139). `indexedLookup` and `substringLookup` answer the
   * same questions from persistent indexes, so what remains in memory is:
   *
   * - three lazily seeded counters, because counting rows through an index
   *   call still marshals every id (24K symbol ids ≈ 90 ms), and `explore`
   *   asks for the count once per query;
   * - one lazily rebuilt shape cache (file paths, languages, resolved reverse
   *   imports), because import resolution is Piarium's rule, not the
   *   database's, and it depends on the whole path set (D-139).
   *
   * Both are dropped on any graph write and rebuilt on the next read (D-141).
   */
  const LINK_KINDS = new Set<SymbolGraphLinkKind>(["import", "connects", "associates"]);
  const validLinkLine = (line: number): boolean => Number.isSafeInteger(line) && line >= 1;
  const validRange = (range: SymbolGraphRange): boolean => (
    [range.startLine, range.startCharacter, range.endLine, range.endCharacter]
      .every((value) => Number.isSafeInteger(value) && value >= 0)
    && (range.endLine > range.startLine || (range.endLine === range.startLine && range.endCharacter >= range.startCharacter))
  );

  type GraphNode = { id: number; payload: Record<string, unknown> };
  const lookup = (equalities: Record<string, unknown>): GraphNode[] => (
    db.indexedLookup(equalities, GRAPH_RESULT_CEILING).flatMap((id) => {
      const payload = db.getPayload(id) as Record<string, unknown> | null;
      return payload ? [{ id, payload }] : [];
    })
  );
  const fileNodes = (path: string) => lookup({ type: "file", path });
  const symbolNodes = (path: string) => lookup({ type: "symbol", path });
  const linkNodes = (path: string) => lookup({ type: "link", path });

  interface GraphCounters { files: number; symbols: number; links: number }
  let graphCounters: GraphCounters | null = null;
  const counters = (): GraphCounters => {
    if (graphCounters) return graphCounters;
    graphCounters = {
      files: db.indexedLookup({ type: "file" }, GRAPH_RESULT_CEILING).length,
      symbols: db.indexedLookup({ type: "symbol", active: true }, GRAPH_RESULT_CEILING).length,
      links: db.indexedLookup({ type: "link", active: true }, GRAPH_RESULT_CEILING).length,
    };
    return graphCounters;
  };
  const bumpCounters = (delta: Partial<GraphCounters>): void => {
    if (!graphCounters) return;
    graphCounters = {
      files: graphCounters.files + (delta.files ?? 0),
      symbols: graphCounters.symbols + (delta.symbols ?? 0),
      links: graphCounters.links + (delta.links ?? 0),
    };
  };

  /**
   * Two lazy layers, dropped together on any graph write. The file layer is
   * cheap (one indexed lookup over file nodes) and is all `catalogStats` needs;
   * the importer layer resolves every import specifier against the path set and
   * is only paid when `findImporters` is actually asked.
   */
  interface FileShape { paths: Set<string>; sortedPaths: string[]; languages: string[] }
  type ImportersByTarget = Map<string, Array<{ path: string; specifier: string }>>;
  let fileShapeCache: FileShape | null = null;
  let importersCache: ImportersByTarget | null = null;
  const invalidateGraphShape = (): void => {
    fileShapeCache = null;
    importersCache = null;
  };
  const fileShape = (): FileShape => {
    if (fileShapeCache) return fileShapeCache;
    const paths = new Set<string>();
    const languages = new Set<string>();
    for (const { payload } of lookup({ type: "file" })) {
      if (typeof payload["path"] !== "string") continue;
      paths.add(payload["path"]);
      if (typeof payload["language"] === "string") languages.add(payload["language"]);
    }
    fileShapeCache = { paths, sortedPaths: [...paths].toSorted(), languages: [...languages].toSorted() };
    return fileShapeCache;
  };
  const importers = (): ImportersByTarget => {
    if (importersCache) return importersCache;
    // Resolution needs the whole path set: a file added later can make another
    // file's specifier resolve, which is why any write drops this (D-139).
    const known = fileShape().paths;
    const byTarget: ImportersByTarget = new Map();
    for (const { payload } of lookup({ type: "link", kind: "import", active: true })) {
      const importer = payload["path"];
      const specifier = payload["value"];
      if (typeof importer !== "string" || typeof specifier !== "string") continue;
      const result = resolveImportSpecifier(importer, specifier, known);
      if (result.status !== "resolved") continue;
      const bucket = byTarget.get(result.resolvedPath);
      if (bucket) bucket.push({ path: importer, specifier });
      else byTarget.set(result.resolvedPath, [{ path: importer, specifier }]);
    }
    importersCache = byTarget;
    return byTarget;
  };

  const edgeLabelForKind = (kind: SymbolGraphLinkKind): "imports" | "connects" | "associates" => (
    kind === "import" ? "imports" : kind
  );
  const assertGraphText = (value: string, label: string): string => {
    const text = value.trim();
    if (!text) throw new KnowledgeMutationError("invalid", `${label} is required`);
    return text;
  };

  // Write queue — all writes go through this to ensure single-writer ordering
  const writeQueue: Promise<unknown> = Promise.resolve();
  let writeTail = writeQueue;
  function enqueueWrite<T>(fn: () => T): Promise<T> {
    const result = writeTail.then(fn, fn);
    writeTail = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * `db.flush()` writes the whole store, so its cost grows with the store: one
   * flush cost ~66 ms at 400 catalog files on this repository, and a catalog
   * build flushed once per file. That is what made a full build quadratic.
   *
   * The symbol graph is derived — a catalog scan rebuilds it and skips files
   * whose disk revision already matches — so graph writes are flushed on a
   * trailing debounce instead. Queue occupancy is deliberately not the trigger:
   * a scan interleaves a ~47 ms parse between writes, so the queue is almost
   * always down to one entry and an occupancy check flushes every time anyway
   * (measured: it moved a full build 18.4 → 17.6 min, i.e. not at all).
   *
   * `GRAPH_FLUSH_MAX_DEFER_MS` bounds how much derived work a crash can cost,
   * so a long scan still persists as it goes. Knowledge, blocks, events and
   * sessions are user data and keep flushing inside their own write, so this
   * never widens their window (D-140).
   */
  let graphFlushDirty = false;
  let graphFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let graphFlushDeadline = 0;

  function flushGraphNow(): void {
    if (graphFlushTimer) {
      clearTimeout(graphFlushTimer);
      graphFlushTimer = null;
    }
    graphFlushDeadline = 0;
    if (!graphFlushDirty) return;
    graphFlushDirty = false;
    db.flush();
  }

  function scheduleGraphFlush(): void {
    graphFlushDirty = true;
    const now = Date.now();
    if (graphFlushDeadline === 0) graphFlushDeadline = now + GRAPH_FLUSH_MAX_DEFER_MS;
    if (now >= graphFlushDeadline) {
      flushGraphNow();
      return;
    }
    if (graphFlushTimer) clearTimeout(graphFlushTimer);
    const delay = Math.min(GRAPH_FLUSH_QUIET_MS, Math.max(0, graphFlushDeadline - now));
    graphFlushTimer = setTimeout(() => {
      graphFlushTimer = null;
      // Ordered behind whatever is already queued so it never interleaves with
      // a transaction in progress.
      void enqueueWrite(() => flushGraphNow());
    }, delay);
    graphFlushTimer.unref?.();
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

    async getBlocks(sessionId: string, branchEntryIds?: readonly string[]): Promise<Block[]> {
      const nodes = blockNodes(sessionId);
      if (branchEntryIds === undefined) {
        // This unscoped view is retained only for migration/debug callers.
        // Production model/UI consumers resolve an explicit active branch.
        return nodes
          .filter((node) => !isDeletedBlock(node))
          .map((node) => blockFromPayload(node.payload))
          .sort((a, b) => a.label.localeCompare(b.label) || a.updatedAt - b.updatedAt);
      }
      const byLabel = new Map<string, StoredBlockNode[]>();
      for (const node of nodes) {
        const label = node.payload["label"] as string;
        const group = byLabel.get(label) ?? [];
        group.push(node);
        byLabel.set(label, group);
      }
      const visible: Block[] = [];
      for (const candidates of byLabel.values()) {
        const selected = visibleBlockNode(candidates, branchEntryIds);
        if (selected && !isDeletedBlock(selected)) visible.push(blockFromPayload(selected.payload));
      }
      return visible.sort((a, b) => a.label.localeCompare(b.label));
    },

    async upsertBlock(b: BlockInput): Promise<Block> {
      if (!BLOCK_NAME_RE.test(b.label)) {
        throw new Error(`Invalid block name: ${b.label}`);
      }
      const inputSourceLeaf = b.sourceLeafId ?? null;
      const branchEntryIds = b.branchEntryIds;
      if (
        inputSourceLeaf !== null
        && branchEntryIds !== undefined
        && branchEntryIds[branchEntryIds.length - 1] !== inputSourceLeaf
      ) {
        throw new Error("Block sourceLeafId must be the active branch leaf");
      }
      const { result, previous } = await enqueueWrite(() => {
        const candidates = blockNodes(b.sessionId, b.label);
        const resolvedNode = branchEntryIds === undefined
          ? newestNode(candidates.filter((node) => sourceLeafOf(node) === inputSourceLeaf))
          : visibleBlockNode(candidates, branchEntryIds);
        const current = resolvedNode && !isDeletedBlock(resolvedNode)
          ? blockFromPayload(resolvedNode.payload)
          : null;
        // Atomic CAS: check expectedUpdatedAt inside the write transaction.
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
          sourceLeafId: inputSourceLeaf,
          deleted: false,
        };

        const targetNode = newestNode(candidates.filter((node) => sourceLeafOf(node) === inputSourceLeaf));
        let id: number;
        if (targetNode) {
          db.updatePayload(targetNode.id, payload);
          id = targetNode.id;
        } else {
          id = db.insert(placeholderVec, payload);
        }
        db.indexText(id, b.content);
        db.flush();

        return { previous: current, result: {
          sessionId: b.sessionId,
          label: b.label,
          content: b.content,
          updatedBy: b.updatedBy,
          ...(b.cursorTurn !== undefined ? { cursorTurn: b.cursorTurn } : {}),
          updatedAt: now,
          sourceLeafId: inputSourceLeaf,
        } };
      });
      publishBlocksChanged(b.sessionId, { previous, current: result });
      return result;
    },

    async deleteBlock(
      sessionId: string,
      label: string,
      options?: {
        branchEntryIds?: readonly string[];
        expectedUpdatedAt?: number | null;
        sourceLeafId?: string | null;
        updatedBy?: BlockUpdatedBy;
        cursorTurn?: number;
      },
    ): Promise<void> {
      const branchEntryIds = options?.branchEntryIds;
      const expectedUpdatedAt = options?.expectedUpdatedAt;
      const sourceLeafId = options?.sourceLeafId
        ?? (branchEntryIds && branchEntryIds.length > 0 ? branchEntryIds[branchEntryIds.length - 1]! : null);
      const previous = await enqueueWrite(() => {
        const nodes = blockNodes(sessionId, label);
        const resolvedNode = branchEntryIds === undefined
          ? newestNode(nodes.filter((node) => sourceLeafOf(node) === sourceLeafId))
          : visibleBlockNode(nodes, branchEntryIds);
        const currentBlock = resolvedNode && !isDeletedBlock(resolvedNode)
          ? blockFromPayload(resolvedNode.payload)
          : null;
        // Atomic CAS for delete: check expectedUpdatedAt inside the write transaction.
        if (expectedUpdatedAt !== undefined) {
          if (
            (expectedUpdatedAt === null && currentBlock !== null)
            || (typeof expectedUpdatedAt === "number" && currentBlock?.updatedAt !== expectedUpdatedAt)
          ) {
            throw new KnowledgeBlockConflictError(currentBlock);
          }
        }
        if (branchEntryIds === undefined) {
          // Legacy unscoped deletion retains its historical whole-session behavior.
          for (const node of nodes) db.delete(node.id);
          db.flush();
          return currentBlock;
        }
        if (!currentBlock) return null;
        const timestamp = Math.max(Date.now(), currentBlock.updatedAt + 1);
        const tombstone = {
          type: "block",
          sessionId,
          label,
          content: "",
          updatedBy: options?.updatedBy ?? "memory-agent",
          ...(options?.cursorTurn !== undefined ? { cursorTurn: options.cursorTurn } : {}),
          updatedAt: timestamp,
          sourceLeafId,
          deleted: true,
        };
        const targetNode = newestNode(nodes.filter((node) => sourceLeafOf(node) === sourceLeafId));
        if (targetNode) db.updatePayload(targetNode.id, tombstone);
        else db.insert(placeholderVec, tombstone);
        db.flush();
        return currentBlock;
      });
      publishBlocksChanged(sessionId, { previous, current: null });
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
        const previous = existing[0]?.payload ?? {};
        const payload = {
          type: "file",
          path: normalizedPath,
          language: normalizedLanguage,
          modifiedAt: Date.now(),
          active: true,
          ...(typeof previous["generation"] === "string" ? { generation: previous["generation"] } : {}),
          ...(typeof previous["documentRevision"] === "string" ? { documentRevision: previous["documentRevision"] } : {}),
          ...(previous["linksIncomplete"] === true ? { linksIncomplete: true } : {}),
        };
        const fileId = existing[0]?.id ?? db.insert(placeholderVec, payload);
        const operations: TransactionOperation[] = [
          { type: "updatePayload", id: fileId, payload },
          ...existing.slice(1).map(({ id }) => ({ type: "delete" as const, id })),
        ];
        db.commitTransaction(operations);
        bumpCounters({ files: existing.length === 0 ? 1 : 1 - existing.length });
        invalidateGraphShape();
        db.indexText(fileId, normalizedPath);
        scheduleGraphFlush();
        return fileId;
      });
    },

    async replaceFileSymbols(path, language, symbols, documentRevision, links = [], options = {}) {
      return enqueueWrite(() => {
        const normalizedPath = assertGraphText(path, "File path");
        const normalizedLanguage = assertGraphText(language, "File language");
        const normalizedRevision = assertGraphText(documentRevision, "Document revision");
        for (const symbol of symbols) {
          assertGraphText(symbol.name, "Symbol name");
          assertGraphText(symbol.kind, "Symbol kind");
          if (!validRange(symbol.range)) throw new KnowledgeMutationError("invalid", `Invalid range for symbol ${symbol.name}`);
        }
        for (const link of links) {
          if (!LINK_KINDS.has(link.kind)) throw new KnowledgeMutationError("invalid", `Invalid link kind ${String(link.kind)}`);
          assertGraphText(link.value, "Link value");
          if (!validLinkLine(link.line)) throw new KnowledgeMutationError("invalid", `Invalid line for link ${link.value}`);
          if (link.kind !== "import") assertGraphText(link.callee ?? "", "Link callee");
        }
        const generation = randomUUID();
        const previousFiles = fileNodes(normalizedPath);
        const previousSymbols = symbolNodes(normalizedPath);
        const previousLinks = linkNodes(normalizedPath);
        const fileId = previousFiles[0]?.id ?? db.insert(placeholderVec, {
          type: "file",
          path: normalizedPath,
          language: normalizedLanguage,
          modifiedAt: Date.now(),
          active: true,
          generation,
          documentRevision: normalizedRevision,
        });
        // `nameLower` / `pathLower` exist for the n-gram indexes: substring
        // search is case-sensitive and `searchSymbols` compares lowercased.
        const pathLower = normalizedPath.toLowerCase();
        const pendingPayloads = symbols.map((symbol) => ({
          type: "symbol",
          path: normalizedPath,
          pathLower,
          language: normalizedLanguage,
          name: symbol.name,
          nameLower: symbol.name.toLowerCase(),
          kind: symbol.kind,
          range: { ...symbol.range },
          generation,
          documentRevision: normalizedRevision,
          active: false,
        }));
        const pendingLinkPayloads = links.map((link) => ({
          type: "link",
          path: normalizedPath,
          language: normalizedLanguage,
          kind: link.kind,
          value: link.value,
          line: link.line,
          ...(link.kind !== "import" && link.callee ? { callee: link.callee } : {}),
          generation,
          documentRevision: normalizedRevision,
          active: false,
        }));
        const symbolIds = pendingPayloads.length > 0
          ? db.batchInsert(pendingPayloads.map(() => placeholderVec), pendingPayloads)
          : [];
        const linkIds = pendingLinkPayloads.length > 0
          ? db.batchInsert(pendingLinkPayloads.map(() => placeholderVec), pendingLinkPayloads)
          : [];
        const activePayloads = pendingPayloads.map((payload) => ({ ...payload, active: true }));
        const activeLinkPayloads = pendingLinkPayloads.map((payload) => ({ ...payload, active: true }));
        const filePayload = {
          type: "file",
          path: normalizedPath,
          language: normalizedLanguage,
          modifiedAt: Date.now(),
          active: true,
          generation,
          documentRevision: normalizedRevision,
          ...(options.linksIncomplete ? { linksIncomplete: true } : {}),
        };
        const previousTargets = new Set([
          ...previousSymbols.map(({ id }) => id),
          ...previousLinks.map(({ id }) => id),
        ]);
        const outgoingUnlinks: TransactionOperation[] = db.getEdges(fileId).flatMap((edge) => (
          previousTargets.has(edge.targetId)
            ? [{ type: "unlinkLabel" as const, src: fileId, dst: edge.targetId, label: edge.label }]
            : []
        ));
        const operations: TransactionOperation[] = [
          { type: "updatePayload", id: fileId, payload: filePayload },
          ...previousFiles.slice(1).map(({ id }) => ({ type: "delete" as const, id })),
          ...outgoingUnlinks,
          ...previousSymbols.map(({ id }) => ({ type: "delete" as const, id })),
          ...previousLinks.map(({ id }) => ({ type: "delete" as const, id })),
          ...symbolIds.flatMap((id, index): TransactionOperation[] => [
            { type: "updatePayload", id, payload: activePayloads[index] },
            { type: "upsertEdge", src: fileId, dst: id, label: "defines", weight: 1 },
          ]),
          ...linkIds.flatMap((id, index): TransactionOperation[] => [
            { type: "updatePayload", id, payload: activeLinkPayloads[index] },
            { type: "upsertEdge", src: fileId, dst: id, label: edgeLabelForKind(links[index]!.kind), weight: 1 },
          ]),
        ];
        db.commitTransaction(operations);
        bumpCounters({
          files: previousFiles.length === 0 ? 1 : 1 - previousFiles.length,
          symbols: symbolIds.length - previousSymbols.filter(({ payload }) => payload["active"] === true).length,
          links: linkIds.length - previousLinks.filter(({ payload }) => payload["active"] === true).length,
        });
        invalidateGraphShape();
        db.indexText(fileId, normalizedPath);
        for (let index = 0; index < symbolIds.length; index += 1) {
          const id = symbolIds[index]!;
          const symbol = symbols[index]!;
          db.indexText(id, `${symbol.name} ${normalizedPath}`);
          db.indexKeyword(id, symbol.name);
        }
        for (let index = 0; index < linkIds.length; index += 1) {
          const id = linkIds[index]!;
          const link = links[index]!;
          db.indexText(id, `${link.value} ${normalizedPath}`);
          db.indexKeyword(id, link.value);
        }
        scheduleGraphFlush();
        return { fileId, symbols: symbolIds.length, edges: symbolIds.length + linkIds.length };
      });
    },

    async removeFileSymbols(path) {
      return enqueueWrite(() => {
        const normalizedPath = assertGraphText(path, "File path");
        const files = fileNodes(normalizedPath);
        const symbols = symbolNodes(normalizedPath);
        const links = linkNodes(normalizedPath);
        const operations: TransactionOperation[] = [
          ...symbols.map(({ id }) => ({ type: "delete" as const, id })),
          ...links.map(({ id }) => ({ type: "delete" as const, id })),
          ...files.map(({ id }) => ({ type: "delete" as const, id })),
        ];
        if (operations.length > 0) db.commitTransaction(operations);
        bumpCounters({
          files: -files.length,
          symbols: -symbols.filter(({ payload }) => payload["active"] === true).length,
          links: -links.filter(({ payload }) => payload["active"] === true).length,
        });
        invalidateGraphShape();
        scheduleGraphFlush();
        return { removedFiles: files.length, removedSymbols: symbols.length };
      });
    },

    async searchSymbols(query, k) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (terms.length === 0 || !Number.isSafeInteger(k) || k <= 0) return [];
      // Candidates come from the indexes; scoring is unchanged and still runs
      // over every term, so a candidate found through one term is scored on
      // all of them. The n-gram index needs three characters, so a shorter term
      // can only match a name exactly — `db` finds `db`, not `dbPath`, and
      // never matches a path (D-141).
      const candidateIds = new Set<number>();
      for (const term of terms) {
        if (term.length >= NGRAM_MIN_CHARS) {
          for (const id of db.substringLookup("nameLower", term, GRAPH_RESULT_CEILING)) candidateIds.add(id);
          for (const id of db.substringLookup("pathLower", term, GRAPH_RESULT_CEILING)) candidateIds.add(id);
        } else {
          for (const id of db.indexedLookup({ type: "symbol", nameLower: term }, GRAPH_RESULT_CEILING)) candidateIds.add(id);
        }
      }
      const results: SymbolGraphSearchResult[] = [];
      for (const id of candidateIds) {
        const payload = db.getPayload(id) as Record<string, unknown> | null;
        if (!payload || payload["type"] !== "symbol" || payload["active"] !== true) continue;
        const name = typeof payload["name"] === "string" ? payload["name"] : "";
        const path = typeof payload["path"] === "string" ? payload["path"] : "";
        const kind = typeof payload["kind"] === "string" ? payload["kind"] : "";
        const range = payload["range"] as SymbolGraphRange | undefined;
        if (!name || !path || !kind || !range || !validRange(range)) continue;
        const scored = scoreSymbolMatch(name.toLowerCase(), path.toLowerCase(), terms);
        if (!scored) continue;
        results.push({
          id,
          name,
          path,
          kind,
          range: { ...range },
          score: scored.score,
          match: scored.match,
          documentRevision: typeof payload["documentRevision"] === "string" ? payload["documentRevision"] : null,
        });
      }
      return results
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
                documentRevision: typeof payload["documentRevision"] === "string" ? payload["documentRevision"] : null,
              }]
            : [];
        })
        .toSorted((left, right) => left.range.startLine - right.range.startLine || left.range.startCharacter - right.range.startCharacter || left.name.localeCompare(right.name));
    },

    async getFileRelations(path) {
      const normalizedPath = assertGraphText(path, "File path");
      const file = fileNodes(normalizedPath)[0];
      if (!file) return null;
      const documentRevision = typeof file.payload["documentRevision"] === "string" ? file.payload["documentRevision"] : null;
      const generation = typeof file.payload["generation"] === "string" ? file.payload["generation"] : null;
      const imports: SymbolGraphFileRelations["imports"] = [];
      const connections: SymbolGraphFileRelations["connections"] = [];
      const associations: SymbolGraphFileRelations["associations"] = [];
      let danglingEdges = 0;
      for (const edge of db.getEdges(file.id)) {
        const payload = db.getPayload(edge.targetId) as Record<string, unknown> | null;
        if (!payload) {
          danglingEdges += 1;
          continue;
        }
        const line = payload["line"];
        const value = typeof payload["value"] === "string" ? payload["value"] : "";
        const revision = typeof payload["documentRevision"] === "string" ? payload["documentRevision"] : null;
        if (edge.label === "imports" && payload["type"] === "link" && payload["active"] === true && value && validLinkLine(Number(line))) {
          imports.push({ specifier: value, line: Number(line), documentRevision: revision });
          continue;
        }
        if (
          (edge.label === "connects" || edge.label === "associates")
          && payload["type"] === "link"
          && payload["active"] === true
          && value
          && typeof payload["callee"] === "string"
          && validLinkLine(Number(line))
        ) {
          const entry = { callee: payload["callee"], literal: value, line: Number(line), documentRevision: revision };
          if (edge.label === "connects") connections.push(entry);
          else associations.push(entry);
          continue;
        }
        if (edge.label === "defines" && payload["type"] === "symbol") continue;
        if (edge.label === "defines" || edge.label === "imports" || edge.label === "connects" || edge.label === "associates") {
          danglingEdges += 1;
        }
      }
      const byLine = <T extends { line: number; specifier?: string; literal?: string; callee?: string }>(left: T, right: T) => (
        left.line - right.line
        || (left.specifier ?? left.literal ?? "").localeCompare(right.specifier ?? right.literal ?? "")
        || (left.callee ?? "").localeCompare(right.callee ?? "")
      );
      return {
        path: normalizedPath,
        documentRevision,
        generation,
        linksIncomplete: file.payload["linksIncomplete"] === true,
        imports: imports.toSorted(byLine),
        connections: connections.toSorted(byLine),
        associations: associations.toSorted(byLine),
        danglingEdges,
      };
    },

    async connectionLiterals(values) {
      const found = new Set<string>();
      for (const value of new Set(values)) {
        if (db.indexedLookup({ type: "link", kind: "connects", value, active: true }, GRAPH_RESULT_CEILING).length > 0) found.add(value);
      }
      return found;
    },

    async findLinks(value) {
      const normalized = assertGraphText(value, "Link value");
      return lookup({ type: "link", value: normalized, active: true })
        .flatMap(({ payload }) => {
          const path = typeof payload["path"] === "string" ? payload["path"] : "";
          const kind = payload["kind"];
          const line = Number(payload["line"]);
          if (!path || !LINK_KINDS.has(kind as SymbolGraphLinkKind) || !validLinkLine(line)) return [];
          return [{
            path,
            kind: kind as SymbolGraphLinkKind,
            value: normalized,
            line,
            ...(typeof payload["callee"] === "string" ? { callee: payload["callee"] } : {}),
            documentRevision: typeof payload["documentRevision"] === "string" ? payload["documentRevision"] : null,
          }];
        })
        .toSorted((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.kind.localeCompare(right.kind));
    },

    async catalogStats() {
      const counts = counters();
      const files = fileShape();
      return {
        symbolCount: counts.symbols,
        fileCount: counts.files,
        linkCount: counts.links,
        languages: files.languages,
        paths: files.sortedPaths,
      };
    },

    async findImporters(path) {
      const target = normalizeGraphPath(assertGraphText(path, "File path"));
      const resolved = [...(importers().get(target) ?? [])];
      return {
        path: target,
        resolved: resolved.toSorted((left, right) => left.path.localeCompare(right.path) || left.specifier.localeCompare(right.specifier)),
      };
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
        // A graph burst may have deferred its flush; closing is the last chance.
        flushGraphNow();
        db.flush();
        db.close();
      });
    },
  };

  return store;
}
