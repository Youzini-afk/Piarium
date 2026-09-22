import {
  buildSessionContext,
  convertToLlm,
  estimateTokens,
  findCutPoint,
  sessionEntryToContextMessages,
  type AgentSession,
  type AgentSessionEvent,
  type CompactionResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { CompactionRunResult, CompactionTaskSpec, JsonValue } from "@varin/protocol";
import { retainedContextState } from "./retained-context.js";
import {
  compactionWorkerContext,
  serializeCompactionModel,
} from "./compaction-agent.js";

import {
  attachContextRequestBoundary, ContextCapacityError, contextRequestKey, estimateModelInputTokens,
  modelRequestOptions,
  type ContextModelRequest,
  type ContextRequestBoundaryOptions,
} from "./context-request-boundary.js";

/**
 * Context preparation extension — fixed-candidate background compaction.
 *
 * Design: agent-harness.md §8.4–8.6, context-compaction-agent-design.md (D-314)
 * Plan: agent-harness-plan.md §2.4A/B, §2.6A, stage C
 * Decisions: D-284, D-286, D-314
 *
 * Budget is measured on the `context` hook, which Pi runs before every
 * provider request — including tool-loop continuations inside one turn.
 * When usage crosses the soft waterline, a fixed candidate is prepared in
 * the background (P + S0 + A + B fixed at preparation time). The foreground
 * agent keeps running; normal appends do not invalidate the candidate.
 *
 * The candidate runs in a dedicated internal compaction worker subprocess
 * (broker-spawned pi-host, role "compaction") that receives the frozen
 * S0/A/B material plus the shared continuation prompt and may issue
 * read-only history/output/record queries under an auxiliary actor.
 *
 * When Pi actually needs compaction (threshold or overflow), the
 * `session_before_compact` hook commits the matching candidate, waits for
 * an in-flight one, or runs a fresh worker task from Pi's own preparation.
 * Failure keeps the original history; submission always goes through Pi's
 * native compaction writer at the request boundary.
 */

export interface ContextPreparationConfig {
  /** Background preparation switch (harness.context.backgroundPreparation). */
  enabled: boolean;
  /** Fraction of usable input where preparation starts (default 0.75). */
  waterline: number;
}

export interface ContextPreparationStatus {
  candidate: "none" | "preparing" | "ready";
  enabled: boolean;
}

interface FixedPreparation {
  /** Id of the compaction entry bounding the summarized range, or null. */
  boundaryCompactionId: string | null;
  /** First entry id included in the summarized range, or null. */
  firstSummarizedEntryId: string | null;
  /** Last entry id included in the summarized range. */
  lastSummarizedEntryId: string;
  firstKeptEntryId: string;
  /** Branch leaf id when the range was fixed; bounds B and history reads. */
  fixedLeafEntryId: string;
  isSplitTurn: boolean;
  /**
   * Entries that produced messagesToSummarize, in order, with each entry's
   * message count. Lets the parent page the oldest part of A out of the
   * worker's initial material with an authoritative elision boundary.
   */
  summarizedEntries: { id: string; messageCount: number }[];
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  /** Retained recent original (B): entries firstKept..fixedLeaf, verbatim. */
  keptMessages: AgentMessage[];
  previousSummary: string | undefined;
  tokensBefore: number;
}

export interface PreparedCandidate extends FixedPreparation {
  id: string;
  epoch: number;
  fixedAt: number;
  modelKey: string;
  tokensAtFix: number;
  status: "in-flight" | "ready" | "failed";
  /** The exact frozen task submitted to the worker. */
  spec: CompactionTaskSpec;
  abort: AbortController;
  done: Promise<void>;
  summary?: string;
  usage?: Usage;
  error?: string;
}

export interface ContextPreparationOptions {
  /**
   * Run one frozen compaction task in the dedicated internal worker
   * subprocess. Bound to the session's harness bridge in session-host;
   * cancellation propagates to worker teardown.
   */
  runCompactionTask: (
    spec: CompactionTaskSpec,
    signal: AbortSignal,
  ) => Promise<CompactionRunResult>;
  /** Live harness background-preparation setting. */
  getPreparationConfig: () => ContextPreparationConfig;
  /** Live Pi compaction settings (enabled, reserveTokens, keepRecentTokens). */
  getCompactionSettings: () => { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  /** Undefined means Pi's default, so the total-input planning target applies. */
  getExplicitKeepRecentTokens?: () => number | undefined;
  /** Publish native raw retention after an actual compaction or branch navigation. */
  onRetention?: (params: import("@varin/protocol").ContextRetentionParams) => void | Promise<void>;
  /** Per-request injection seam forwarded to the request boundary (D-300). */
  inject?: ContextRequestBoundaryOptions["inject"];
  onFailure?: (phase: "prepare" | "commit", message: string) => void;
  onSuccess?: (phase: "prepare" | "commit") => void;
  onStatus?: () => void;
  now?: () => number;
}

const DEFAULT_WATERLINE = 0.75;
/** Planned share of usable input after compaction; a target, not a limit. */
const POST_COMPACTION_TARGET = 0.6;
/** Estimated chars-per-token for request-shape prefixes (matches estimateTokens). */
const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// Fixed preparation — mirrors the SDK-internal prepareCompaction using the
// exported cut-point primitives, with a caller-chosen keepRecent budget.
// ---------------------------------------------------------------------------

function lastCompactionIndex(entries: SessionEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === "compaction") return i;
  }
  return -1;
}

function entryMessage(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === "compaction") return undefined;
  return sessionEntryToContextMessages(entry)[0];
}

export function computeFixedPreparation(
  entries: SessionEntry[],
  keepRecentTokens: number,
  tokensBefore?: number,
): FixedPreparation | undefined {
  if (entries.length === 0 || entries[entries.length - 1]!.type === "compaction") {
    return undefined;
  }
  const prevIndex = lastCompactionIndex(entries);
  const boundaryCompactionId = prevIndex >= 0 ? (entries[prevIndex]!.id ?? null) : null;
  let previousSummary: string | undefined;
  let boundaryStart = 0;
  if (prevIndex >= 0) {
    const prev = entries[prevIndex]!;
    previousSummary = prev.type === "compaction" ? prev.summary : undefined;
    const prevFirstKept = prev.type === "compaction"
      ? entries.findIndex((entry) => entry.id === prev.firstKeptEntryId)
      : -1;
    boundaryStart = prevFirstKept >= 0 ? prevFirstKept : prevIndex + 1;
  }
  // Pi's nearest-after cut search cannot find a point after a trailing
  // tool result. Keep at least that complete tool exchange; never choose a
  // tool-result boundary or accidentally retain the entire old branch.
  let pairedTailTokens = 0;
  for (let i = entries.length - 1; i >= boundaryStart; i--) {
    const messages = entries[i]!.type === "compaction" ? [] : sessionEntryToContextMessages(entries[i]!);
    if (messages.some((message) => message.role === "assistant" || message.role === "user")) break;
    pairedTailTokens += messages.reduce((tokens, message) => tokens + estimateTokens(message), 0);
  }
  const cut = findCutPoint(entries, boundaryStart, entries.length, Math.max(keepRecentTokens, pairedTailTokens + 1));
  const firstKept = entries[cut.firstKeptEntryIndex];
  if (!firstKept?.id) return undefined;
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
  const summarizedEntries: { id: string; messageCount: number }[] = [];
  const messagesToSummarize: AgentMessage[] = [];
  for (let i = boundaryStart; i < historyEnd; i++) {
    const entry = entries[i]!;
    if (entry.type === "compaction") continue;
    const messages = sessionEntryToContextMessages(entry);
    if (entry.id && messages.length > 0) {
      summarizedEntries.push({ id: entry.id, messageCount: messages.length });
    }
    messagesToSummarize.push(...messages);
  }
  const turnPrefixMessages: AgentMessage[] = [];
  if (cut.isSplitTurn) {
    for (let i = cut.turnStartIndex; i < cut.firstKeptEntryIndex; i++) {
      if (entries[i]!.type !== "compaction") turnPrefixMessages.push(...sessionEntryToContextMessages(entries[i]!));
    }
  }
  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;
  // Both the history range and a split turn prefix end at firstKeptEntryIndex,
  // so the last summarized entry is always the one just before it.
  const lastSummarizedEntryId = entries[cut.firstKeptEntryIndex - 1]?.id;
  if (!lastSummarizedEntryId) return undefined;
  let firstSummarizedEntryId: string | null = null;
  for (let i = boundaryStart; i < cut.firstKeptEntryIndex; i++) {
    if (entryMessage(entries[i]!) !== undefined) {
      firstSummarizedEntryId = entries[i]!.id ?? null;
      break;
    }
  }
  const fixedLeaf = entries[entries.length - 1]!;
  if (!fixedLeaf.id) return undefined;
  // B: the recent original text retained verbatim — actual content, not a marker.
  const keptMessages: AgentMessage[] = [];
  for (let i = cut.firstKeptEntryIndex; i < entries.length; i++) {
    if (entries[i]!.type !== "compaction") keptMessages.push(...sessionEntryToContextMessages(entries[i]!));
  }
  return {
    boundaryCompactionId,
    firstSummarizedEntryId,
    firstKeptEntryId: firstKept.id,
    fixedLeafEntryId: fixedLeaf.id,
    isSplitTurn: cut.isSplitTurn,
    lastSummarizedEntryId,
    keptMessages,
    summarizedEntries,
    messagesToSummarize,
    previousSummary,
    tokensBefore: tokensBefore ?? estimateModelInputTokens({ messages: convertToLlm(buildSessionContext(entries).messages) }),
    turnPrefixMessages,
  };
}

// ---------------------------------------------------------------------------
// Task spec — the program freezes identity and material; the compaction worker
// receives the structured S0/A/B content and the shared prompt, and only
// interprets it. Roles, order, and tool-call pairing survive end to end.
// ---------------------------------------------------------------------------

function buildCompactionTaskSpec(
  model: Model<Api>,
  sessionId: string,
  preparation: FixedPreparation,
  summaryOut: number,
  request: ContextModelRequest | undefined,
  customInstructions?: string,
): CompactionTaskSpec {
  const requestOptions = modelRequestOptions(request?.options);
  return {
    sessionId,
    boundaryCompactionId: preparation.boundaryCompactionId,
    firstSummarizedEntryId: preparation.firstSummarizedEntryId,
    lastSummarizedEntryId: preparation.lastSummarizedEntryId,
    firstKeptEntryId: preparation.firstKeptEntryId,
    fixedLeafEntryId: preparation.fixedLeafEntryId,
    isSplitTurn: preparation.isSplitTurn,
    summarizedMessages: preparation.messagesToSummarize as unknown as JsonValue[],
    turnPrefixMessages: preparation.turnPrefixMessages as unknown as JsonValue[],
    keptMessages: preparation.keptMessages as unknown as JsonValue[],
    ...(preparation.previousSummary === undefined
      ? {}
      : { previousSummary: preparation.previousSummary }),
    model: serializeCompactionModel(model),
    options: {
      maxTokens: summaryOut,
      ...(requestOptions.reasoning === undefined
        ? {}
        : { reasoning: String(requestOptions.reasoning) }),
      ...(requestOptions.thinkingBudgets === undefined
        ? {}
        : { thinkingBudgets: requestOptions.thinkingBudgets as Record<string, JsonValue> }),
      ...(requestOptions.temperature === undefined ? {} : { temperature: requestOptions.temperature }),
      ...(requestOptions.samplingParams === undefined
        ? {}
        : { samplingParams: requestOptions.samplingParams as Record<string, JsonValue> }),
      ...(requestOptions.transport === undefined
        ? {}
        : { transport: String(requestOptions.transport) }),
      ...(requestOptions.cacheRetention === undefined
        ? {}
        : { cacheRetention: String(requestOptions.cacheRetention) }),
      sessionId,
    },
    ...(customInstructions === undefined ? {} : { customInstructions }),
  };
}

/** Estimated tokens of the exact request the worker agent will send. */
function estimateWorkerRequest(spec: CompactionTaskSpec): number {
  const request = compactionWorkerContext(spec);
  return estimateModelInputTokens({
    systemPrompt: request.systemPrompt,
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    messages: convertToLlm(request.messages),
  });
}

/**
 * The worker's request must fit the same model window it runs on. When the
 * frozen material overflows, page the oldest summarized entries out of the
 * initial material with an authoritative boundary — the worker reads them
 * back through compaction.history inside the frozen branch. Never silently
 * drop material: the elision marker makes the unread range explicit.
 */
function fitSpecToWindow(
  spec: CompactionTaskSpec,
  preparation: FixedPreparation,
  contextWindow: number,
): CompactionTaskSpec | undefined {
  let fitted = spec;
  let droppedMessages = 0;
  let elidedThrough: string | undefined;
  const fits = () =>
    estimateWorkerRequest(fitted) + fitted.options.maxTokens <= contextWindow;
  for (const span of preparation.summarizedEntries) {
    if (fits()) return fitted;
    droppedMessages += span.messageCount;
    elidedThrough = span.id;
    fitted = {
      ...fitted,
      elidedSummarizedThroughEntryId: elidedThrough,
      summarizedMessages: preparation.messagesToSummarize.slice(droppedMessages) as unknown as JsonValue[],
    };
  }
  return fits() ? fitted : undefined;
}

/**
 * Entry-id/message-count spans for a summarize range derived from raw branch
 * entries (the synchronous commit path, where Pi hands prepared messages).
 * `dropTailMessages` excludes the split-turn prefix, which Pi reports
 * separately and which is never elided.
 */
function summarizedEntrySpans(
  entries: SessionEntry[],
  endExclusive: number,
  dropTailMessages = 0,
): { spans: { id: string; messageCount: number }[]; aligned: boolean } {
  const spans: { id: string; messageCount: number }[] = [];
  let total = 0;
  for (let i = 0; i < endExclusive; i++) {
    const entry = entries[i]!;
    if (entry.type === "compaction") continue;
    const count = sessionEntryToContextMessages(entry).length;
    total += count;
    if (entry.id && count > 0) spans.push({ id: entry.id, messageCount: count });
  }
  let remaining = Math.max(0, total - dropTailMessages);
  const head: { id: string; messageCount: number }[] = [];
  for (const span of spans) {
    if (remaining <= 0) break;
    // A span that straddles the summarized/prefix boundary cannot serve as an
    // elision bound — the marker would claim material still present.
    if (span.messageCount > remaining) return { spans: [], aligned: false };
    head.push(span);
    remaining -= span.messageCount;
  }
  return { spans: head, aligned: total >= dropTailMessages };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export type ContextPreparationExtension = ExtensionFactory & {
  status(): ContextPreparationStatus;
  attach(session: AgentSession, onEvent: (event: AgentSessionEvent) => void): void;
  isBound(): boolean;
  isCommitting(): boolean;
  observeRequest(request: ContextModelRequest): void;
};

export function createContextPreparationExtension(
  options: ContextPreparationOptions,
): ContextPreparationExtension {
  let candidate: PreparedCandidate | undefined;
  let latestRequest: ContextModelRequest | undefined;
  let boundary: ReturnType<typeof attachContextRequestBoundary> | undefined;
  let boundSession: AgentSession | undefined;
  let api: ExtensionAPI | undefined;
  let latestContext: ExtensionContext | undefined;
  let epoch = 0;
  let candidateSeq = 0;
  // Waterline adaptation per model: measured growth while a preparation ran
  // shifts the next preparation earlier so it still finishes before capacity.
  const prepStats = new Map<string, { durationMs: number }>();
  let lastTokens = 0;
  let lastAt = 0;
  const now = options.now ?? (() => Date.now());

  const modelKey = (model: Model<Api> | undefined): string =>
    model === undefined ? "" : latestRequest
      ? contextRequestKey(model, latestRequest.context, latestRequest.options)
      : JSON.stringify({ provider: model.provider, id: model.id, api: model.api, contextWindow: model.contextWindow, maxTokens: model.maxTokens });

  // Growth rate measured between consecutive context events (tokens/ms).
  let tokenRatePerMs = 0;
  const effectiveWaterline = (usable: number, key: string): number => {
    const config = options.getPreparationConfig();
    const base = config.waterline > 0 && config.waterline < 1 ? config.waterline : DEFAULT_WATERLINE;
    const stats = prepStats.get(key);
    if (!stats || stats.durationMs <= 0 || tokenRatePerMs <= 0) return base;
    // Start the next preparation earlier by the growth expected while a
    // same-shape summary runs, so it is ready before capacity runs out.
    const expectedGrowth = (tokenRatePerMs * stats.durationMs) / usable;
    return Math.max(base / 2, base - expectedGrowth * 2);
  };

  const boundaryId = (entries: SessionEntry[]): string | null => {
    const index = lastCompactionIndex(entries);
    return index >= 0 ? (entries[index]!.id ?? null) : null;
  };

  const candidateValid = (
    cand: PreparedCandidate,
    ctx: ExtensionContext,
    branchEntries: SessionEntry[],
  ): boolean =>
    cand.epoch === epoch
    && cand.boundaryCompactionId === boundaryId(branchEntries)
    && cand.modelKey === modelKey(ctx.model)
    && branchEntries.some((entry) => entry.id === cand.firstKeptEntryId)
    && branchEntries.some((entry) => entry.id === cand.lastSummarizedEntryId);

  const discard = (reason: string): void => {
    epoch += 1;
    if (!candidate) return;
    if (candidate.status === "in-flight") candidate.abort.abort();
    candidate = undefined;
    void reason;
  };

  const prefixTokens = (ctx: ExtensionContext, pi: ExtensionAPI): number => {
    let chars = ctx.getSystemPrompt().length;
    try {
      const active = new Set(pi.getActiveTools());
      for (const tool of pi.getAllTools()) {
        if (active.has(tool.name)) {
          chars += tool.name.length + tool.description.length + JSON.stringify(tool.parameters).length;
        }
      }
    } catch {
      // Tool metadata unavailable — estimate from system prompt only.
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
  };

  const startPreparation = (
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    tokensNow: number,
    usable: number,
  ): void => {
    const model = ctx.model;
    if (!model) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const entries = ctx.sessionManager.getBranch();
    const reserve = options.getCompactionSettings().reserveTokens;
    const summaryOut = Math.min(Math.floor(0.8 * reserve), model.maxTokens > 0 ? model.maxTokens : reserve);
    const prefix = prefixTokens(ctx, pi);
    // keepRecent targets ~60% total after commit: prefix + summary out + kept raw.
    let keepRecent = options.getExplicitKeepRecentTokens?.()
      ?? Math.max(1, Math.floor(POST_COMPACTION_TARGET * usable) - prefix - summaryOut);
    const preparation = computeFixedPreparation(entries, keepRecent, tokensNow);
    if (!preparation) return;
    const releasable = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]
      .reduce((total, message) => total + estimateTokens(message), 0);
    // A prefix dominated by system/tools or one unsplittable latest result
    // cannot be improved by replacing a few words with a summary.
    if (releasable <= summaryOut) return;
    // The worker's own request must fit the model window; page the oldest
    // part of A out with an explicit boundary when it does not.
    const spec = fitSpecToWindow(
      buildCompactionTaskSpec(model, sessionId, preparation, summaryOut, latestRequest),
      preparation,
      model.contextWindow,
    );
    if (!spec) return;
    const cand: PreparedCandidate = {
      ...preparation,
      spec,
      abort: new AbortController(),
      done: Promise.resolve(),
      epoch,
      fixedAt: now(),
      id: `ctxprep-${++candidateSeq}`,
      modelKey: modelKey(model),
      status: "in-flight",
      tokensAtFix: tokensNow,
    };
    discard("replace invalid candidate");
    cand.epoch = epoch;
    candidate = cand;
    const sourceSignal = latestRequest?.options.signal;
    const cancel = () => {
      cand.abort.abort();
      if (candidate === cand) discard("request cancelled");
    };
    sourceSignal?.addEventListener("abort", cancel, { once: true });
    if (sourceSignal?.aborted) cancel();
    options.onStatus?.();
    cand.done = (async () => {
      try {
        // The spec was frozen with the candidate; rebuilding it here would
        // let a newer request shape drift into an already-fixed task.
        const result = await options.runCompactionTask(cand.spec, cand.abort.signal);
        cand.abort.signal.throwIfAborted();
        if (candidate !== cand || !candidateValid(cand, ctx, ctx.sessionManager.getBranch())) return;
        if (typeof result.summary !== "string" || result.summary.trim().length === 0) {
          throw new Error("Compaction returned no summary text");
        }
        cand.summary = result.summary;
        if (result.usage !== undefined) cand.usage = result.usage as unknown as Usage;
        cand.status = "ready";
        prepStats.set(cand.modelKey, {
          durationMs: Math.max(1, now() - cand.fixedAt),
        });
        options.onSuccess?.("prepare");
      } catch (error) {
        if (cand.abort.signal.aborted) return;
        cand.status = "failed";
        cand.error = error instanceof Error ? error.message : String(error);
        options.onFailure?.("prepare", cand.error);
      } finally {
        sourceSignal?.removeEventListener("abort", cancel);
        options.onStatus?.();
      }
    })();
  };

  const commitFromEvent = async (
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
    pi: ExtensionAPI,
  ): Promise<CompactionResult | undefined> => {
    // A committed or in-flight candidate for the same source is authoritative:
    // its fixed range was already summarized, and messages appended after
    // fixation stay raw behind firstKeptEntryId.
    if (event.signal.aborted) return undefined;
    if (event.customInstructions && candidate) discard("manual summary focus changed");
    const cand = candidate;
    if (cand && !event.customInstructions && candidateValid(cand, ctx, event.branchEntries)) {
      if (cand.status === "in-flight") {
        // Capacity is already needed — wait for this same in-flight call
        // rather than starting a second summarization.
        await new Promise<void>((resolve) => {
          const cancel = () => {
            cand.abort.abort();
            if (candidate === cand) discard("compaction cancelled");
            resolve();
          };
          event.signal.addEventListener("abort", cancel, { once: true });
          if (event.signal.aborted) cancel();
          void cand.done.finally(() => {
            event.signal.removeEventListener("abort", cancel);
            resolve();
          });
        });
      }
      if (event.signal.aborted) return undefined;
      if (cand.status === "ready" && candidateValid(cand, ctx, ctx.sessionManager.getBranch())) {
        options.onSuccess?.("commit");
        return {
          firstKeptEntryId: cand.firstKeptEntryId,
          summary: cand.summary!,
          tokensBefore: event.preparation.tokensBefore,
          ...(cand.usage === undefined ? {} : { usage: cand.usage }),
        };
      }
      options.onFailure?.("commit", cand.error ?? "The prepared source was cancelled or changed");
      return undefined;
    }
    // No usable candidate (not prepared, stale source, or manual focus):
    // run the same worker task synchronously from Pi's own preparation.
    // This is the blocking path the design allows; manual and automatic
    // compaction share the single worker mechanism.
    const model = ctx.model;
    if (!model) return undefined;
    const keptIndex = event.branchEntries.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
    const fixedLeaf = event.branchEntries[event.branchEntries.length - 1];
    if (keptIndex < 0 || !fixedLeaf?.id) {
      options.onFailure?.("commit", "The compaction boundary is not on the active branch");
      return undefined;
    }
    const keptMessages: AgentMessage[] = [];
    for (let i = keptIndex; i < event.branchEntries.length; i++) {
      const entry = event.branchEntries[i]!;
      if (entry.type !== "compaction") keptMessages.push(...sessionEntryToContextMessages(entry));
    }
    let firstSummarizedEntryId: string | null = null;
    for (let i = 0; i < keptIndex; i++) {
      if (entryMessage(event.branchEntries[i]!) !== undefined) {
        firstSummarizedEntryId = event.branchEntries[i]!.id ?? null;
        break;
      }
    }
    // The split-turn prefix is part of the range but never elided; spans
    // attribute only the summarized body so paging keeps an entry boundary.
    const { spans, aligned } = summarizedEntrySpans(
      event.branchEntries,
      keptIndex,
      event.preparation.turnPrefixMessages.length,
    );
    const preparation: FixedPreparation = {
      boundaryCompactionId: boundaryId(event.branchEntries),
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      firstSummarizedEntryId,
      fixedLeafEntryId: fixedLeaf.id,
      isSplitTurn: event.preparation.isSplitTurn,
      lastSummarizedEntryId: event.branchEntries[keptIndex - 1]?.id ?? "",
      keptMessages,
      summarizedEntries: aligned ? spans : [],
      messagesToSummarize: event.preparation.messagesToSummarize,
      previousSummary: event.preparation.previousSummary,
      tokensBefore: event.preparation.tokensBefore,
      turnPrefixMessages: event.preparation.turnPrefixMessages,
    };
    try {
      const reserve = options.getCompactionSettings().reserveTokens;
      const summaryOut = Math.min(Math.floor(0.8 * reserve), model.maxTokens > 0 ? model.maxTokens : reserve);
      const sessionId = ctx.sessionManager.getSessionId();
      const fitted = fitSpecToWindow(
        buildCompactionTaskSpec(model, sessionId, preparation, summaryOut, latestRequest, event.customInstructions),
        preparation,
        model.contextWindow,
      );
      if (!fitted) {
        throw new ContextCapacityError("The summary request itself exceeds the model capacity; original history was retained");
      }
      const spec = fitted;
      const sourceEpoch = epoch;
      const sourceIds = event.branchEntries.slice(0, keptIndex).map((entry) => entry.id);
      const result = await options.runCompactionTask(spec, event.signal);
      event.signal.throwIfAborted();
      if (typeof result.summary !== "string" || result.summary.trim().length === 0) {
        throw new Error("Compaction returned no summary text");
      }
      const live = ctx.sessionManager.getBranch();
      if (sourceEpoch !== epoch || !sourceIds.every((id, index) => live[index]?.id === id)) {
        throw new ContextCapacityError("The summary source changed while preparation was running");
      }
      options.onSuccess?.("commit");
      return {
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        summary: result.summary,
        tokensBefore: event.preparation.tokensBefore,
        ...(result.usage === undefined ? {} : { usage: result.usage as unknown as Usage }),
      };
    } catch (error) {
      options.onFailure?.("commit", error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };

  const factory: ExtensionFactory = (pi) => {
    api = pi;
    pi.on("context", (_event, ctx) => {
      latestContext = ctx;
      if (!options.getPreparationConfig().enabled || !options.getCompactionSettings().enabled) {
        discard("preparation disabled");
      }
    });

    pi.on("session_before_compact", async (event, ctx) => {
      // Pi's post-agent-end check is not request admission. The bound adapter
      // owns automatic commits; cancelled idle checks must never spend a model call.
      // Manual compaction remains a native Pi extension seam so a project
      // extension can provide its own summary or Pi can run its normal fallback.
      if (boundary) return event.reason === "manual" ? undefined : { cancel: true };
      try {
        const compaction = await commitFromEvent(event, ctx, pi);
        return compaction === undefined ? { cancel: true } : { compaction };
      } catch (error) {
        options.onFailure?.("commit", error instanceof Error ? error.message : String(error));
        return { cancel: true };
      }
    });

    pi.on("session_compact", async (_event, ctx) => {
      discard("compacted");
      lastTokens = 0;
      lastAt = 0;
      tokenRatePerMs = 0;
      const retained = retainedContextState(ctx.sessionManager.getBranch());
      await options.onRetention?.({
        retainedObservationRefs: retained.observationRefs,
        retainedGit: retained.retainedGit,
      });
    });

    pi.on("session_compact_failed", (event) => {
      if (boundary && event.reason !== "manual") return;
      if (candidate?.status === "ready") discard("commit failed");
    });

    pi.on("session_tree", async (_event, ctx) => {
      discard("branch navigation");
      const retained = retainedContextState(ctx.sessionManager.getBranch());
      await options.onRetention?.({ retainedObservationRefs: retained.observationRefs, retainedGit: retained.retainedGit });
    });
    pi.on("model_select", () => discard("model changed"));
    pi.on("session_before_switch", () => discard("session switch"));
    pi.on("session_before_fork", () => discard("session fork"));
    pi.on("session_shutdown", () => { discard("shutdown"); boundary?.dispose(); });
  };

  const extension = factory as ContextPreparationExtension;
  extension.isBound = () => boundary !== undefined;
  extension.isCommitting = () => boundary?.isCommitting() ?? false;
  extension.observeRequest = (request) => {
    latestRequest = request;
    const at = now();
    if (lastAt > 0 && request.inputTokens > lastTokens && at > lastAt) {
      const rate = (request.inputTokens - lastTokens) / (at - lastAt);
      tokenRatePerMs = tokenRatePerMs === 0 ? rate : tokenRatePerMs * 0.7 + rate * 0.3;
    }
    lastTokens = request.inputTokens;
    lastAt = at;
    const ctx = boundSession?.extensionRunner?.createContext() ?? latestContext;
    if (!ctx || !api) return;
    const config = options.getPreparationConfig();
    if (!config.enabled || !options.getCompactionSettings().enabled) { discard("preparation disabled"); return; }
    const usable = request.model.contextWindow - request.reserveTokens;
    if (candidate && !candidateValid(candidate, ctx, ctx.sessionManager.getBranch())) discard("request configuration or source changed");
    if (request.needsSpace || usable <= 0) return;
    if (request.inputTokens < effectiveWaterline(usable, modelKey(request.model)) * usable) return;
    if (candidate && candidate.status !== "failed") return;
    startPreparation(ctx, api, request.inputTokens, usable);
  };
  extension.attach = (session, onEvent) => {
    boundary?.dispose();
    boundSession = session;
    boundary = attachContextRequestBoundary(session, {
      getCompactionSettings: options.getCompactionSettings,
      observe: extension.observeRequest,
      ...(options.inject ? { inject: options.inject } : {}),
      onEvent,
      onStatus: () => options.onStatus?.(),
      compact: async (request, signal) => {
        latestRequest = request;
        const ctx = session.extensionRunner?.createContext() ?? latestContext;
        if (!ctx || !api) throw new ContextCapacityError("The Pi context extension is unavailable");
        const entries = ctx.sessionManager.getBranch();
        if (!candidate || !candidateValid(candidate, ctx, entries) || candidate.status === "failed") {
          startPreparation(ctx, api, request.inputTokens, request.model.contextWindow - request.reserveTokens);
        }
        const fixed = candidate;
        if (!fixed || !candidateValid(fixed, ctx, entries)) {
          throw new ContextCapacityError("No complete source prefix fits a summary request. Page the oversized material or adjust model capacity; original history was retained.");
        }
        const result = await commitFromEvent({
          type: "session_before_compact", reason: "threshold", willRetry: false, signal, branchEntries: entries,
          preparation: { firstKeptEntryId: fixed.firstKeptEntryId, messagesToSummarize: fixed.messagesToSummarize,
            turnPrefixMessages: fixed.turnPrefixMessages, isSplitTurn: fixed.isSplitTurn,
            ...(fixed.previousSummary === undefined ? {} : { previousSummary: fixed.previousSummary }),
            tokensBefore: request.inputTokens, settings: options.getCompactionSettings(),
            fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() } },
        }, ctx, api);
        if (!result) throw new ContextCapacityError("Context preparation failed or was cancelled; original history was retained");
        return result;
      },
    });
  };
  extension.status = (): ContextPreparationStatus => ({
    candidate: candidate === undefined
      ? "none"
      : candidate.status === "ready"
        ? "ready"
        : candidate.status === "in-flight"
          ? "preparing"
          : "none",
    enabled: options.getPreparationConfig().enabled,
  });

  return extension;
}
