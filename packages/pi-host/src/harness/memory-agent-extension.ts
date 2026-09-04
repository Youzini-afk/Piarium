import { Type, type Api, type Context, type Message, type Model } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MEMORY_AGENT_SETTINGS,
  createInitialMemoryAgentState,
  evaluateMemoryAgentGate,
  type MemoryAgentSettings,
  type MemoryEditOp,
} from "@piarium/protocol";
import type { HostServicesBridge } from "./host-services-bridge.js";

export const MEMORY_EDIT_TOOL = {
  name: "memory_edit",
  description: "Replace the session memory blocks with concise current state. This tool is only available to the background memory keeper.",
  parameters: Type.Object({
    ops: Type.Array(Type.Object({
      op: Type.Union([
        Type.Literal("replace"),
        Type.Literal("patch"),
        Type.Literal("create"),
        Type.Literal("delete"),
        Type.Literal("mark_plan"),
      ]),
      block: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
      find: Type.Optional(Type.String()),
      replace: Type.Optional(Type.String()),
      item: Type.Optional(Type.Integer({ minimum: 0 })),
      status: Type.Optional(Type.Union([Type.Literal("done"), Type.Literal("blocked"), Type.Literal("open")])),
    }, { additionalProperties: false })),
  }, { additionalProperties: false }),
} as const;

export interface MemoryAgentExtensionOptions {
  bridge: HostServicesBridge;
  enabled: boolean;
  callModel: (model: Model<Api> | undefined, context: Context, signal: AbortSignal) => Promise<MemoryEditOp[] | null>;
  now?: () => number;
  onError?: (error: unknown) => void;
  settings?: MemoryAgentSettings;
}

const keeperInstruction = (cursorTurn: number, blocks: Array<{ label: string; content: string }>): string => (
  `You are the background memory keeper for this session. Update concise blocks so they describe the CURRENT state of the work: progress, decisions and reasons, resolved errors, learnings, and open questions. Rewrite state; do not append a chronological log. Do not change the structure of the plan block; only mark its items. Use memory_edit and no prose.\n<blocks cursor="turn ${cursorTurn}">\n${blocks.map((block) => `[${block.label}]\n${block.content}`).join("\n\n")}\n</blocks>`
);

export function createMemoryAgentExtension(options: MemoryAgentExtensionOptions): ExtensionFactory {
  return (pi) => {
    if (!options.enabled) return;
    const settings = options.settings ?? DEFAULT_MEMORY_AGENT_SETTINGS;
    const now = options.now ?? Date.now;
    const state = createInitialMemoryAgentState(settings);
    const active = new Set<Promise<void>>();
    let latestMessages: Message[] = [];
    let toolCallsSinceLastRun = 0;
    let disposed = false;
    let abortController: AbortController | null = null;

    const track = (task: Promise<void>): void => {
      active.add(task);
      void task.catch((error) => options.onError?.(error)).finally(() => active.delete(task));
    };

    pi.on("context", (event) => {
      try {
        latestMessages = structuredClone(event.messages) as Message[];
      } catch {
        latestMessages = [...event.messages] as Message[];
      }
    });

    pi.on("turn_end", (event, ctx) => {
      if (disposed) return;
      const stepToolCalls = event.message.role === "assistant"
        ? event.message.content.filter((part) => part.type === "toolCall").length
        : 0;
      toolCallsSinceLastRun += stepToolCalls;
      const usage = ctx.getContextUsage();
      if (usage?.tokens === null || usage?.tokens === undefined) return;
      // Compaction or a model/context-window switch can lower the estimate.
      // Rebase the growth counter or the old absolute token value would keep
      // the keeper dormant until the compacted context grew past it again.
      if (usage.tokens < state.lastRunTokens) state.lastRunTokens = usage.tokens;
      const decision = evaluateMemoryAgentGate(state, {
        turnIndex: event.turnIndex,
        contextTokens: usage.tokens,
        toolCallsSinceLastRun,
        lastStepHadNoTools: stepToolCalls === 0,
      }, settings, now());
      if (!decision.shouldRun) return;

      state.inFlight = true;
      state.lastRunTokens = usage.tokens;
      toolCallsSinceLastRun = 0;
      const messages = [
        ...latestMessages,
        event.message as Message,
        ...event.toolResults as Message[],
      ];
      abortController = new AbortController();
      const task = (async () => {
        try {
          const snapshot = await options.bridge.request<"memory.blocks.get">("memory.blocks.get", {});
          const ops = await options.callModel(ctx.model, {
            systemPrompt: ctx.getSystemPrompt(),
            messages: [
              ...messages,
              { role: "user", content: keeperInstruction(event.turnIndex, snapshot.blocks), timestamp: now() },
            ],
            tools: [MEMORY_EDIT_TOOL],
          }, abortController!.signal);
          if (!ops || disposed) {
            state.lastRunChangedBlocks = false;
            state.interval = Math.min(state.interval * 1.5, settings.maxInterval);
            return;
          }
          const applied = await options.bridge.request<"memory.blocks.apply">("memory.blocks.apply", {
            cursorTurn: event.turnIndex,
            ops,
          });
          state.lastRunChangedBlocks = applied.changedBlocks;
          state.interval = applied.changedBlocks
            ? settings.interval
            : Math.min(state.interval * 1.5, settings.maxInterval);
        } finally {
          state.hasRun = true;
          state.lastEndAt = now();
          state.inFlight = false;
          abortController = null;
        }
      })();
      track(task);
    });

    pi.on("session_shutdown", () => {
      disposed = true;
      abortController?.abort();
    });
  };
}
