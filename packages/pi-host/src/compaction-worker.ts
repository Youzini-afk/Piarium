import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { ModelRuntime, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ThinkingBudgets, ThinkingLevel, Transport } from "@earendil-works/pi-ai";
import {
  readCompactionTaskSpec,
  type CompactionRunResult,
  type CompactionTaskSpec,
  type HarnessError,
  type HostEventData,
} from "@varin/protocol";
import {
  COMPACTION_SYSTEM_PROMPT,
  compactionMaterialMessages,
  compactionInstruction,
  deserializeCompactionModel,
} from "./harness/compaction-agent.js";
import { createCompactionQueryTools } from "./harness/compaction-tools.js";
import { HostServicesBridge } from "./harness/host-services-bridge.js";
import { ProviderConfigurationManager } from "./provider-configuration.js";

/**
 * The internal compaction worker (D-314 §4). One dedicated pi-host subprocess
 * per task: it runs a real Pi Agent loop with read-only query executors, on the
 * parent session's model and resolved execution config, and returns S1. It
 * never creates a session, worktree, thread, or a second history database.
 */
type CompactionEmit = <E extends "harness.request" | "harness.cancel">(
  event: E,
  data: HostEventData<E>,
) => void;

export class CompactionWorkerRuntime {
  readonly #agentDir: string;
  readonly #emit: CompactionEmit;
  readonly #projectTrustOverride: boolean | undefined;
  readonly #configureModelRuntime: ((runtime: ModelRuntime) => void | Promise<void>) | undefined;
  #bridge: HostServicesBridge | undefined;
  #queries = 0;

  constructor(options: {
    agentDir: string;
    emit: CompactionEmit;
    projectTrustOverride?: boolean;
    /**
     * Test seam for in-memory providers (e.g. faux): production workers rely on
     * the shared agentDir credential/model stores plus provider configuration.
     */
    configureModelRuntime?: (runtime: ModelRuntime) => void | Promise<void>;
  }) {
    this.#agentDir = options.agentDir;
    this.#emit = options.emit;
    this.#projectTrustOverride = options.projectTrustOverride;
    this.#configureModelRuntime = options.configureModelRuntime;
  }

  respondHarness(
    sessionId: string,
    requestId: string,
    outcome: { ok: true; result: unknown } | { ok: false; error: HarnessError },
  ): boolean {
    return this.#bridge?.respond(sessionId, requestId, outcome) ?? false;
  }

  async run(params: unknown): Promise<CompactionRunResult> {
    const spec: CompactionTaskSpec = readCompactionTaskSpec(params);
    const bridge = new HostServicesBridge({
      emit: (event, data) => this.#emit(event, data),
      sessionId: spec.sessionId,
    });
    this.#bridge = bridge;
    this.#queries = 0;
    try {
      const model = deserializeCompactionModel(spec.model);
      // Same credential and model stores as the owning session
      // (createAgentSessionServices): auth.json/models.json under agentDir.
      const modelRuntime = await ModelRuntime.create({
        allowModelNetwork: false,
        authPath: join(this.#agentDir, "auth.json"),
        modelsPath: join(this.#agentDir, "models.json"),
      });
      // Same provider composition as the owning session: custom and
      // trust-gated project providers resolve through the shared agentDir
      // credential store. The process cwd is the session cwd (broker-spawned).
      const cwd = process.cwd();
      const projectTrusted = this.#projectTrustOverride
        ?? new ProjectTrustStore(this.#agentDir).get(cwd) === true;
      await new ProviderConfigurationManager({ agentDir: this.#agentDir })
        .apply(modelRuntime, cwd, projectTrusted);
      await this.#configureModelRuntime?.(modelRuntime);
      const tools = createCompactionQueryTools(bridge, () => { this.#queries += 1; });
      const agent = new Agent({
        initialState: {
          systemPrompt: COMPACTION_SYSTEM_PROMPT,
          model,
          messages: compactionMaterialMessages(spec),
          ...(spec.options.reasoning === undefined
            ? {}
            : { thinkingLevel: spec.options.reasoning as ThinkingLevel }),
        },
        streamFn: (nextModel, context, options) =>
          modelRuntime.stream(nextModel, context, {
            ...options,
            maxTokens: spec.options.maxTokens,
            ...(spec.options.temperature === undefined ? {} : { temperature: spec.options.temperature }),
            ...(spec.options.samplingParams === undefined
              ? {}
              : { samplingParams: spec.options.samplingParams as Record<string, unknown> }),
            ...(spec.options.cacheRetention === undefined
              ? {}
              : { cacheRetention: spec.options.cacheRetention as never }),
          }),
        sessionId: spec.options.sessionId ?? spec.sessionId,
        ...(spec.options.transport === undefined
          ? {}
          : { transport: spec.options.transport as Transport }),
        ...(spec.options.thinkingBudgets === undefined
          ? {}
          : { thinkingBudgets: spec.options.thinkingBudgets as ThinkingBudgets }),
        toolExecution: "parallel",
      });
      agent.state.tools = tools;
      let lastAssistant: AssistantMessage | undefined;
      const unsubscribe = agent.subscribe(async (event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          lastAssistant = event.message as AssistantMessage;
        }
      });
      try {
        await agent.prompt(compactionInstruction(spec));
        await agent.waitForIdle();
      } finally {
        unsubscribe();
      }
      if (!lastAssistant) {
        throw new Error(agent.state.errorMessage ?? "The compaction agent produced no response");
      }
      if (lastAssistant.stopReason === "aborted" || lastAssistant.stopReason === "length") {
        throw new Error(`Compaction did not complete: ${lastAssistant.stopReason}`);
      }
      if (lastAssistant.stopReason === "error") {
        throw new Error(`Compaction failed: ${lastAssistant.errorMessage || "unknown error"}`);
      }
      const summary = lastAssistant.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (!summary) throw new Error("Compaction returned no summary text");
      return {
        summary,
        queries: this.#queries,
        ...(lastAssistant.usage === undefined
          ? {}
          : { usage: JSON.parse(JSON.stringify(lastAssistant.usage)) }),
      };
    } finally {
      this.#bridge = undefined;
      bridge.dispose();
    }
  }
}
