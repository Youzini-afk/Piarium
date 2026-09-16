import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createContextPreparationExtension,
} from "../../src/harness/context-preparation.js";
import { convertToLlm, type SessionEntry, type SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { RequestBudgetObservation } from "../../src/harness/context-request-boundary.js";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MODEL = { provider: "faux", id: "faux-1", contextWindow: 2_000, maxTokens: 400 };

const usage = (total: number): Usage => ({
  input: total,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: total,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const pad = (text: string, size: number): string => text + " " + "detail ".repeat(Math.ceil(size / 7)).slice(0, size);

const userMessage = (text: string): AgentMessage => ({
  role: "user",
  content: text,
  timestamp: Date.now(),
} as AgentMessage);

const assistantMessage = (text: string, tokens: number): AgentMessage => ({
  role: "assistant",
  api: "faux",
  provider: "faux",
  model: "faux-1",
  content: [{ type: "text", text }],
  usage: usage(tokens),
  stopReason: "stop",
  timestamp: Date.now(),
} as unknown as AgentMessage);

const toolResultMessage = (text: string): AgentMessage => ({
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "bash",
  content: [{ type: "text", text }],
  timestamp: Date.now(),
} as unknown as AgentMessage);

const entry = (id: string, parentId: string | null, message: AgentMessage): SessionMessageEntry => ({
  type: "message",
  id,
  parentId,
  timestamp: new Date().toISOString(),
  message,
});

/**
 * A branch long enough for findCutPoint to split: each entry carries ~1_000
 * characters (~250 estimated tokens) so the keepRecent budget leaves real
 * material in the summarize range. The last assistant message reports
 * `tailTokens` usage, which drives the request-budget check.
 */
const branchEntries = (tailTokens: number): SessionEntry[] => [
  entry("e1", null, userMessage(pad("First task: inspect the repository layout and report back.", 1_000))),
  entry("e2", "e1", assistantMessage(pad("I will list the directories first.", 1_000), 120)),
  entry("e3", "e2", toolResultMessage(pad("packages/ docs/ kernel/", 1_000))),
  entry("e4", "e3", assistantMessage(pad("Now reading the architecture doc.", 1_000), 180)),
  entry("e5", "e4", userMessage(pad("Also check the harness plan.", 1_000))),
  entry("e6", "e5", assistantMessage(pad("Reading it now.", 1_000), tailTokens)),
];

interface RecordedCall {
  context: { systemPrompt?: string; messages: AgentMessage[]; tools?: unknown[] };
  options: { maxTokens?: number; toolChoice?: string; sessionId?: string; signal?: AbortSignal };
  resolve: (message: AssistantMessage) => void;
  reject: (error: unknown) => void;
}

const okResponse = (text: string): AssistantMessage => ({
  role: "assistant",
  api: "faux",
  provider: "faux",
  model: "faux-1",
  content: [{ type: "text", text }],
  usage: usage(42),
  stopReason: "stop",
  timestamp: Date.now(),
} as unknown as AssistantMessage);

const toolCallResponse = (): AssistantMessage => ({
  role: "assistant",
  api: "faux",
  provider: "faux",
  model: "faux-1",
  content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
  usage: usage(10),
  stopReason: "toolUse",
  timestamp: Date.now(),
} as unknown as AssistantMessage);

interface Harness {
  handlers: Map<string, (event: never, ctx: never) => unknown>;
  calls: RecordedCall[];
  failures: [string, string][];
  successes: string[];
  compactions: import("@piarium/protocol").ContextRetentionParams[];
  config: { enabled: boolean; waterline: number };
  entries: SessionEntry[];
  extension: ReturnType<typeof createContextPreparationExtension>;
  ctx: {
    model: typeof MODEL;
    getContextUsage: () => { tokens: number; contextWindow: number };
    getSystemPrompt: () => string;
    sessionManager: { getBranch: () => SessionEntry[]; getSessionId: () => string };
  };
}

const createHarness = (entries: SessionEntry[], tokensNow: number): Harness => {
  const handlers = new Map<string, (event: never, ctx: never) => unknown>();
  const calls: RecordedCall[] = [];
  const harness: Harness = {
    handlers,
    calls,
    failures: [],
    successes: [],
    compactions: [],
    config: { enabled: true, waterline: 0.75 },
    entries,
    ctx: {
      model: MODEL,
      getContextUsage: () => ({ tokens: tokensNow, contextWindow: 2_000 }),
      getSystemPrompt: () => "You are a coding agent.",
      sessionManager: {
        getBranch: () => harness.entries,
        getSessionId: () => "session-1",
      },
    },
    extension: undefined as never,
  };
  harness.extension = createContextPreparationExtension({
    completeSimple: (_model, context, options) => new Promise<AssistantMessage>((resolve, reject) => {
      calls.push({ context, options, resolve, reject });
    }),
    getPreparationConfig: () => harness.config,
    getCompactionSettings: () => ({ enabled: true, reserveTokens: 400, keepRecentTokens: 300 }),
    getExplicitKeepRecentTokens: () => 300,
    onRetention: (params) => { harness.compactions.push(params); },
    onFailure: (phase, message) => harness.failures.push([phase, message]),
    onSuccess: (phase) => harness.successes.push(phase),
  });
  harness.extension({
    on: (event: string, handler: (event: never, ctx: never) => unknown) => handlers.set(event, handler),
    getAllTools: () => [
      { name: "bash", description: "run a command", parameters: { type: "object" } },
      { name: "read", description: "read a file", parameters: { type: "object" } },
    ],
    getActiveTools: () => ["bash", "read"],
  } as never);
  return harness;
};

const fireContext = (harness: Harness, tokens: number, messages?: AgentMessage[]): void => {
  harness.ctx.getContextUsage = () => ({ tokens, contextWindow: 2_000 });
  const handler = harness.handlers.get("context")!;
  handler({
    type: "context",
    messages: messages ?? harness.entries.flatMap((e) => e.type === "message" ? [e.message] : []),
  } as never, harness.ctx as never);
  harness.extension.observeRequest({
    model: harness.ctx.model as never,
    context: { systemPrompt: harness.ctx.getSystemPrompt(),
      tools: ["bash", "read"].map((name) => ({ name, description: name === "bash" ? "run a command" : "read a file", parameters: { type: "object" } as never })),
      messages: convertToLlm(messages ?? harness.entries.flatMap((e) => e.type === "message" ? [e.message] : [])),
    },
    options: { sessionId: "session-1" }, inputTokens: tokens, reserveTokens: 400, needsSpace: false,
  });
};

const compactEvent = (
  harness: Harness,
  overrides?: { customInstructions?: string; signal?: AbortSignal },
): { type: string; preparation: unknown; branchEntries: SessionEntry[]; reason: string; willRetry: boolean; signal: AbortSignal; customInstructions?: string } => ({
  type: "session_before_compact",
  preparation: {
    firstKeptEntryId: harness.entries[harness.entries.length - 2]!.id,
    messagesToSummarize: harness.entries.slice(0, -2).flatMap((e) => e.type === "message" ? [e.message] : []),
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 900,
  },
  branchEntries: harness.entries,
  reason: "threshold",
  willRetry: false,
  signal: overrides?.signal ?? new AbortController().signal,
  ...(overrides?.customInstructions === undefined ? {} : { customInstructions: overrides.customInstructions }),
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("context preparation extension", () => {
  it("starts a fixed background candidate over the waterline while the foreground turn keeps running", async () => {
    const harness = createHarness(branchEntries(1_300), 1_300);
    // context hook returns synchronously — the model request is not blocked.
    fireContext(harness, 1_300);
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.extension.status().candidate, "preparing");
    // A tool-loop continuation request does not start a second summarization.
    fireContext(harness, 1_310);
    assert.equal(harness.calls.length, 1);
    // The summary request carries the schema-only tool prefix and no executor.
    const call = harness.calls[0]!;
    assert.equal(call.options.toolChoice, undefined, "preserve the main request tool-choice shape without an executor");
    assert.equal(call.options.sessionId, "session-1");
    assert.equal(call.context.systemPrompt, "You are a coding agent.");
    const tools = call.context.tools as { name: string; description: string }[];
    assert.deepEqual(tools.map((tool) => tool.name), ["bash", "read"]);
    for (const tool of tools) assert.equal("execute" in tool, false);
  });

  it("does nothing under the waterline, when disabled, or when Pi compaction is off", async () => {
    const harness = createHarness(branchEntries(1_300), 500);
    fireContext(harness, 500);
    assert.equal(harness.calls.length, 0);

    harness.config.enabled = false;
    fireContext(harness, 1_300);
    assert.equal(harness.calls.length, 0);
  });

  it("commit waits for the in-flight candidate and adopts its fixed cut instead of a second call", async () => {
    const harness = createHarness(branchEntries(1_300), 1_300);
    fireContext(harness, 1_300);
    assert.equal(harness.calls.length, 1);

    const event = compactEvent(harness);
    const commitPromise = harness.handlers.get("session_before_compact")!(event as never, harness.ctx as never);
    // The foreground request is waiting on the same in-flight summary call.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(harness.calls.length, 1);

    harness.calls[0]!.resolve(okResponse("Working summary of earlier turns."));
    const result = await commitPromise as { compaction?: { summary: string; firstKeptEntryId: string } };
    assert.equal(result.compaction?.summary, "Working summary of earlier turns.");
    assert.ok(harness.entries.some((e) => e.id === result.compaction?.firstKeptEntryId));
    assert.deepEqual(harness.successes, ["prepare", "commit"]);
    assert.equal(harness.calls.length, 1);
  });

  it("commits a ready candidate immediately without another model call", async () => {
    const harness = createHarness(branchEntries(1_300), 1_300);
    fireContext(harness, 1_300);
    harness.calls[0]!.resolve(okResponse("Ready summary."));
    await waitFor(() => harness.extension.status().candidate === "ready");

    const result = await harness.handlers.get("session_before_compact")!(
      compactEvent(harness) as never, harness.ctx as never,
    ) as { compaction?: { summary: string } };
    assert.equal(result.compaction?.summary, "Ready summary.");
    assert.equal(harness.calls.length, 1);
  });

  it("generates synchronously from Pi's preparation when no candidate exists", async () => {
    const harness = createHarness(branchEntries(1_300), 1_300);
    const commitPromise = harness.handlers.get("session_before_compact")!(
      compactEvent(harness) as never, harness.ctx as never,
    );
    await waitFor(() => harness.calls.length === 1);
    harness.calls[0]!.resolve(okResponse("Synchronous summary."));
    const result = await commitPromise as { compaction?: { summary: string; firstKeptEntryId: string } };
    assert.equal(result.compaction?.summary, "Synchronous summary.");
    assert.equal(result.compaction?.firstKeptEntryId, harness.entries[harness.entries.length - 2]!.id);
    assert.deepEqual(harness.successes, ["commit"]);
  });

  it("a custom instruction bypasses the candidate and regenerates with the focus applied", async () => {
    const harness = createHarness(branchEntries(1_300), 1_300);
    fireContext(harness, 1_300);
    harness.calls[0]!.resolve(okResponse("Candidate summary."));
    await waitFor(() => harness.extension.status().candidate === "ready");

    const commitPromise = harness.handlers.get("session_before_compact")!(
      compactEvent(harness, { customInstructions: "Focus on the database schema" }) as never,
      harness.ctx as never,
    );
    await waitFor(() => harness.calls.length === 2);
    const lastMessage = harness.calls[1]!.context.messages.at(-1) as { content: { text: string }[] };
    assert.match(lastMessage.content[0]!.text, /Focus on the database schema/);
    harness.calls[1]!.resolve(okResponse("Schema-focused summary."));
    const result = await commitPromise as { compaction?: { summary: string } };
    assert.equal(result.compaction?.summary, "Schema-focused summary.");
  });

  it("reports a prepare failure, clears the candidate, and retries on the next request", async () => {
    const harness = createHarness(branchEntries(1_300), 1_300);
    fireContext(harness, 1_300);
    harness.calls[0]!.reject(new Error("provider offline"));
    await waitFor(() => harness.failures.length === 1);
    assert.equal(harness.failures[0]![0], "prepare");
    assert.equal(harness.extension.status().candidate, "none");

    // Next context event retries preparation rather than staying stuck.
    fireContext(harness, 1_320);
    assert.equal(harness.calls.length, 2);
  });

  it("rejects a tool call or empty body from the summary request instead of committing it", async () => {
    const harness = createHarness(branchEntries(1_300), 1_300);
    fireContext(harness, 1_300);
    harness.calls[0]!.resolve(toolCallResponse());
    await waitFor(() => harness.failures.length === 1);
    assert.match(harness.failures[0]![1], /tool/i);
    assert.equal(harness.extension.status().candidate, "none");
  });

  it("a failed synchronous commit cancels without a second summarizer and reports the commit phase", async () => {
    const harness = createHarness(branchEntries(1_300), 1_300);
    const commitPromise = harness.handlers.get("session_before_compact")!(
      compactEvent(harness) as never, harness.ctx as never,
    );
    await waitFor(() => harness.calls.length === 1);
    harness.calls[0]!.reject(new Error("rate limited"));
    const result = await commitPromise;
    assert.deepEqual(result, { cancel: true });
    assert.deepEqual(harness.failures, [["commit", "rate limited"]]);
  });

  it("aborts the in-flight candidate on branch navigation and refuses a stale commit", async () => {
    const harness = createHarness(branchEntries(1_300), 1_300);
    fireContext(harness, 1_300);
    assert.equal(harness.calls.length, 1);

    harness.handlers.get("session_tree")!({ type: "session_tree" } as never, harness.ctx as never);
    assert.equal(harness.calls[0]!.options.signal?.aborted, true);
    assert.equal(harness.extension.status().candidate, "none");

    // A compaction on the new branch cannot reuse the discarded candidate.
    const commitPromise = harness.handlers.get("session_before_compact")!(
      compactEvent(harness) as never, harness.ctx as never,
    );
    await waitFor(() => harness.calls.length === 2);
    harness.calls[1]!.resolve(okResponse("Fresh branch summary."));
    const result = await commitPromise as { compaction?: { summary: string } };
    assert.equal(result.compaction?.summary, "Fresh branch summary.");
  });

  it("a model switch discards the candidate keyed to the old model", async () => {
    const harness = createHarness(branchEntries(1_300), 1_300);
    fireContext(harness, 1_300);
    harness.calls[0]!.resolve(okResponse("Old model summary."));
    await waitFor(() => harness.extension.status().candidate === "ready");

    harness.handlers.get("model_select")!({ type: "model_select" } as never, harness.ctx as never);
    assert.equal(harness.extension.status().candidate, "none");
  });

  it("calibrates a matching real request once without adding cached tokens twice", () => {
    const observation = new RequestBudgetObservation();
    const context = { systemPrompt: "stable prefix", messages: convertToLlm([userMessage("hello")]) };
    const response = okResponse("answer");
    response.usage = { ...usage(1_000), input: 100, cacheRead: 700, cacheWrite: 100, output: 100 };
    observation.record("same-config", context, response);
    assert.equal(observation.estimate("same-config", context), 900);
    observation.clear();
    assert.ok(observation.estimate("same-config", context) < 100);
  });
});


describe("D-284 acceptance regressions", () => {
  it("rebinds observation retention on branch navigation without preparing a summary", async () => {
    const note: SessionEntry = { id: "kept-note", parentId: null, timestamp: new Date().toISOString(),
      type: "custom_message", customType: "piarium-context", content: "observed facts", display: false,
      details: { observationRefs: ["kept-receipt"], gitObserved: true } };
    const harness = createHarness([note], 10);
    await harness.handlers.get("session_tree")!({ type: "session_tree" } as never, harness.ctx as never);
    assert.deepEqual(harness.compactions.at(-1), { retainedObservationRefs: ["kept-receipt"], retainedGit: true });
    harness.entries = [entry("other", null, userMessage("a different branch"))];
    await harness.handlers.get("session_tree")!({ type: "session_tree" } as never, harness.ctx as never);
    assert.deepEqual(harness.compactions.at(-1), { retainedObservationRefs: [], retainedGit: false });
    assert.equal(harness.calls.length, 0);
  });
  for (const stopReason of ["aborted", "length"] as const) {
    it(`never adopts a ${stopReason} summary with nonempty partial text`, async () => {
      const harness = createHarness(branchEntries(1_300), 1_300);
      fireContext(harness, 1_300);
      harness.calls[0]!.resolve({ ...okResponse("Only the first half of the requirements."), stopReason });
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      assert.equal(harness.extension.status().candidate, "none");
      assert.equal(harness.failures.length, 1);
    });
  }

  it("cancels already-running preparation when the user disables background maintenance", () => {
    const harness = createHarness(branchEntries(1_300), 1_300);
    fireContext(harness, 1_300);
    harness.config.enabled = false;
    fireContext(harness, 1_350);
    assert.equal(harness.calls[0]!.options.signal?.aborted, true);
    assert.equal(harness.extension.status().candidate, "none");
  });

  it("does not fall through to a second summarizer after a failed explicit commit", async () => {
    const harness = createHarness(branchEntries(1_300), 1_300);
    const commit = harness.handlers.get("session_before_compact")!(
      compactEvent(harness) as never, harness.ctx as never,
    );
    await waitFor(() => harness.calls.length === 1);
    harness.calls[0]!.reject(new Error("summary request failed"));
    assert.deepEqual(await commit, { cancel: true });
    assert.equal(harness.calls.length, 1);
  });
});
