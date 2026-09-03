/**
 * Harness service request channel — typed protocol for worker→host service calls.
 *
 * The worker emits a `harness.request` event; the host routes it to a registered
 * service and calls `harness.respond` with the result. This mirrors the
 * `workspace.mutation.request` / `workspace.mutation.respond` pattern so the
 * channel works across every transport (local, Electron, relay) without the
 * worker holding host credentials.
 */

export interface OutputSlice {
  text: string;
  offset: number;
  length: number;
  total: number;
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

export interface HarnessServiceMap {
  "shell.exec": { params: { command: string; cwd?: string; waitMs?: number }; result: ShellExecResult };
  "shell.read": { params: { id: string; offset?: number; length?: number }; result: ShellReadResult };
  "shell.write": { params: { id: string; text: string }; result: { accepted: boolean } };
  "shell.kill": { params: { id: string }; result: { killed: boolean } };
  "output.store": { params: { text: string; label?: string }; result: { handle: string; total: number } };
  "output.read": { params: { handle: string; offset?: number; length?: number }; result: OutputSlice };
  "search.content": { params: SearchContentParams; result: SearchContentResult };
  "lsp.diagnostics": { params: { path: string; afterSnapshot?: string; waitMs?: number }; result: DiagnosticsResult };
  "lsp.diagnosticsSnapshot": { params: { path: string }; result: DiagnosticsResult };
  "fs.lock": { params: { path: string; action: "acquire" | "release"; timeoutMs?: number }; result: { held: boolean } };
  "web.fetch": { params: { url: string; render?: boolean }; result: FetchResult };
  "web.read": { params: { url: string; prompt: string; render?: boolean }; result: WebReadResult };
  "web.search": { params: { query: string; allowedDomains?: string[]; blockedDomains?: string[]; recency?: "day" | "week" | "month" | "year"; limit?: number }; result: { providerId: string; results: SearchResultItem[] } };
}

export type HarnessMethod = keyof HarnessServiceMap;

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
]);

export function isHarnessMethod(value: unknown): value is HarnessMethod {
  return typeof value === "string" && HARNESS_METHODS.has(value);
}

export type HarnessError = {
  code: "unavailable" | "timeout" | "invalid-params" | "not-found" | "denied" | "failed";
  message: string;
  retryable?: boolean;
};

export interface HarnessRequestData {
  requestId: string;
  sessionId: string;
  method: HarnessMethod;
  params: unknown;
}

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
