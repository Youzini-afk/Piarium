/**
 * Knowledge suggestions — three triggers, review tray, dual-temporal supersedes.
 *
 * Design: agent-harness.md §7.2.2
 * Plan: agent-harness-plan.md §2.7
 *
 * Triggers (only these three, no heuristics):
 * 1. User "remember this" action on message/tool result/block entry
 * 2. Memory agent's decisions block new entries at turn end
 * 3. User message explicit pattern (only when models.suggestions configured)
 */

import type { KnowledgeStore, KnowledgeInput, NodeId } from "../knowledge/store.js";

// ── Types ──────────────────────────────────────────────────────────

export type SuggestionTrigger = "user-mark" | "memory-agent" | "user-message";

export interface SuggestionInput {
  trigger: SuggestionTrigger;
  content: string;
  sessionId: string;
  kind: string;
  /** Optional model to draft content/trigger */
  draftWithModel?: (prompt: string) => Promise<{ content: string; trigger: string }>;
}

export interface SuggestionResult {
  id: NodeId;
  content: string;
  trigger: string;
  status: "suggested";
}

export interface KnowledgeSuggestionsSettings {
  autoAcceptSuggestions: {
    workspace: boolean;
    user: boolean;
  };
  /** BM25 similarity threshold for suggesting supersedes */
  supersedesThreshold: number;
}

export const DEFAULT_SUGGESTIONS_SETTINGS: KnowledgeSuggestionsSettings = {
  autoAcceptSuggestions: { workspace: false, user: false },
  supersedesThreshold: 0.5,
};

// ── Suggestion creation ────────────────────────────────────────────

export interface SuggestionDeps {
  store: KnowledgeStore;
  settings: KnowledgeSuggestionsSettings;
}

const SUGGESTION_PROMPT = `Does this user message state a durable preference or correction that should apply to future sessions? Answer with a JSON suggestion or null`;

export async function createSuggestion(
  input: SuggestionInput,
  deps: SuggestionDeps,
): Promise<SuggestionResult> {
  let content = input.content;
  let trigger = "";

  // If model is configured, use it to draft content and trigger
  if (input.draftWithModel) {
    const drafted = await input.draftWithModel(
      `${SUGGESTION_PROMPT}\n\nUser message: ${input.content}`,
    );
    content = drafted.content;
    trigger = drafted.trigger;
  }

  const knowledgeInput: KnowledgeInput = {
    scope: "workspace",
    status: "suggested",
    content,
    trigger,
    source: { sessionId: input.sessionId, kind: input.kind },
  };

  const id = await deps.store.putKnowledge(knowledgeInput);

  // Auto-accept if configured
  if (deps.settings.autoAcceptSuggestions.workspace) {
    await deps.store.acceptKnowledge(id, {});
  }

  return { id, content, trigger, status: "suggested" };
}

// ── Supersedes suggestion ──────────────────────────────────────────

export async function suggestSupersedes(
  newId: NodeId,
  trigger: string,
  deps: SuggestionDeps,
): Promise<NodeId[]> {
  if (!trigger) return [];

  const existing = await deps.store.listKnowledge({
    scope: "workspace",
    status: "accepted",
    activeOnly: true,
  });

  // Simple BM25-like: find entries with similar trigger words
  const newTerms = new Set(trigger.toLowerCase().split(/\s+/).filter(Boolean));
  const suggestions: Array<{ id: NodeId; score: number }> = [];

  for (const k of existing) {
    if (k.id === newId) continue;
    const existingTerms = new Set(k.trigger.toLowerCase().split(/\s+/).filter(Boolean));
    let overlap = 0;
    for (const term of newTerms) {
      if (existingTerms.has(term)) overlap++;
    }
    const score = overlap / Math.max(newTerms.size, 1);
    if (score >= deps.settings.supersedesThreshold) {
      suggestions.push({ id: k.id, score });
    }
  }

  return suggestions.sort((a, b) => b.score - a.score).map((s) => s.id);
}

// ── Review tray actions ────────────────────────────────────────────

export async function acceptSuggestion(
  id: NodeId,
  deps: SuggestionDeps,
  options: { supersedes?: NodeId[] },
): Promise<void> {
  await deps.store.acceptKnowledge(id, { supersedes: options.supersedes });
}

export async function dismissSuggestion(
  id: NodeId,
  deps: SuggestionDeps,
): Promise<void> {
  await deps.store.dismissKnowledge(id);
}

export async function regenerateSuggestion(
  id: NodeId,
  originalContent: string,
  deps: SuggestionDeps,
  draftWithModel: (prompt: string) => Promise<{ content: string; trigger: string }>,
): Promise<SuggestionResult> {
  // Dismiss old, create new
  await deps.store.dismissKnowledge(id);
  return createSuggestion(
    { trigger: "user-mark", content: originalContent, sessionId: "", kind: "regenerate", draftWithModel },
    deps,
  );
}
