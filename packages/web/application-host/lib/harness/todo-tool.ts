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
  confirmBelow: 0.6,
};

export interface TodoToolDeps {
  store: KnowledgeStore;
  sessionId: string;
  settings: TodoToolSettings;
  /** Ask user for confirmation. Returns true if confirmed. */
  askConfirmation: (message: string) => Promise<boolean>;
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
  confirmed?: boolean;
  askedConfirmation: boolean;
}

export async function executeTodoTool(
  input: TodoToolInput,
  deps: TodoToolDeps,
  sessionConfirmed: boolean,
): Promise<TodoToolResult> {
  const { store, sessionId, settings, askConfirmation } = deps;
  const items = input.items;
  const content = renderPlanContent(items);

  // Confidence check
  let askedConfirmation = false;
  let confirmed: boolean | undefined;
  if (
    !sessionConfirmed &&
    input.confidence !== undefined &&
    input.confidence < settings.confirmBelow
  ) {
    askedConfirmation = true;
    confirmed = await askConfirmation(
      `The plan has confidence ${input.confidence}. Do you want to proceed?`,
    );
    if (!confirmed) {
      return {
        text: "plan update cancelled by user",
        confirmed: false,
        askedConfirmation: true,
      };
    }
  }

  // Replace plan block
  await store.upsertBlock({
    sessionId,
    label: "plan",
    content,
    updatedBy: "agent",
  });

  // Build summary
  const done = items.filter((i) => i.status === "done").length;
  const blocked = items.filter((i) => i.status === "blocked").length;
  const total = items.length;
  let text = `plan updated: ${done}/${total} done`;
  if (blocked > 0) text += `, ${blocked} blocked`;

  return { text, confirmed, askedConfirmation };
}

// ── Prompt guidelines ──────────────────────────────────────────────

export const TODO_PROMPT_GUIDELINES = [
  "For non-trivial tasks, write a short plan with todo before acting, and state your confidence.",
];
