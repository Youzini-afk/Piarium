/**
 * Memory agent — maintains session memory blocks via model calls.
 *
 * Design: agent-harness.md §8.4.1
 * Plan: agent-harness-plan.md §2.4
 *
 * Core constraints:
 * 1. Prefix byte-for-byte reuse (otherwise every run is full-price)
 * 2. Main agent zero-participation (no block editing tools for it)
 *
 * Gating table (table-driven, tests use same table):
 * - contextTokens < 10_000 and never run → don't run
 * - run in flight → don't run
 * - < 30s since last end → don't run
 * - contextTokens - lastRunTokens >= interval AND (toolCallsSinceLastRun >= 3 OR lastStepHadNoTools) → run
 * - event acceleration (any event) → run (still subject to in-flight + 30s)
 * - last run changed no blocks → interval = min(interval * 1.5, 20_000); changed → interval = 5_000
 */

import type { KnowledgeStore, BlockInput, BlockUpdatedBy } from "../knowledge/store.js";

// ── Types ──────────────────────────────────────────────────────────

export type MemoryEventKind =
  | "test-finished"
  | "exit-flipped-to-pass"
  | "user-message"
  | "user-steer"
  | "plan-edited"
  | "child-returned"
  | "user-mark";

export interface MemoryAgentSettings {
  interval: number; // default 5_000 tokens
  blockBudgetTokens: number; // default 2000
  totalBudgetTokens: number; // default 12000
  minContextTokens: number; // default 10_000
  cooldownMs: number; // default 30_000
  maxInterval: number; // default 20_000
}

export const DEFAULT_MEMORY_AGENT_SETTINGS: MemoryAgentSettings = {
  interval: 5_000,
  blockBudgetTokens: 2000,
  totalBudgetTokens: 12000,
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

export interface MemoryEditToolCall {
  ops: MemoryEditOp[];
}

export interface ProviderPrefix {
  system: string;
  tools: unknown[];
  messages: unknown[];
}

export interface ToolCallResult {
  toolCalls: Array<{ name: string; input: unknown }>;
}

export interface TurnEndMeta {
  turnIndex: number;
  contextTokens: number;
  toolCallsSinceLastRun: number;
  lastStepHadNoTools: boolean;
}

// ── Gating ─────────────────────────────────────────────────────────

export interface MemoryAgentState {
  hasRun: boolean;
  inFlight: boolean;
  lastRunTokens: number;
  lastEndAt: number;
  interval: number;
  lastRunChangedBlocks: boolean;
}

export function createInitialState(settings: MemoryAgentSettings): MemoryAgentState {
  return {
    hasRun: false,
    inFlight: false,
    lastRunTokens: 0,
    lastEndAt: 0,
    interval: settings.interval,
    lastRunChangedBlocks: false,
  };
}

export interface GateDecision {
  shouldRun: boolean;
  reason: string;
}

export function evaluateGate(
  state: MemoryAgentState,
  meta: TurnEndMeta,
  settings: MemoryAgentSettings,
  now: number,
): GateDecision {
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

export function evaluateEventGate(
  state: MemoryAgentState,
  settings: MemoryAgentSettings,
  now: number,
): GateDecision {
  if (state.inFlight) return { shouldRun: false, reason: "in-flight" };
  if (state.hasRun && now - state.lastEndAt < settings.cooldownMs) {
    return { shouldRun: false, reason: "cooldown" };
  }
  return { shouldRun: true, reason: "event-acceleration" };
}

// ── Op validation ──────────────────────────────────────────────────

const BLOCK_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export interface OpValidationResult {
  valid: boolean;
  error?: string;
}

export function validateOp(
  op: MemoryEditOp,
  existingBlocks: Set<string>,
  settings: MemoryAgentSettings,
): OpValidationResult {
  // Block name validation
  if (op.op !== "mark_plan" && op.block && !BLOCK_NAME_RE.test(op.block)) {
    return { valid: false, error: `Invalid block name: ${op.block}` };
  }

  switch (op.op) {
    case "replace":
      if (!op.block) return { valid: false, error: "replace requires block" };
      if (!existingBlocks.has(op.block)) return { valid: false, error: `replace: block "${op.block}" does not exist` };
      if (!op.content) return { valid: false, error: "replace requires content" };
      if (estimateTokens(op.content) > settings.blockBudgetTokens) {
        return { valid: false, error: `replace: block content exceeds budget (${settings.blockBudgetTokens} tokens)` };
      }
      return { valid: true };

    case "patch":
      if (!op.block) return { valid: false, error: "patch requires block" };
      if (!existingBlocks.has(op.block)) return { valid: false, error: `patch: block "${op.block}" does not exist` };
      if (!op.find) return { valid: false, error: "patch requires find" };
      if (!op.replace) return { valid: false, error: "patch requires replace" };
      return { valid: true };

    case "create":
      if (!op.block) return { valid: false, error: "create requires block" };
      if (existingBlocks.has(op.block)) return { valid: false, error: `create: block "${op.block}" already exists` };
      if (!op.content) return { valid: false, error: "create requires content" };
      if (estimateTokens(op.content) > settings.blockBudgetTokens) {
        return { valid: false, error: `create: block content exceeds budget (${settings.blockBudgetTokens} tokens)` };
      }
      return { valid: true };

    case "delete":
      if (!op.block) return { valid: false, error: "delete requires block" };
      if (!existingBlocks.has(op.block)) return { valid: false, error: `delete: block "${op.block}" does not exist` };
      if (op.block === "plan") return { valid: false, error: "delete: cannot delete plan block" };
      return { valid: true };

    case "mark_plan":
      if (op.item === undefined) return { valid: false, error: "mark_plan requires item" };
      if (!op.status) return { valid: false, error: "mark_plan requires status" };
      if (!["done", "blocked", "open"].includes(op.status)) {
        return { valid: false, error: `mark_plan: invalid status "${op.status}"` };
      }
      return { valid: true };

    default:
      return { valid: false, error: `Unknown op: ${op["op"]}` };
  }
}

// ── Op application ─────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface ApplyOpsResult {
  applied: number;
  rejected: number;
  errors: string[];
  changedBlocks: boolean;
}

export async function applyOps(
  ops: MemoryEditOp[],
  store: KnowledgeStore,
  sessionId: string,
  cursorTurn: number,
  settings: MemoryAgentSettings,
): Promise<ApplyOpsResult> {
  const blocks = await store.getBlocks(sessionId);
  const existingNames = new Set(blocks.map((b) => b.label));
  // Track total tokens across all blocks
  const blockTokens = new Map<string, number>();
  for (const b of blocks) blockTokens.set(b.label, estimateTokens(b.content));

  let applied = 0;
  let rejected = 0;
  const errors: string[] = [];
  let changedBlocks = false;

  for (const op of ops) {
    // Special: plan block only accepts mark_plan or replace
    if (op.block === "plan" && op.op !== "mark_plan" && op.op !== "replace") {
      rejected++;
      errors.push(`plan block only accepts mark_plan or replace, got ${op.op}`);
      continue;
    }

    const validation = validateOp(op, existingNames, settings);
    if (!validation.valid) {
      rejected++;
      errors.push(validation.error ?? "invalid op");
      continue;
    }

    // Check total budget (for ops that add/replace content)
    if (op.content) {
      const totalTokens = [...blockTokens.values()].reduce((a, b) => a + b, 0);
      const newContentTokens = estimateTokens(op.content);
      const oldBlockTokens = blockTokens.get(op.block ?? "") ?? 0;
      if (totalTokens + newContentTokens - oldBlockTokens > settings.totalBudgetTokens) {
        rejected++;
        errors.push("total budget exceeded");
        continue;
      }
    }

    try {
      switch (op.op) {
        case "replace": {
          await store.upsertBlock({
            sessionId, label: op.block!, content: op.content!,
            updatedBy: "memory-agent", cursorTurn,
          });
          blockTokens.set(op.block!, estimateTokens(op.content!));
          changedBlocks = true;
          break;
        }
        case "patch": {
          const existing = blocks.find((b) => b.label === op.block);
          if (existing) {
            const newContent = existing.content.replace(op.find!, op.replace!);
            await store.upsertBlock({
              sessionId, label: op.block!, content: newContent,
              updatedBy: "memory-agent", cursorTurn,
            });
            blockTokens.set(op.block!, estimateTokens(newContent));
            changedBlocks = true;
          }
          break;
        }
        case "create": {
          await store.upsertBlock({
            sessionId, label: op.block!, content: op.content!,
            updatedBy: "memory-agent", cursorTurn,
          });
          existingNames.add(op.block);
          blockTokens.set(op.block!, estimateTokens(op.content!));
          changedBlocks = true;
          break;
        }
        case "delete": {
          await store.deleteBlock(sessionId, op.block!);
          existingNames.delete(op.block);
          blockTokens.delete(op.block);
          changedBlocks = true;
          break;
        }
        case "mark_plan": {
          const planBlock = blocks.find((b) => b.label === "plan");
          if (planBlock) {
            // Mark item in plan: replace - [ ] or - [x] or - [!] at line item
            const lines = planBlock.content.split("\n");
            if (op.item! >= 0 && op.item! < lines.length) {
              const line = lines[op.item!];
              const marker = op.status === "done" ? "[x]" : op.status === "blocked" ? "[!]" : "[ ]";
              lines[op.item!] = line.replace(/- \[.\]/, `- ${marker}`);
              await store.upsertBlock({
                sessionId, label: "plan", content: lines.join("\n"),
                updatedBy: "memory-agent", cursorTurn,
              });
              changedBlocks = true;
            }
          }
          break;
        }
      }
      applied++;
    } catch (err) {
      rejected++;
      errors.push(String(err));
    }
  }

  return { applied, rejected, errors, changedBlocks };
}

// ── Runner ─────────────────────────────────────────────────────────

export interface MemoryAgentRunnerDeps {
  store: KnowledgeStore;
  requestPrefix: () => Promise<ProviderPrefix>;
  callModel: (payload: unknown) => Promise<ToolCallResult>;
  now: () => number;
  settings: MemoryAgentSettings;
}

export function createMemoryAgentRunner(deps: MemoryAgentRunnerDeps) {
  const { store, requestPrefix, callModel, now, settings } = deps;
  let state = createInitialState(settings);

  async function run(cursorTurn: number): Promise<void> {
    state.inFlight = true;
    try {
      const prefix = await requestPrefix();
      const blocks = await store.getBlocks(/* sessionId from store context */ "");
      const blocksText = blocks.map((b) => `[${b.label}]\n${b.content}`).join("\n\n");

      const userMessage = `You are the memory keeper for this session. Below are the current memory blocks and the turn cursor. Read the full conversation above and update the blocks so that they describe the CURRENT state of the work: progress, decisions and their reasons, errors and how they were fixed, learnings, open questions. Rewrite in place; do not append logs. Respect per-block budgets. Do not change the structure of the "plan" block; you may only mark its items done or blocked. Emit edits through the memory_edit tool only.\n<blocks cursor="turn ${cursorTurn}">\n${blocksText}\n</blocks>`;

      const payload = {
        ...prefix,
        messages: [...prefix.messages, { role: "user", content: userMessage }],
        tool_choice: { type: "function", function: { name: "memory_edit" } },
      };

      const result = await callModel(payload);
      const memoryCall = result.toolCalls.find((tc) => tc.name === "memory_edit");
      if (memoryCall) {
        const ops = (memoryCall.input as MemoryEditToolCall).ops;
        await applyOps(ops, store, "", cursorTurn, settings);
        state.lastRunChangedBlocks = true;
        state.interval = settings.interval;
      } else {
        state.lastRunChangedBlocks = false;
        state.interval = Math.min(state.interval * 1.5, settings.maxInterval);
      }

      state.hasRun = true;
      state.lastRunTokens = 0; // Updated by caller via contextTokens
      state.lastEndAt = now();
    } finally {
      state.inFlight = false;
    }
  }

  function onTurnEnd(meta: TurnEndMeta): void {
    const decision = evaluateGate(state, meta, settings, now());
    if (decision.shouldRun) {
      state.lastRunTokens = meta.contextTokens;
      void run(meta.turnIndex);
    }
  }

  function onEvent(kind: MemoryEventKind): void {
    const decision = evaluateEventGate(state, settings, now());
    if (decision.shouldRun) {
      void run(0);
    }
  }

  async function requestPreCompactionRefresh(): Promise<void> {
    if (!state.inFlight) {
      await run(0);
    }
  }

  function dispose(): void {
    state.inFlight = false;
  }

  function getState(): MemoryAgentState {
    return { ...state };
  }

  return {
    onTurnEnd,
    onEvent,
    requestPreCompactionRefresh,
    dispose,
    getState,
    // Exposed for testing
    run,
  };
}

export type MemoryAgentRunner = ReturnType<typeof createMemoryAgentRunner>;
