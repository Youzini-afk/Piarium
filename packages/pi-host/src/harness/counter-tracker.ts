import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

interface ToolCallRecord {
  name: string;
  argsHash: string;
  step: number;
}

interface CounterState {
  toolErrors: number;
  toolRetries: number;
  outputBytes: number;
  currentStep: number;
  recentToolCalls: ToolCallRecord[];
}

export interface HarnessCounters {
  toolErrors: number;
  toolRetries: number;
  outputBytes: number;
  cacheHitRatio: number | null;
}

export interface HarnessCounterTracker {
  extension: ExtensionFactory;
  getCounters(cacheRead?: number, input?: number): HarnessCounters;
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

export function createHarnessCounterTracker(): HarnessCounterTracker {
  const state: CounterState = {
    toolErrors: 0,
    toolRetries: 0,
    outputBytes: 0,
    currentStep: 0,
    recentToolCalls: [],
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
      cacheHitRatio,
    };
  };

  const reset = (): void => {
    state.toolErrors = 0;
    state.toolRetries = 0;
    state.outputBytes = 0;
    state.currentStep = 0;
    state.recentToolCalls = [];
  };

  return { extension, getCounters, reset };
}
