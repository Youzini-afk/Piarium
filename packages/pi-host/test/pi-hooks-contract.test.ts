import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type {
  AgentSessionServices,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  BeforeProviderRequestEvent,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  ToolCallEventResult,
  ToolDefinition,
  ToolResultEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import type { HostEvent, HostEventData } from "@piarium/protocol";
import { SessionHost } from "../src/session-host.js";

// ---------------------------------------------------------------------------
// Compile-time assertions: verify Pi 0.84.3 hook shapes match what the
// agent harness design (agent-harness.md §4.1) requires.  These `satisfies`
// checks are erased at runtime but fail compilation when an upstream type
// changes shape.
// ---------------------------------------------------------------------------

void (null as unknown as BeforeAgentStartEvent satisfies {
  type: "before_agent_start";
  prompt: string;
  systemPrompt: string;
});

void (null as unknown as BeforeAgentStartEventResult satisfies {
  message?: unknown;
  systemPrompt?: string;
});

// SessionBeforeCompactResult and ToolResultEventResult are not re-exported
// from the top-level package entry; verify their shapes via the event types
// and the handler result types that ARE exported.
void (null as unknown as SessionBeforeCompactEvent satisfies {
  type: "session_before_compact";
  preparation: unknown;
  branchEntries: unknown[];
  reason: "manual" | "threshold" | "overflow";
});

void (null as unknown as SessionCompactEvent satisfies {
  type: "session_compact";
  compactionEntry: unknown;
});

// ToolResultEvent carries the fields that tool_result handlers can replace.
void (null as unknown as ToolResultEvent satisfies {
  type: "tool_result";
  toolCallId: string;
  content: unknown;
  isError: boolean;
});

void (null as unknown as ToolCallEventResult satisfies {
  block?: boolean;
  reason?: string;
});

void (null as unknown as TurnEndEvent satisfies {
  type: "turn_end";
  turnIndex: number;
  message: unknown;
  toolResults: unknown[];
});

void (null as unknown as BeforeProviderRequestEvent satisfies {
  type: "before_provider_request";
  payload: unknown;
});

// ToolDefinition: verify the fields the harness relies on exist.  We check
// field presence via a mapped shape rather than full assignability to avoid
// contravariance issues with the `execute` function signature.
type ToolDefinitionShape = Pick<
  ToolDefinition,
  "name" | "label" | "description" | "promptSnippet" | "promptGuidelines" | "parameters" | "executionMode" | "execute"
>;
void (null as unknown as ToolDefinitionShape satisfies {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  executionMode?: "parallel" | "sequential";
  execute: unknown;
});

// `customTools` same-name override is a runtime behaviour, not a type
// constraint; verified by the runtime test below and by the existing
// workspace-mutation-journal tests that override `write` / `edit`.

// ---------------------------------------------------------------------------
// Runtime test: `before_agent_start` returning `{ message }` appends a
// custom message to the conversation without changing the system prompt,
// and the system prompt stays byte-identical across steps within the same
// agent loop.
// ---------------------------------------------------------------------------

describe("Pi hooks contract (0.84.3)", () => {
  it("before_agent_start message is appended and system prompt is stable across steps", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-hooks-"));
    const agentDir = join(root, "agent");
    const projectExtensions = join(root, ".pi", "extensions");
    await mkdir(projectExtensions, { recursive: true });

    // Project extension that hooks before_agent_start and returns a message
    // (Zone 2 append) instead of modifying systemPrompt (Zone 0 violation).
    await writeFile(
      join(projectExtensions, "hooks-test.ts"),
      `export default function extension(pi: any) {
        pi.on("before_agent_start", () => {
          return {
            message: {
              customType: "piarium-hooks-test",
              content: "hooks-test-zone2-message",
              display: false,
            },
          };
        });
      }\n`,
      "utf8",
    );

    // Create a file for the read tool to succeed in step 1.
    await writeFile(join(root, "test.txt"), "hello world\n", "utf8");

    const faux = registerFauxProvider();
    const capturedContexts: Context[] = [];

    faux.setResponses([
      (context) => {
        capturedContexts.push(context);
        return fauxAssistantMessage([
          fauxToolCall("read", { path: "test.txt" }),
        ]);
      },
      (context) => {
        capturedContexts.push(context);
        return fauxAssistantMessage("done");
      },
    ]);

    const model = faux.getModel();
    const configureServices = async (services: AgentSessionServices) => {
      services.modelRuntime.registerProvider(model.provider, {
        api: model.api,
        baseUrl: model.baseUrl,
        models: [
          {
            api: model.api,
            baseUrl: model.baseUrl,
            contextWindow: model.contextWindow,
            cost: model.cost,
            id: model.id,
            input: model.input,
            maxTokens: model.maxTokens,
            name: model.name,
            reasoning: model.reasoning,
          },
        ],
      });
      await services.modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
      return { model };
    };

    const host = new SessionHost({
      agentDir,
      configureServices,
      emit: (() => {}) as <E extends HostEvent>(event: E, data: HostEventData<E>) => void,
      projectTrustOverride: true,
    });

    try {
      const snapshot = await host.create(root);
      await host.prompt(snapshot.sessionId, "read test.txt then say done");
      await host.session.waitForIdle();

      assert.equal(capturedContexts.length, 2, "expected exactly two provider calls (two steps)");

      // Zone 0: system prompt must be byte-identical across steps.
      const system1 = capturedContexts[0]!.systemPrompt ?? "";
      const system2 = capturedContexts[1]!.systemPrompt ?? "";
      assert.equal(
        system2,
        system1,
        "system prompt must not change between steps within the same agent loop",
      );

      // Zone 2: the custom message from before_agent_start must appear in
      // the messages of both steps (it was appended before the first call).
      const messages1Text = JSON.stringify(capturedContexts[0]!.messages);
      const messages2Text = JSON.stringify(capturedContexts[1]!.messages);
      assert.match(
        messages1Text,
        /hooks-test-zone2-message/,
        "before_agent_start message must appear in step 1 messages",
      );
      assert.match(
        messages2Text,
        /hooks-test-zone2-message/,
        "before_agent_start message must appear in step 2 messages",
      );

      // Prefix property: step 1 messages must be a prefix of step 2 messages.
      // (Step 2 has the same messages as step 1 plus the assistant response
      //  and tool result from step 1.)
      const msgs1 = capturedContexts[0]!.messages;
      const msgs2 = capturedContexts[1]!.messages;
      assert.ok(
        msgs2.length >= msgs1.length,
        "step 2 must have at least as many messages as step 1",
      );
      for (let i = 0; i < msgs1.length; i += 1) {
        assert.deepEqual(
          msgs2[i],
          msgs1[i],
          `message ${i} must be identical between steps (prefix property)`,
        );
      }
    } finally {
      await host.dispose();
      faux.unregister();
      await rm(root, { force: true, recursive: true });
    }
  });

  // -------------------------------------------------------------------------
  // 2.6 verify-before-implement experiment: does Pi consume the
  // `compaction` field from `session_before_compact` handler return value?
  // If yes, the harness can provide its own summary (zero LLM calls for
  // compaction). If no, the harness must follow the plan's alternative path.
  //
  // This test registers a `session_before_compact` handler that returns
  // `{ compaction: { summary, firstKeptEntryId, tokensBefore } }` and
  // verifies:
  // 1. The custom summary text appears in the session after compaction.
  // 2. The faux provider's summarization function is NOT called (zero LLM
  //    calls for compaction — the extension-provided result is used as-is).
  // -------------------------------------------------------------------------
  it("session_before_compact compaction result is consumed by Pi (zero LLM calls)", async () => {
    // This test generates a large session and triggers compaction.
    const root = await mkdtemp(join(tmpdir(), "piarium-compact-"));
    const agentDir = join(root, "agent");
    const projectExtensions = join(root, ".pi", "extensions");
    await mkdir(projectExtensions, { recursive: true });

    // Project extension that hooks session_before_compact and provides
    // a custom compaction result, bypassing Pi's LLM summarization.
    await writeFile(
      join(projectExtensions, "compact-test.ts"),
      `export default function extension(pi: any) {
        pi.on("session_before_compact", (event: any) => {
          return {
            compaction: {
              summary: "piarium-custom-compaction-summary-marker",
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
            },
          };
        });
      }\n`,
      "utf8",
    );

    // Generate enough context to exceed keepRecentTokens (20000 tokens).
    // Use large assistant text responses to build up context quickly.
    const largeText = "x".repeat(30000); // ~7500 tokens per response
    const faux = registerFauxProvider();
    const capturedContexts: Context[] = [];

    faux.setResponses([
      (context) => {
        capturedContexts.push(context);
        return fauxAssistantMessage(largeText + " turn 1");
      },
      (context) => {
        capturedContexts.push(context);
        return fauxAssistantMessage(largeText + " turn 2");
      },
      (context) => {
        capturedContexts.push(context);
        return fauxAssistantMessage(largeText + " turn 3");
      },
      (context) => {
        capturedContexts.push(context);
        return fauxAssistantMessage("done");
      },
    ]);

    const model = faux.getModel();
    const configureServices = async (services: AgentSessionServices) => {
      services.modelRuntime.registerProvider(model.provider, {
        api: model.api,
        baseUrl: model.baseUrl,
        models: [
          {
            api: model.api,
            baseUrl: model.baseUrl,
            contextWindow: model.contextWindow,
            cost: model.cost,
            id: model.id,
            input: model.input,
            maxTokens: model.maxTokens,
            name: model.name,
            reasoning: model.reasoning,
          },
        ],
      });
      await services.modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
      return { model };
    };

    const host = new SessionHost({
      agentDir,
      configureServices,
      emit: (() => {}) as <E extends HostEvent>(event: E, data: HostEventData<E>) => void,
      projectTrustOverride: true,
    });

    try {
      const snapshot = await host.create(root);
      // Send multiple prompts to build up context across turns.
      await host.prompt(snapshot.sessionId, "tell me about turn 1");
      await host.session.waitForIdle();
      await host.prompt(snapshot.sessionId, "tell me about turn 2");
      await host.session.waitForIdle();
      await host.prompt(snapshot.sessionId, "tell me about turn 3");
      await host.session.waitForIdle();
      await host.prompt(snapshot.sessionId, "say done");
      await host.session.waitForIdle();

      // 4 provider calls for 4 agent turns.
      assert.equal(capturedContexts.length, 4, "expected exactly four provider calls for agent turns");

      // Now trigger manual compaction via the Pi session.
      // The session_before_compact hook should provide the custom summary.
      // compact() returns a Promise<CompactionResult> — await it directly.
      await host.session.compact();

      // Verify the custom summary marker appears in the session messages.
      const messagesJson = JSON.stringify(host.session.messages);
      assert.match(
        messagesJson,
        /piarium-custom-compaction-summary-marker/,
        "custom compaction summary must appear in session messages after compaction",
      );

      // Still only 4 provider calls — compaction used the extension result.
      assert.equal(
        capturedContexts.length,
        4,
        "no additional provider calls for compaction (extension provided result)",
      );
    } finally {
      await host.dispose();
      faux.unregister();
      try { await rm(root, { force: true, recursive: true }); } catch { /* Windows EBUSY */ }
    }
  });
});
