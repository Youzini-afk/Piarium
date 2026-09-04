/**
 * Host-owned validation and application of memory keeper block edits.
 * Scheduling and model calls live in pi-host, next to the real session
 * context; this module is the only writer of model-produced block ops.
 */

import {
  DEFAULT_MEMORY_AGENT_SETTINGS,
  createInitialMemoryAgentState,
  evaluateMemoryAgentGate,
  evaluateMemoryEventGate,
  type MemoryAgentSettings,
  type MemoryAgentState,
  type MemoryApplyResult,
  type MemoryEditOp,
  type MemoryTurnEndMeta,
} from "@piarium/protocol";
import type { KnowledgeStore } from "../knowledge/store.js";

export {
  DEFAULT_MEMORY_AGENT_SETTINGS,
  createInitialMemoryAgentState as createInitialState,
  evaluateMemoryAgentGate as evaluateGate,
  evaluateMemoryEventGate as evaluateEventGate,
};
export type {
  MemoryAgentSettings,
  MemoryAgentState,
  MemoryApplyResult as ApplyOpsResult,
  MemoryEditOp,
  MemoryTurnEndMeta as TurnEndMeta,
};

const BLOCK_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export interface OpValidationResult {
  valid: boolean;
  error?: string;
}

export function validateOp(
  op: MemoryEditOp,
  existingBlocks: Set<string>,
  settings: MemoryAgentSettings,
): OpValidationResult {
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
      if (op.replace === undefined) return { valid: false, error: "patch requires replace" };
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
      if (!Number.isSafeInteger(op.item) || (op.item ?? -1) < 0) return { valid: false, error: "mark_plan requires a non-negative item" };
      if (!op.status || !["done", "blocked", "open"].includes(op.status)) {
        return { valid: false, error: `mark_plan: invalid status "${String(op.status)}"` };
      }
      return { valid: true };
    default:
      return { valid: false, error: `Unknown op: ${String((op as { op?: unknown }).op)}` };
  }
}

const totalTokens = (blocks: Map<string, string>): number => (
  [...blocks.values()].reduce((sum, content) => sum + estimateTokens(content), 0)
);

export async function applyOps(
  ops: MemoryEditOp[],
  store: KnowledgeStore,
  sessionId: string,
  cursorTurn: number,
  settings: MemoryAgentSettings,
): Promise<MemoryApplyResult> {
  const blocks = await store.getBlocks(sessionId);
  const current = new Map(blocks.map((block) => [block.label, block.content]));
  let applied = 0;
  let rejected = 0;
  let changedBlocks = false;
  const errors: string[] = [];

  const reject = (message: string): void => {
    rejected += 1;
    errors.push(message);
  };

  for (const op of ops) {
    if (op.block === "plan" && op.op !== "mark_plan" && op.op !== "replace") {
      reject(`plan block only accepts mark_plan or replace, got ${op.op}`);
      continue;
    }
    const validation = validateOp(op, new Set(current.keys()), settings);
    if (!validation.valid) {
      reject(validation.error ?? "invalid op");
      continue;
    }

    try {
      if (op.op === "delete") {
        await store.deleteBlock(sessionId, op.block!);
        current.delete(op.block!);
        applied += 1;
        changedBlocks = true;
        continue;
      }

      let block = op.block ?? "plan";
      let content: string;
      if (op.op === "replace" || op.op === "create") {
        content = op.content!;
      } else if (op.op === "patch") {
        const previous = current.get(block)!;
        if (!previous.includes(op.find!)) {
          reject(`patch: find text was not found in block "${block}"`);
          continue;
        }
        content = previous.replace(op.find!, op.replace!);
      } else {
        block = "plan";
        const previous = current.get(block);
        if (previous === undefined) {
          reject("mark_plan: plan block does not exist");
          continue;
        }
        const lines = previous.split("\n");
        if (op.item! >= lines.length || !/^-\s*\[[ x!]\]/.test(lines[op.item!]!)) {
          reject(`mark_plan: item ${op.item} is not a plan entry`);
          continue;
        }
        const marker = op.status === "done" ? "[x]" : op.status === "blocked" ? "[!]" : "[ ]";
        lines[op.item!] = lines[op.item!]!.replace(/^-\s*\[[ x!]\]/, `- ${marker}`);
        content = lines.join("\n");
      }

      const candidate = new Map(current);
      candidate.set(block, content);
      if (estimateTokens(content) > settings.blockBudgetTokens) {
        reject(`${op.op}: block content exceeds budget (${settings.blockBudgetTokens} tokens)`);
        continue;
      }
      if (totalTokens(candidate) > settings.totalBudgetTokens) {
        reject("total budget exceeded");
        continue;
      }
      const changed = current.get(block) !== content;
      if (changed) {
        await store.upsertBlock({
          sessionId,
          label: block,
          content,
          updatedBy: "memory-agent",
          cursorTurn,
        });
        current.set(block, content);
        changedBlocks = true;
      }
      applied += 1;
    } catch (error) {
      reject(error instanceof Error ? error.message : String(error));
    }
  }

  return { applied, rejected, errors, changedBlocks };
}
