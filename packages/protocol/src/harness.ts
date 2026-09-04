/**
 * Harness service request channel — typed protocol for worker→host service calls.
 *
 * The worker emits a `harness.request` event; the host routes it to a registered
 * service and calls `harness.respond` with the result. This mirrors the
 * `workspace.mutation.request` / `workspace.mutation.respond` pattern so the
 * channel works across every transport (local, Electron, relay) without the
 * worker holding host credentials.
 */

import type {
  ThreadListParams,
  ThreadListResult,
  ThreadWaitParams,
  ThreadWaitResult,
  ThreadSendParams,
  ThreadSendResult,
  ThreadReadParams,
  ThreadReadResult,
  ThreadMergeParams,
  ThreadMergeResult,
  ThreadKillParams,
  ThreadKillResult,
  ThreadDispatchParams,
  ThreadDispatchResult,
} from "./harness-threads.js";

export interface OutputSlice {
  text: string;
  offset: number;
  length: number;
  nextOffset: number;
  total: number;
  eof: boolean;
}

export interface OutputRef {
  durability: "ephemeral";
  generation: string;
  handle: string;
}

export interface ShellExecResultCompleted {
  kind: "completed";
  exitCode: number;
  durationMs: number;
  cwd: string;
  stdout: string;
  stderr: string;
  handle: string | null;
  shown: { head: number; tail: number; total: number } | null;
}

export interface ShellExecResultBackground {
  kind: "background";
  id: string;
  waitedMs: number;
  cwd: string;
  outputSoFar: string;
}

export interface ShellExecResultSpawnFailed {
  kind: "spawn-failed";
  reason: string;
  interpreter: string;
  hint: string;
}

export type ShellExecResult =
  | ShellExecResultCompleted
  | ShellExecResultBackground
  | ShellExecResultSpawnFailed;

export interface ShellReadResult extends OutputSlice {
  running: boolean;
  exitCode?: number;
}

export interface SearchContentParams {
  pattern: string;
  path?: string;
  glob?: string[];
  type?: string;
  ignoreCase?: boolean;
  fixedStrings?: boolean;
  before?: number;
  after?: number;
  context?: number;
  mode?: "content" | "files" | "count";
  limit?: number;
}

export interface SearchContentHit {
  line: number;
  text: string;
  before: string[];
  after: string[];
}

export interface SearchContentFile {
  path: string;
  hits: SearchContentHit[];
}

export interface SearchContentResult {
  status: "ready" | "empty" | "unavailable";
  files: SearchContentFile[];
  totalHits: number;
  totalFiles: number;
  searchedFiles: number;
  partial: boolean;
  handle?: string;
}

export interface DiagnosticsResult {
  status: "ready" | "pending" | "unavailable";
  snapshot?: string;
  diagnostics: Array<{
    line: number;
    character: number;
    severity: string;
    code?: string;
    message: string;
    source: string;
  }>;
  reason?: string;
}

export type FsLockParams =
  | { action: "acquire"; paths: string[]; timeoutMs?: number }
  | { action: "release"; leaseId: string };

export type FsLockResult =
  | { held: true; leaseIds: string[] }
  | { held: false; released: boolean };

export type FetchResult =
  | { status: "ok"; url: string; finalUrl: string; contentType: string; title?: string; markdown: string; bytes: number; fromCache: boolean; rendered: boolean }
  | { status: "redirect-cross-host"; url: string; location: string; statusCode: number }
  | { status: "blocked"; url: string; reason: "private-network" | "domain-blocked" | "scheme" }
  | { status: "empty-shell"; url: string; hint: string }
  | { status: "renderer-unavailable"; url: string }
  | { status: "failed"; url: string; reason: string };

export interface WebReadResult {
  answer: string;
  sources: string[];
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

// ── Phase 2: Zone 2, compaction, todo, recall ──────────────────────

export interface Zone2AssembleParams {
  sinceTurn: number;
}

export interface Zone2AssembleResult {
  content: string | null;
}

export interface CompactionBeforeParams {
  sessionId: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export interface CompactionBeforeResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export interface CompactionAfterParams {
  sessionId: string;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export interface CompactionAfterResult {
  acknowledged: boolean;
}

export interface TodoUpsertParams {
  sessionId: string;
  items: Array<{ text: string; status: "open" | "done" | "blocked" }>;
  confidence?: number;
}

export interface TodoUpsertResult {
  text: string;
  confirmed?: boolean;
  askedConfirmation: boolean;
}

export interface RecallSearchParams {
  query: string;
  k?: number;
}

export interface RecallSearchResultItem {
  scope: string;
  title: string;
  via: string;
  id: number;
}

export interface RecallSearchResult {
  text: string;
  results: RecallSearchResultItem[];
}

export interface HarnessServiceMap {
  "shell.exec": { params: { command: string; cwd?: string; waitMs?: number }; result: ShellExecResult };
  "shell.read": { params: { id: string; offset?: number; length?: number }; result: ShellReadResult };
  "shell.write": { params: { id: string; text: string }; result: { accepted: boolean } };
  "shell.kill": { params: { id: string }; result: { killed: boolean } };
  "output.store": { params: { text: string; label?: string }; result: { ref: OutputRef; total: number } };
  "output.read": { params: { handle: string; offset?: number; length?: number }; result: OutputSlice };
  "search.content": { params: SearchContentParams; result: SearchContentResult };
  "lsp.diagnostics": { params: { path: string; afterSnapshot?: string; waitMs?: number }; result: DiagnosticsResult };
  "lsp.diagnosticsSnapshot": { params: { path: string }; result: DiagnosticsResult };
  "fs.lock": { params: FsLockParams; result: FsLockResult };
  "web.fetch": { params: { url: string; render?: boolean }; result: FetchResult };
  "web.read": { params: { url: string; prompt: string; render?: boolean }; result: WebReadResult };
  "web.search": { params: { query: string; allowedDomains?: string[]; blockedDomains?: string[]; recency?: "day" | "week" | "month" | "year"; limit?: number }; result: { providerId: string; results: SearchResultItem[] } };
  "zone2.assemble": { params: Zone2AssembleParams; result: Zone2AssembleResult };
  "compaction.before": { params: CompactionBeforeParams; result: CompactionBeforeResult };
  "compaction.after": { params: CompactionAfterParams; result: CompactionAfterResult };
  "todo.upsert": { params: TodoUpsertParams; result: TodoUpsertResult };
  "recall.search": { params: RecallSearchParams; result: RecallSearchResult };
  // Phase 3: Thread operations
  "thread.dispatch": { params: ThreadDispatchParams; result: ThreadDispatchResult };
  "thread.list": { params: ThreadListParams; result: ThreadListResult };
  "thread.wait": { params: ThreadWaitParams; result: ThreadWaitResult };
  "thread.send": { params: ThreadSendParams; result: ThreadSendResult };
  "thread.read": { params: ThreadReadParams; result: ThreadReadResult };
  "thread.merge": { params: ThreadMergeParams; result: ThreadMergeResult };
  "thread.kill": { params: ThreadKillParams; result: ThreadKillResult };
}

export type HarnessMethod = keyof HarnessServiceMap;

/**
 * Coarse, host-enforced capabilities for worker-to-host harness services.
 * These describe structural authority only; interactive allow/ask/deny policy
 * remains owned by the Pi tool gate.
 */
export type HarnessCapability =
  | "context.session"
  | "control.thread"
  | "process.shell"
  | "read.lsp"
  | "read.output"
  | "read.search"
  | "read.web"
  | "write.document";

export const HARNESS_METHOD_CAPABILITY = {
  "shell.exec": "process.shell",
  "shell.read": "process.shell",
  "shell.write": "process.shell",
  "shell.kill": "process.shell",
  "output.store": "read.output",
  "output.read": "read.output",
  "search.content": "read.search",
  "lsp.diagnostics": "read.lsp",
  "lsp.diagnosticsSnapshot": "read.lsp",
  "fs.lock": "write.document",
  "web.fetch": "read.web",
  "web.read": "read.web",
  "web.search": "read.web",
  "zone2.assemble": "context.session",
  "compaction.before": "context.session",
  "compaction.after": "context.session",
  "todo.upsert": "context.session",
  "recall.search": "context.session",
  "thread.dispatch": "control.thread",
  "thread.list": "control.thread",
  "thread.wait": "control.thread",
  "thread.send": "control.thread",
  "thread.read": "control.thread",
  "thread.merge": "control.thread",
  "thread.kill": "control.thread",
} as const satisfies Record<HarnessMethod, HarnessCapability>;

/** Identity attached by the broker after it has pinned a worker to a session. */
export interface HarnessActorIdentity {
  authorityInstanceId: string;
  sessionId: string;
  runId?: string;
  /** Broker-pinned relative workspace paths for a restricted child Run. */
  workspaceScope?: readonly string[];
  workerId: string;
  workerGeneration: number;
}

/** Identity completed with workspace and frozen authority by the Host. */
export interface HarnessActorContext extends HarnessActorIdentity {
  workspaceId: string | null;
  grantedCapabilities: readonly HarnessCapability[];
}

const HARNESS_METHODS: ReadonlySet<string> = new Set<string>([
  "shell.exec",
  "shell.read",
  "shell.write",
  "shell.kill",
  "output.store",
  "output.read",
  "search.content",
  "lsp.diagnostics",
  "lsp.diagnosticsSnapshot",
  "fs.lock",
  "web.fetch",
  "web.read",
  "web.search",
  "zone2.assemble",
  "compaction.before",
  "compaction.after",
  "todo.upsert",
  "recall.search",
  "thread.dispatch",
  "thread.list",
  "thread.wait",
  "thread.send",
  "thread.read",
  "thread.merge",
  "thread.kill",
]);

export function isHarnessMethod(value: unknown): value is HarnessMethod {
  return typeof value === "string" && HARNESS_METHODS.has(value);
}

export type HarnessError = {
  code: "unavailable" | "timeout" | "invalid-params" | "not-found" | "expired" | "denied" | "forbidden" | "failed";
  message: string;
  retryable?: boolean;
};

export interface HarnessRequestData {
  requestId: string;
  method: HarnessMethod;
  params: unknown;
  /**
   * How long the worker is prepared to wait, in milliseconds. The router
   * uses it instead of its own default so a deliberately long call such as
   * `thread.wait` is not aborted at the default 30s. Clamped by the router
   * to `HARNESS_MAX_REQUEST_TIMEOUT_MS`; absent means "use the default".
   */
  timeoutMs?: number;
}

/**
 * Upper bound the router applies to a worker-supplied `timeoutMs`. A worker
 * must not be able to pin a host handler open indefinitely.
 */
export const HARNESS_MAX_REQUEST_TIMEOUT_MS = 3_600_000;

export type HarnessRespondParams = {
  requestId: string;
  sessionId: string;
} & (
  | { ok: true; result: unknown }
  | { ok: false; error: HarnessError }
);

/**
 * Build the typed `harness.respond` params from a router outcome.
 * Callers pass this to `piRuntimeBroker.requestForSession(sessionId, 'harness.respond', params)`.
 */
export function buildHarnessRespondParams(
  sessionId: string,
  requestId: string,
  outcome: { ok: true; result: unknown } | { ok: false; error: HarnessError },
): HarnessRespondParams {
  if (outcome.ok) {
    return { requestId, sessionId, ok: true, result: outcome.result };
  }
  return { requestId, sessionId, ok: false, error: outcome.error };
}
