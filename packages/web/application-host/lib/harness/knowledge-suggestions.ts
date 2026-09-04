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

import type { KnowledgeStore, KnowledgeInput, KnowledgeScope, NodeId } from "../knowledge/store.js";

// ── Types ──────────────────────────────────────────────────────────

export type SuggestionTrigger = "user-mark" | "memory-agent" | "user-message";

export interface SuggestionInput {
  trigger: SuggestionTrigger;
  content: string;
  sessionId: string;
  kind: string;
  scope?: KnowledgeScope;
  recallTrigger?: string;
  /** Optional model to draft content/trigger */
  draftWithModel?: (prompt: string) => Promise<{ content: string; trigger: string }>;
}

export interface SuggestionResult {
  id: NodeId;
  content: string;
  trigger: string;
  status: "suggested" | "accepted";
  scope: KnowledgeScope;
}

export interface KnowledgeSuggestionsSettings {
  autoAcceptSuggestions: {
    workspace: boolean;
    user: boolean;
  };
}

export const DEFAULT_SUGGESTIONS_SETTINGS: KnowledgeSuggestionsSettings = {
  autoAcceptSuggestions: { workspace: false, user: false },
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
  let trigger = input.recallTrigger ?? "";
  const scope = input.scope ?? "workspace";

  // If model is configured, use it to draft content and trigger
  if (input.draftWithModel) {
    const drafted = await input.draftWithModel(
      `${SUGGESTION_PROMPT}\n\nUser message: ${input.content}`,
    );
    content = drafted.content;
    trigger = drafted.trigger;
  }

  const knowledgeInput: KnowledgeInput = {
    scope,
    status: "suggested",
    content,
    trigger,
    source: { sessionId: input.sessionId, kind: input.kind },
  };

  const id = await deps.store.putKnowledge(knowledgeInput);

  // Auto-accept if configured
  const autoAccepted = deps.settings.autoAcceptSuggestions[scope];
  if (autoAccepted) {
    await deps.store.acceptKnowledge(id, {});
  }

  return { id, content, trigger, scope, status: autoAccepted ? "accepted" : "suggested" };
}

// ── Supersedes suggestion ──────────────────────────────────────────

export async function suggestSupersedes(
  newId: NodeId,
  trigger: string,
  deps: SuggestionDeps,
  scope: KnowledgeScope = "workspace",
): Promise<NodeId[]> {
  if (!trigger) return [];

  const existing = await deps.store.listKnowledge({
    scope,
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
    if (score > 0) {
      suggestions.push({ id: k.id, score });
    }
  }

  return suggestions.sort((a, b) => b.score - a.score).map((s) => s.id);
}

// ── Review tray actions ────────────────────────────────────────────

export async function acceptSuggestion(
  id: NodeId,
  deps: SuggestionDeps,
  options: {
    supersedes?: NodeId[] | undefined;
    scope?: KnowledgeScope;
    edit?: { content: string; trigger: string; expectedContent: string; expectedTrigger: string };
  },
): Promise<void> {
  await deps.store.acceptKnowledge(id, {
    ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
    ...(options.scope === undefined ? {} : { expectedScope: options.scope }),
    ...(options.edit === undefined ? {} : { edit: options.edit }),
  });
}

export async function dismissSuggestion(
  id: NodeId,
  deps: SuggestionDeps,
  scope?: KnowledgeScope,
): Promise<void> {
  await deps.store.dismissKnowledge(id, scope);
}
