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
import type { Api, AssistantMessage, Context, Message, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import { retainedContextState } from "./retained-context.js";

import {
  attachContextRequestBoundary, ContextCapacityError, contextRequestKey, estimateModelInputTokens,
  type ContextModelRequest,
} from "./context-request-boundary.js";

/**
 * Context preparation extension — fixed-candidate background compaction.
 *
 * Design: agent-harness.md §8.4–8.6
 * Plan: agent-harness-plan.md §2.4A/B, §2.6A
 * Decisions: D-284, D-286
 *
 * Budget is measured on the `context` hook, which Pi runs before every
 * provider request — including tool-loop continuations inside one turn.
 * When usage crosses the soft waterline, a fixed candidate is prepared in
 * the background (P + S0 + A + B fixed at preparation time). The foreground
 * agent keeps running; normal appends do not invalidate the candidate.
 *
 * When Pi actually needs compaction (threshold or overflow), the
 * `session_before_compact` hook commits the matching candidate, waits for
 * an in-flight one, or generates a fresh summary from Pi's own preparation
 * using the same derived request shape. Failure defers to Pi's default
 * summarization; history is never truncated.
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
  isSplitTurn: boolean;
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
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
  abort: AbortController;
  done: Promise<void>;
  summary?: string;
  usage?: Usage;
  error?: string;
}

export interface ContextPreparationOptions {
  /**
   * Bound to services.modelRuntime.completeSimple — the same runtime the
   * session's main requests use. No separate model slot or credentials.
   */
  completeSimple: (
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions,
  ) => Promise<AssistantMessage>;
  /** Live harness background-preparation setting. */
  getPreparationConfig: () => ContextPreparationConfig;
  /** Live Pi compaction settings (enabled, reserveTokens, keepRecentTokens). */
  getCompactionSettings: () => { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  /** Undefined means Pi's default, so the total-input planning target applies. */
  getExplicitKeepRecentTokens?: () => number | undefined;
  /** Publish native raw retention after an actual compaction or branch navigation. */
  onRetention?: (params: import("@piarium/protocol").ContextRetentionParams) => void | Promise<void>;
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
  const messagesToSummarize: AgentMessage[] = [];
  for (let i = boundaryStart; i < historyEnd; i++) {
    if (entries[i]!.type !== "compaction") messagesToSummarize.push(...sessionEntryToContextMessages(entries[i]!));
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
  return {
    boundaryCompactionId,
    firstSummarizedEntryId,
    firstKeptEntryId: firstKept.id,
    isSplitTurn: cut.isSplitTurn,
    lastSummarizedEntryId,
    messagesToSummarize,
    previousSummary,
    tokensBefore: tokensBefore ?? estimateModelInputTokens({ messages: convertToLlm(buildSessionContext(entries).messages) }),
    turnPrefixMessages,
  };
}

// ---------------------------------------------------------------------------
// Summary request — derived from the active request shape: same system prompt,
// same tool prefix (schema-only, no executor), message structure preserved via
// convertToLlm, plus a fixed-scope instruction as the trailing user message.
// ---------------------------------------------------------------------------

const SUMMARY_INSTRUCTION = `The messages above are the earlier portion of this working session, selected for compaction. The most recent messages are kept verbatim after this summary and are not included here.

Write a continuation summary that lets the work proceed without re-reading the original text. Cover, in this order:
- The user's goal and every requirement or correction that is still in force
- Decisions made, their reasons, and rejected alternatives
- Concrete identifiers: file paths, symbols, commands, error messages, numbers
- Completed work versus open work; unresolved questions and pending actions
- Where to recover detail (files, tools, earlier entries)

Reply with the summary text only. Do not call tools — this request has no tool executor.`;

const UPDATE_INSTRUCTION = `The messages above are new session material since the previous summary, which is shown first. Update it: preserve every still-valid item, refresh progress, and keep concrete identifiers (paths, symbols, errors, numbers).

Reply with the updated summary text only. Do not call tools — this request has no tool executor.`;

const SPLIT_TURN_NOTE = `\n\nThe tail of the material is the beginning of an in-progress turn; its remainder stays verbatim in context.`;

function previousSummaryMessage(summary: string): AgentMessage {
  return {
    role: "compactionSummary",
    summary,
    timestamp: Date.now(),
    tokensBefore: 0,
  } as unknown as AgentMessage;
}

function buildSummaryContext(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  preparation: FixedPreparation,
  customInstructions?: string,
  request?: ContextModelRequest,
): Context {
  // Iterate active tool names so the serialized prefix order matches the
  // request the agent loop sends.
  const allTools = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  const tools = pi.getActiveTools()
    .map((name) => allTools.get(name))
    .filter((tool): tool is NonNullable<typeof tool> => tool !== undefined)
    .map((tool) => ({
      description: tool.description,
      name: tool.name,
      parameters: tool.parameters,
    }));
  const messages: AgentMessage[] = [
    ...(preparation.previousSummary === undefined
      ? []
      : [previousSummaryMessage(preparation.previousSummary)]),
    ...preparation.messagesToSummarize,
    ...preparation.turnPrefixMessages,
  ];
  const instruction =
    (preparation.previousSummary === undefined ? SUMMARY_INSTRUCTION : UPDATE_INSTRUCTION)
    + (preparation.isSplitTurn ? SPLIT_TURN_NOTE : "")
    + (customInstructions === undefined ? "" : `\n\nAdditional focus: ${customInstructions}`);
  if (request) {
    const entries = ctx.sessionManager.getBranch();
    const first = entries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
    const kept = entries.slice(first).flatMap((entry) => entry.type === "compaction" ? [] : sessionEntryToContextMessages(entry));
    const anchor = convertToLlm(kept)[0];
    if (first < 0 || !anchor) throw new ContextCapacityError("The fixed context boundary has no retained message");
    const matches = request.context.messages.flatMap((message, index) => (
      message.role === anchor.role && message.timestamp === anchor.timestamp ? [index] : []
    ));
    const exact = matches.filter((index) => JSON.stringify(request.context.messages[index]) === JSON.stringify(anchor));
    const boundary = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : undefined;
    if (boundary === undefined || boundary <= 0) {
      throw new ContextCapacityError("A context transform obscured the fixed summary boundary; history was not changed");
    }
    return {
      ...request.context,
      ...(request.context.tools ? { tools: request.context.tools.map(({ name, description, parameters }) => ({ name, description, parameters })) } : {}),
      messages: [
        ...request.context.messages.slice(0, boundary),
        { role: "user", content: [{ type: "text", text: instruction }], timestamp: Date.now() },
      ],
    };
  }
  return {
    messages: [
      ...convertToLlm(messages),
      {
        content: [{ text: instruction, type: "text" }],
        role: "user",
        timestamp: Date.now(),
      } as Message,
    ],
    systemPrompt: ctx.getSystemPrompt(),
    ...(tools.length === 0 ? {} : { tools }),
  };
}

function summaryText(response: AssistantMessage): string {
  if (response.stopReason === "aborted" || response.stopReason === "length") {
    throw new Error(`Summarization did not complete: ${response.stopReason}`);
  }
  if (response.stopReason === "error") {
    throw new Error(`Summarization failed: ${response.errorMessage || "unknown error"}`);
  }
  if (response.content.some((block) => block.type === "toolCall")) {
    throw new Error("Summarization attempted to call a tool");
  }
  const text = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Summarization returned no text");
  return text;
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
  const complete = (model: Model<Api>, context: Context, modelOptions: SimpleStreamOptions) =>
    boundary ? boundary.completeSummary(model, context, modelOptions) : options.completeSimple(model, context, modelOptions);
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
    const entries = ctx.sessionManager.getBranch();
    const reserve = options.getCompactionSettings().reserveTokens;
    const summaryOut = Math.min(Math.floor(0.8 * reserve), model.maxTokens > 0 ? model.maxTokens : reserve);
    const prefix = prefixTokens(ctx, pi);
    // keepRecent targets ~60% total after commit: prefix + summary out + kept raw.
    let keepRecent = options.getExplicitKeepRecentTokens?.()
      ?? Math.max(1, Math.floor(POST_COMPACTION_TARGET * usable) - prefix - summaryOut);
    let preparation = computeFixedPreparation(entries, keepRecent, tokensNow);
    if (!preparation) return;
    // Move to an earlier legal cut when the summary's own request would overflow.
    // Each iteration strictly advances toward the old boundary; no magic retry count.
    while (preparation) {
      let summaryContext: Context;
      try { summaryContext = buildSummaryContext(ctx, pi, preparation, undefined, latestRequest); }
      catch (error) {
        options.onFailure?.("prepare", error instanceof Error ? error.message : String(error));
        return;
      }
      const excess = estimateModelInputTokens(summaryContext) + summaryOut - model.contextWindow;
      if (excess <= 0) break;
      const cutIndex = entries.findIndex((entry) => entry.id === preparation!.firstKeptEntryId);
      const keptTokens = entries.slice(cutIndex).flatMap(sessionEntryToContextMessages)
        .reduce((total, message) => total + estimateTokens(message), 0);
      keepRecent = Math.max(keepRecent + excess, keptTokens + 1);
      const next = computeFixedPreparation(entries, keepRecent, tokensNow);
      if (!next || entries.findIndex((entry) => entry.id === next.firstKeptEntryId) >= cutIndex) return;
      preparation = next;
    }
    if (!preparation) return;
    const releasable = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]
      .reduce((total, message) => total + estimateTokens(message), 0);
    // A prefix dominated by system/tools or one unsplittable latest result
    // cannot be improved by replacing a few words with a summary.
    if (releasable <= summaryOut) return;
    const cand: PreparedCandidate = {
      ...preparation,
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
        const context = buildSummaryContext(ctx, pi, cand, undefined, latestRequest);
        const response = await complete(model, context, {
          ...latestRequest?.options,
          maxTokens: summaryOut,
          sessionId: ctx.sessionManager.getSessionId(),
          signal: cand.abort.signal,
        });
        cand.abort.signal.throwIfAborted();
        if (candidate !== cand || !candidateValid(cand, ctx, ctx.sessionManager.getBranch())) return;
        cand.summary = summaryText(response);
        cand.usage = response.usage;
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
    // generate synchronously from Pi's own preparation using the same
    // derived request shape. This is the blocking path the design allows.
    const model = ctx.model;
    if (!model) return undefined;
    const preparation: FixedPreparation = {
      boundaryCompactionId: boundaryId(event.branchEntries),
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      firstSummarizedEntryId: null,
      isSplitTurn: event.preparation.isSplitTurn,
      lastSummarizedEntryId: "",
      messagesToSummarize: event.preparation.messagesToSummarize,
      previousSummary: event.preparation.previousSummary,
      tokensBefore: event.preparation.tokensBefore,
      turnPrefixMessages: event.preparation.turnPrefixMessages,
    };
    try {
      const reserve = options.getCompactionSettings().reserveTokens;
      const context = buildSummaryContext(ctx, pi, preparation, event.customInstructions, latestRequest);
      const summaryOutput = Math.min(Math.floor(0.8 * reserve), model.maxTokens > 0 ? model.maxTokens : reserve);
      if (estimateModelInputTokens(context) + summaryOutput > model.contextWindow) {
        throw new ContextCapacityError("The summary request itself exceeds the model capacity; original history was retained");
      }
      const sourceEpoch = epoch;
      const sourceIds = event.branchEntries.slice(0, event.branchEntries.findIndex((entry) => entry.id === preparation.firstKeptEntryId)).map((entry) => entry.id);
      const response = await complete(model, context, {
        ...latestRequest?.options,
        maxTokens: Math.min(Math.floor(0.8 * reserve), model.maxTokens > 0 ? model.maxTokens : reserve),
        sessionId: ctx.sessionManager.getSessionId(),
        signal: event.signal,
      });
      event.signal.throwIfAborted();
      const live = ctx.sessionManager.getBranch();
      if (sourceEpoch !== epoch || !sourceIds.every((id, index) => live[index]?.id === id)) {
        throw new ContextCapacityError("The summary source changed while preparation was running");
      }
      const summary = summaryText(response);
      options.onSuccess?.("commit");
      return {
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        summary,
        tokensBefore: event.preparation.tokensBefore,
        usage: response.usage,
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
      if (boundary && event.reason !== "manual") return { cancel: true };
      try {
        if (boundary) latestRequest = await boundary.currentRequest(event.signal);
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
