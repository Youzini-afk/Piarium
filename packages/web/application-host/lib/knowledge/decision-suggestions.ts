import { createSuggestion, DEFAULT_SUGGESTIONS_SETTINGS } from "../harness/knowledge-suggestions.js";
import type { BlockChange, KnowledgeStore } from "./store.js";

export interface DecisionSuggestionRuntimeOptions {
  getStore(workspaceId: string): Promise<KnowledgeStore | null>;
  onChanged?(sessionId: string): void;
  onError?(error: unknown): void;
}

const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();

/** Only structured list entries are treated as decisions; prose is never guessed. */
export const decisionEntries = (content: string): string[] => content.split(/\r?\n/).flatMap((line) => {
  const trimmed = line.trim();
  const match = trimmed.match(/^(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+|decision\s*[:：]\s*)(.+)$/i);
  const entry = match ? normalize(match[1]!) : "";
  return entry ? [entry] : [];
});

export function createDecisionSuggestionRuntime(options: DecisionSuggestionRuntimeOptions) {
  const tails = new Map<string, Promise<void>>();
  const pending = new Set<Promise<void>>();
  let disposed = false;

  const process = async (workspaceId: string, sessionId: string, change: BlockChange): Promise<void> => {
    if (
      change.current?.label !== "decisions"
      || change.current.updatedBy !== "memory-agent"
    ) return;
    const before = new Set(decisionEntries(change.previous?.content ?? "").map((entry) => normalize(entry).toLowerCase()));
    const added = decisionEntries(change.current.content).filter((entry) => !before.has(normalize(entry).toLowerCase()));
    if (added.length === 0) return;
    const store = await options.getStore(workspaceId);
    if (!store) return;
    const existing = await store.listKnowledge({ scope: "workspace" });
    const seen = new Set(existing
      .filter((entry) => entry.source?.sessionId === sessionId && entry.source.kind === "memory-decision")
      .map((entry) => normalize(entry.content).toLowerCase()));
    let changed = false;
    for (const content of added) {
      const identity = normalize(content).toLowerCase();
      if (seen.has(identity)) continue;
      await createSuggestion({
        trigger: "memory-agent",
        content,
        sessionId,
        kind: "memory-decision",
        scope: "workspace",
      }, { store, settings: DEFAULT_SUGGESTIONS_SETTINGS });
      seen.add(identity);
      changed = true;
    }
    if (changed) options.onChanged?.(sessionId);
  };

  const observeBlockChange = (workspaceId: string, sessionId: string, change: BlockChange): void => {
    if (disposed) return;
    const key = `${workspaceId}\0${sessionId}`;
    const previous = tails.get(key) ?? Promise.resolve();
    const operation = previous.then(() => process(workspaceId, sessionId, change));
    const settled = operation.catch((error) => {
      try { options.onError?.(error); } catch { /* diagnostics cannot stop later suggestions */ }
    }).finally(() => {
      pending.delete(settled);
      if (tails.get(key) === settled) tails.delete(key);
    });
    tails.set(key, settled);
    pending.add(settled);
  };

  const drain = async (): Promise<void> => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    await drain();
    tails.clear();
  };

  return { observeBlockChange, drain, dispose };
}
