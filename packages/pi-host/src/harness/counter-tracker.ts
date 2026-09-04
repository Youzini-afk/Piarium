import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import type { HarnessModelRole, HarnessModelSlotUsage } from "@piarium/protocol";

interface ToolCallRecord {
  name: string;
  argsHash: string;
  step: number;
}

interface CounterState {
  toolErrors: number;
  toolRetries: number;
  outputBytes: number;
  observationCalls: number;
  currentStep: number;
  recentToolCalls: ToolCallRecord[];
  modelSlotUsage: Partial<Record<HarnessModelRole, HarnessModelSlotUsage>>;
}

export interface HarnessCounters {
  toolErrors: number;
  toolRetries: number;
  outputBytes: number;
  observationCalls: number;
  cacheHitRatio: number | null;
  modelSlotUsage: Partial<Record<HarnessModelRole, HarnessModelSlotUsage>>;
}

export interface HarnessCounterTracker {
  extension: ExtensionFactory;
  getCounters(cacheRead?: number, input?: number): HarnessCounters;
  recordModelUsage(slot: HarnessModelRole, usage: Usage): void;
  reset(): void;
}

function hashArgs(args: unknown): string {
  try {
    return JSON.stringify(args) ?? "";
  } catch {
    return "";
  }
}

function textContentBytes(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
      total += Buffer.byteLength(part.text, "utf8");
    }
  }
  return total;
}

function isIncrementalObservation(toolName: string, input: unknown): boolean {
  const params = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null;
  if (toolName === "threads" || toolName === "diagnostics") return params?.full !== true;
  if (toolName === "wait" || toolName === "read_thread") return true;
  if (toolName !== "get_output") return false;
  return typeof params?.handle === "string"
    && params.handle.startsWith("sh_")
    && params.offset === undefined
    && params.length === undefined;
}

export function createHarnessCounterTracker(): HarnessCounterTracker {
  const state: CounterState = {
    toolErrors: 0,
    toolRetries: 0,
    outputBytes: 0,
    observationCalls: 0,
    currentStep: 0,
    recentToolCalls: [],
    modelSlotUsage: {},
  };

  const extension: ExtensionFactory = (pi) => {
    pi.on("turn_start", () => {
      state.currentStep += 1;
      // Prune recent calls older than 3 steps
      state.recentToolCalls = state.recentToolCalls.filter((r) => state.currentStep - r.step <= 3);
    });

    pi.on("tool_result", (event) => {
      // Count errors
      if (event.isError) state.toolErrors += 1;
      // Count output bytes (pre-truncation)
      state.outputBytes += textContentBytes(event.content);
      if (isIncrementalObservation(event.toolName, event.input)) state.observationCalls += 1;

      // Check for retries: same tool name + same args hash within 3 steps
      const argsHash = hashArgs(event.input);
      const name = event.toolName;
      const matching = state.recentToolCalls.find(
        (r) => r.name === name && r.argsHash === argsHash,
      );
      if (matching) state.toolRetries += 1;
      state.recentToolCalls.push({ name, argsHash, step: state.currentStep });
    });
  };

  const getCounters = (cacheRead?: number, input?: number): HarnessCounters => {
    let cacheHitRatio: number | null = null;
    if (cacheRead !== undefined && input !== undefined) {
      const denom = cacheRead + input;
      cacheHitRatio = denom > 0 ? cacheRead / denom : 0;
    }
    return {
      toolErrors: state.toolErrors,
      toolRetries: state.toolRetries,
      outputBytes: state.outputBytes,
      observationCalls: state.observationCalls,
      cacheHitRatio,
      modelSlotUsage: structuredClone(state.modelSlotUsage),
    };
  };

  const recordModelUsage = (slot: HarnessModelRole, usage: Usage): void => {
    const current = state.modelSlotUsage[slot] ?? {
      calls: 0,
      cost: 0,
      tokens: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    };
    state.modelSlotUsage[slot] = {
      calls: current.calls + 1,
      cost: current.cost + usage.cost.total,
      tokens: {
        cacheRead: current.tokens.cacheRead + usage.cacheRead,
        cacheWrite: current.tokens.cacheWrite + usage.cacheWrite,
        input: current.tokens.input + usage.input,
        output: current.tokens.output + usage.output,
        total: current.tokens.total + usage.totalTokens,
      },
    };
  };

  const reset = (): void => {
    state.toolErrors = 0;
    state.toolRetries = 0;
    state.outputBytes = 0;
    state.observationCalls = 0;
    state.currentStep = 0;
    state.recentToolCalls = [];
    state.modelSlotUsage = {};
  };

  return { extension, getCounters, recordModelUsage, reset };
}
