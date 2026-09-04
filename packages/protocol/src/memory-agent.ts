export interface MemoryAgentSettings {
  interval: number;
  blockBudgetTokens: number;
  totalBudgetTokens: number;
  minContextTokens: number;
  cooldownMs: number;
  maxInterval: number;
}

export const DEFAULT_MEMORY_AGENT_SETTINGS: MemoryAgentSettings = {
  interval: 5_000,
  blockBudgetTokens: 2_000,
  totalBudgetTokens: 12_000,
  minContextTokens: 10_000,
  cooldownMs: 30_000,
  maxInterval: 20_000,
};

export interface MemoryEditOp {
  op: "replace" | "patch" | "create" | "delete" | "mark_plan";
  block?: string;
  content?: string;
  find?: string;
  replace?: string;
  item?: number;
  status?: "done" | "blocked" | "open";
}

export interface MemoryAgentState {
  hasRun: boolean;
  inFlight: boolean;
  lastRunTokens: number;
  lastEndAt: number;
  interval: number;
  lastRunChangedBlocks: boolean;
}

export interface MemoryTurnEndMeta {
  turnIndex: number;
  contextTokens: number;
  toolCallsSinceLastRun: number;
  lastStepHadNoTools: boolean;
}

export interface MemoryGateDecision {
  shouldRun: boolean;
  reason: string;
}

export interface MemoryBlockSnapshot {
  label: string;
  content: string;
  updatedBy: "agent" | "memory-agent" | "user";
  cursorTurn?: number;
}

export interface MemoryApplyResult {
  applied: number;
  rejected: number;
  errors: string[];
  changedBlocks: boolean;
}

export function parseMemoryEditOps(value: unknown): MemoryEditOp[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawOps = (value as Record<string, unknown>).ops;
  if (!Array.isArray(rawOps)) return null;
  const parsed: MemoryEditOp[] = [];
  for (const raw of rawOps) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (!["replace", "patch", "create", "delete", "mark_plan"].includes(String(record.op))) return null;
    if (record.block !== undefined && typeof record.block !== "string") return null;
    if (record.content !== undefined && typeof record.content !== "string") return null;
    if (record.find !== undefined && typeof record.find !== "string") return null;
    if (record.replace !== undefined && typeof record.replace !== "string") return null;
    if (record.item !== undefined && !Number.isSafeInteger(record.item)) return null;
    if (record.status !== undefined && record.status !== "done" && record.status !== "blocked" && record.status !== "open") return null;
    parsed.push({
      op: record.op as MemoryEditOp["op"],
      ...(record.block === undefined ? {} : { block: record.block as string }),
      ...(record.content === undefined ? {} : { content: record.content as string }),
      ...(record.find === undefined ? {} : { find: record.find as string }),
      ...(record.replace === undefined ? {} : { replace: record.replace as string }),
      ...(record.item === undefined ? {} : { item: record.item as number }),
      ...(record.status === undefined ? {} : {
        status: record.status as Exclude<MemoryEditOp["status"], undefined>,
      }),
    });
  }
  return parsed;
}

export function createInitialMemoryAgentState(settings: MemoryAgentSettings): MemoryAgentState {
  return {
    hasRun: false,
    inFlight: false,
    lastRunTokens: 0,
    lastEndAt: 0,
    interval: settings.interval,
    lastRunChangedBlocks: false,
  };
}

export function evaluateMemoryAgentGate(
  state: MemoryAgentState,
  meta: MemoryTurnEndMeta,
  settings: MemoryAgentSettings,
  now: number,
): MemoryGateDecision {
  if (state.inFlight) return { shouldRun: false, reason: "in-flight" };
  if (state.hasRun && now - state.lastEndAt < settings.cooldownMs) {
    return { shouldRun: false, reason: "cooldown" };
  }
  if (meta.contextTokens < settings.minContextTokens && !state.hasRun) {
    return { shouldRun: false, reason: "below-min-context" };
  }
  const tokenDelta = meta.contextTokens - state.lastRunTokens;
  if (tokenDelta >= state.interval && (meta.toolCallsSinceLastRun >= 3 || meta.lastStepHadNoTools)) {
    return { shouldRun: true, reason: "interval-met" };
  }
  return { shouldRun: false, reason: "interval-not-met" };
}

export function evaluateMemoryEventGate(
  state: MemoryAgentState,
  settings: MemoryAgentSettings,
  now: number,
): MemoryGateDecision {
  if (state.inFlight) return { shouldRun: false, reason: "in-flight" };
  if (state.hasRun && now - state.lastEndAt < settings.cooldownMs) {
    return { shouldRun: false, reason: "cooldown" };
  }
  return { shouldRun: true, reason: "event-acceleration" };
}
