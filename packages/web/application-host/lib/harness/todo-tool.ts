/**
 * todo tool — plan block management for the main agent.
 *
 * Design: agent-harness.md §5.6
 * Plan: agent-harness-plan.md §2.5
 *
 * Schema: { items: Array<{ text; status: 'open'|'done'|'blocked' }>; confidence?: number }
 * Replaces the entire `plan` block (updatedBy: 'agent').
 * Content rendered as `- [ ] text` / `- [x] text` / `- [!] text`.
 * Returns: `plan updated: ${done}/${total} done${blocked ? `, ${blocked} blocked` : ''}`
 *
 * Confidence check: confidence < settings.plan.confirmBelow (default 0.6) and
 * session not yet confirmed → ask for confirmation via permission channel.
 */

import type { KnowledgeStore } from "../knowledge/store.js";
import { DEFAULT_TODO_CONFIRM_BELOW } from "@piarium/protocol";

// ── Types ──────────────────────────────────────────────────────────

export type TodoItemStatus = "open" | "done" | "blocked";

export interface TodoItem {
  text: string;
  status: TodoItemStatus;
}

export interface TodoToolInput {
  items: TodoItem[];
  confidence?: number;
}

export interface TodoToolSettings {
  confirmBelow: number; // default 0.6
}

export const DEFAULT_TODO_SETTINGS: TodoToolSettings = {
  confirmBelow: DEFAULT_TODO_CONFIRM_BELOW,
};

export interface TodoToolDeps {
  store: KnowledgeStore;
  sessionId: string;
  settings: TodoToolSettings;
}

// ── Rendering ──────────────────────────────────────────────────────

export function renderPlanContent(items: TodoItem[]): string {
  return items.map((item) => {
    const marker = item.status === "done" ? "[x]" : item.status === "blocked" ? "[!]" : "[ ]";
    return `- ${marker} ${item.text}`;
  }).join("\n");
}

export function parsePlanContent(content: string): TodoItem[] {
  const lines = content.split("\n");
  const items: TodoItem[] = [];
  for (const line of lines) {
    const match = line.match(/^-\s*\[([ x!])\]\s*(.+)$/);
    if (match) {
      const status: TodoItemStatus = match[1] === "x" ? "done" : match[1] === "!" ? "blocked" : "open";
      items.push({ text: match[2]!, status });
    }
  }
  return items;
}

// ── Tool execution ─────────────────────────────────────────────────

export interface TodoToolResult {
  text: string;
  confirmed?: boolean | undefined;
  askedConfirmation: boolean;
}

export async function executeTodoTool(
  input: TodoToolInput,
  deps: TodoToolDeps,
  sessionConfirmed: boolean,
  branchEntryIds?: readonly string[],
): Promise<TodoToolResult> {
  const { store, sessionId, settings } = deps;
  const items = input.items;
  const content = renderPlanContent(items);

  // Confidence check
  const askedConfirmation = input.confidence !== undefined && input.confidence < settings.confirmBelow;
  if (!sessionConfirmed && askedConfirmation) {
    return {
      text: "plan update requires user confirmation",
      confirmed: false,
      askedConfirmation: true,
    };
  }

  // Replace plan block
  await store.upsertBlock({
    sessionId,
    label: "plan",
    content,
    updatedBy: "agent",
    ...(branchEntryIds === undefined ? {} : {
      branchEntryIds,
      sourceLeafId: branchEntryIds[branchEntryIds.length - 1] ?? null,
    }),
  });

  // Build summary
  const done = items.filter((i) => i.status === "done").length;
  const blocked = items.filter((i) => i.status === "blocked").length;
  const total = items.length;
  let text = `plan updated: ${done}/${total} done`;
  if (blocked > 0) text += `, ${blocked} blocked`;

  return { text, ...(sessionConfirmed && askedConfirmation ? { confirmed: true } : {}), askedConfirmation };
}

// ── Prompt guidelines ──────────────────────────────────────────────

export const TODO_PROMPT_GUIDELINES = [
  "For non-trivial tasks, write a short plan with todo before acting, and state your confidence.",
];
