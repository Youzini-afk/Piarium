import {
  buildSessionContext,
  calculateContextTokens,
  convertToLlm,
  estimateTokens,
  findCutPoint,
  sessionEntryToContextMessages,
  type CompactionResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Context, Message, Model, Usage } from "@earendil-works/pi-ai";

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
    options: { signal?: AbortSignal; maxTokens?: number; toolChoice?: "none"; sessionId?: string },
  ) => Promise<AssistantMessage>;
  /** Live harness background-preparation setting. */
  getPreparationConfig: () => ContextPreparationConfig;
  /** Live Pi compaction settings (enabled, reserveTokens, keepRecentTokens). */
  getCompactionSettings: () => { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  /** Called after a committed compaction so host observers can rebuild. */
  onCompaction?: (params: { firstKeptEntryId: string; summary: string; tokensBefore: number }) => void;
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
// Token estimation — mirrors the SDK-internal estimateContextTokens, which is
// not exported from pi-coding-agent. Uses the last valid assistant usage plus
// estimated trailing messages, matching the vendored implementation.
// ---------------------------------------------------------------------------

function assistantUsage(message: AgentMessage): Usage | undefined {
  if (message.role !== "assistant" || !("usage" in message)) return undefined;
  const usage = (message as { usage?: Usage }).usage;
  const stopReason = (message as { stopReason?: string }).stopReason;
  if (stopReason === "aborted" || stopReason === "error" || !usage) return undefined;
  return calculateContextTokens(usage) > 0 ? usage : undefined;
}

export function estimateRequestTokens(messages: AgentMessage[]): {
  tokens: number;
  trailingTokens: number;
  usageTokens: number;
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = assistantUsage(messages[i]!);
    if (!usage) continue;
    const usageTokens = calculateContextTokens(usage);
    let trailingTokens = 0;
    for (let j = i + 1; j < messages.length; j++) {
      trailingTokens += estimateTokens(messages[j]!);
    }
    return { tokens: usageTokens + trailingTokens, trailingTokens, usageTokens };
  }
  let tokens = 0;
  for (const message of messages) tokens += estimateTokens(message);
  return { tokens, trailingTokens: tokens, usageTokens: 0 };
}

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
  const cut = findCutPoint(entries, boundaryStart, entries.length, keepRecentTokens);
  const firstKept = entries[cut.firstKeptEntryIndex];
  if (!firstKept?.id) return undefined;
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
  const messagesToSummarize: AgentMessage[] = [];
  for (let i = boundaryStart; i < historyEnd; i++) {
    const message = entryMessage(entries[i]!);
    if (message) messagesToSummarize.push(message);
  }
  const turnPrefixMessages: AgentMessage[] = [];
  if (cut.isSplitTurn) {
    for (let i = cut.turnStartIndex; i < cut.firstKeptEntryIndex; i++) {
      const message = entryMessage(entries[i]!);
      if (message) turnPrefixMessages.push(message);
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
    tokensBefore: tokensBefore ?? estimateRequestTokens(buildSessionContext(entries).messages).tokens,
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
};

export function createContextPreparationExtension(
  options: ContextPreparationOptions,
): ContextPreparationExtension {
  let candidate: PreparedCandidate | undefined;
  let epoch = 0;
  let candidateSeq = 0;
  // Waterline adaptation per model: measured growth while a preparation ran
  // shifts the next preparation earlier so it still finishes before capacity.
  const prepStats = new Map<string, { durationMs: number; grewTokens: number }>();
  let lastTokens = 0;
  let lastAt = 0;
  const now = options.now ?? (() => Date.now());

  const modelKey = (model: Model<Api> | undefined): string =>
    model === undefined ? "" : `${model.provider}/${model.id}`;

  const usableWindow = (ctx: ExtensionContext): number | undefined => {
    const window = ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow;
    if (!window) return undefined;
    return window - options.getCompactionSettings().reserveTokens;
  };

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
    return Math.max(0.4, base - Math.min(0.2, expectedGrowth * 2));
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
    let keepRecent = Math.max(1_000, Math.floor(POST_COMPACTION_TARGET * usable) - prefix - summaryOut);
    let preparation = computeFixedPreparation(entries, keepRecent);
    if (!preparation) return;
    // The summary request itself must fit: prefix + material + instruction + out.
    const instructionTokens = Math.ceil(SUMMARY_INSTRUCTION.length / CHARS_PER_TOKEN) + 64;
    const materialTokens = (list: AgentMessage[]): number =>
      list.reduce((sum, message) => sum + estimateTokens(message), 0);
    let material = materialTokens(preparation.messagesToSummarize) + materialTokens(preparation.turnPrefixMessages);
    for (let attempt = 0; attempt < 4 && prefix + material + instructionTokens + summaryOut > usable; attempt++) {
      keepRecent += prefix + material + instructionTokens + summaryOut - usable;
      const next = computeFixedPreparation(entries, keepRecent);
      if (!next) { preparation = undefined; break; }
      preparation = next;
      material = materialTokens(preparation.messagesToSummarize) + materialTokens(preparation.turnPrefixMessages);
    }
    if (!preparation) return;
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
    candidate = cand;
    options.onStatus?.();
    cand.done = (async () => {
      try {
        const context = buildSummaryContext(ctx, pi, cand);
        const response = await options.completeSimple(model, context, {
          maxTokens: summaryOut,
          sessionId: ctx.sessionManager.getSessionId(),
          signal: cand.abort.signal,
          toolChoice: "none",
        });
        cand.summary = summaryText(response);
        cand.usage = response.usage;
        cand.status = "ready";
        prepStats.set(cand.modelKey, {
          durationMs: Math.max(1, now() - cand.fixedAt),
          grewTokens: 0,
        });
        options.onSuccess?.("prepare");
      } catch (error) {
        if (cand.abort.signal.aborted) return;
        cand.status = "failed";
        cand.error = error instanceof Error ? error.message : String(error);
        options.onFailure?.("prepare", cand.error);
      } finally {
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
    const cand = candidate;
    if (cand && !event.customInstructions && candidateValid(cand, ctx, event.branchEntries)) {
      if (cand.status === "in-flight") {
        // Capacity is already needed — wait for this same in-flight call
        // rather than starting a second summarization.
        await Promise.race([
          cand.done,
          new Promise<void>((resolve) => {
            event.signal.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);
      }
      if (event.signal.aborted) return undefined;
      if (cand.status === "ready" && candidateValid(cand, ctx, event.branchEntries)) {
        options.onSuccess?.("commit");
        return {
          firstKeptEntryId: cand.firstKeptEntryId,
          summary: cand.summary!,
          tokensBefore: event.preparation.tokensBefore,
          ...(cand.usage === undefined ? {} : { usage: cand.usage }),
        };
      }
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
      const response = await options.completeSimple(model, buildSummaryContext(ctx, pi, preparation, event.customInstructions), {
        maxTokens: Math.min(Math.floor(0.8 * reserve), model.maxTokens > 0 ? model.maxTokens : reserve),
        sessionId: ctx.sessionManager.getSessionId(),
        signal: event.signal,
        toolChoice: "none",
      });
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
    pi.on("context", (event, ctx) => {
      const usage = ctx.getContextUsage();
      const estimated = estimateRequestTokens(event.messages).tokens;
      const tokens = usage?.tokens ?? estimated;
      const usable = usableWindow(ctx);
      if (usable === undefined) return undefined;
      const compaction = options.getCompactionSettings();
      const config = options.getPreparationConfig();
      const at = now();
      if (lastAt > 0 && tokens > lastTokens && at > lastAt) {
        const rate = (tokens - lastTokens) / (at - lastAt);
        tokenRatePerMs = tokenRatePerMs === 0 ? rate : tokenRatePerMs * 0.7 + rate * 0.3;
      }
      lastTokens = tokens;
      lastAt = at;
      if (!config.enabled || !compaction.enabled) return undefined;
      if (tokens < effectiveWaterline(usable, modelKey(ctx.model)) * usable) return undefined;
      if (candidate && (candidate.status !== "failed") && candidateValid(candidate, ctx, ctx.sessionManager.getBranch())) {
        return undefined;
      }
      if (candidate?.status === "failed") discard("retry after failed preparation");
      startPreparation(ctx, pi, tokens, usable);
      return undefined;
    });

    pi.on("session_before_compact", async (event, ctx) => {
      const compaction = await commitFromEvent(event, ctx, pi);
      return compaction === undefined ? undefined : { compaction };
    });

    pi.on("session_compact", (event) => {
      discard("compacted");
      const entry = event.compactionEntry;
      options.onCompaction?.({
        firstKeptEntryId: entry?.firstKeptEntryId ?? "",
        summary: entry?.summary ?? "",
        tokensBefore: entry?.tokensBefore ?? 0,
      });
    });

    pi.on("session_compact_failed", () => {
      if (candidate?.status === "ready") discard("commit failed");
    });

    pi.on("session_tree", () => discard("branch navigation"));
    pi.on("model_select", () => discard("model changed"));
    pi.on("session_before_switch", () => discard("session switch"));
    pi.on("session_before_fork", () => discard("session fork"));
    pi.on("session_shutdown", () => discard("shutdown"));
  };

  const extension = factory as ContextPreparationExtension;
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
