import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";

/**
 * When `models.suggestions` is configured, draft a knowledge proposal from the
 * current user message and store it through Host `knowledge.suggest`.
 * Unconfigured sessions keep the existing user-mark and keeper paths only.
 */
export interface KnowledgeSuggestionExtensionOptions {
  bridge: HostServicesBridge;
  getDraftWithModel?: () => ((prompt: string) => Promise<string>) | undefined;
  onError?: (error: unknown) => void;
}

export const USER_MESSAGE_SUGGESTION_PROMPT = [
  "Does this user message state a durable preference or correction that should apply to future sessions?",
  "Answer with JSON only: {\"content\":\"...\",\"trigger\":\"...\"} or null.",
  "If the message is a one-off task, question, or already-ephemeral instruction, return null.",
].join(" ");

export function parseSuggestionDraft(text: string): { content: string; trigger: string } | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "null") return null;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const raw = (fenced?.[1] ?? trimmed).trim();
  if (!raw || raw === "null") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.content === null && record.trigger === undefined) return null;
  const content = typeof record.content === "string" ? record.content.trim() : "";
  if (!content) return null;
  const trigger = typeof record.trigger === "string" ? record.trigger.trim() : "";
  return { content, trigger };
}

export function createKnowledgeSuggestionExtension(options: KnowledgeSuggestionExtensionOptions): ExtensionFactory {
  return (pi) => {
    const active = new Set<Promise<void>>();
    const track = (task: Promise<void>): void => {
      active.add(task);
      void task.catch((error) => options.onError?.(error)).finally(() => active.delete(task));
    };

    pi.on("before_agent_start", (event) => {
      const draftWithModel = options.getDraftWithModel?.();
      const text = typeof event.prompt === "string" ? event.prompt.trim() : "";
      if (!draftWithModel || !text) return;
      track((async () => {
        const raw = await draftWithModel(`${USER_MESSAGE_SUGGESTION_PROMPT}\n\nUser message: ${text}`);
        const drafted = parseSuggestionDraft(raw);
        if (!drafted) return;
        await options.bridge.request("knowledge.suggest", {
          content: drafted.content,
          trigger: drafted.trigger,
        });
      })());
    });
  };
}
