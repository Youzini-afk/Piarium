import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Pi places the active summary first, followed by the retained entry range.
 * When that range spans an earlier compaction entry, its superseded summary
 * also appears in the SDK projection. Keep only the active one for inference;
 * all entries, including old summaries, remain in the native session journal.
 */
export function activeCompactionMessages(messages: AgentMessage[]): AgentMessage[] {
  let hasSummary = false;
  return messages.filter((message) => {
    if (message.role !== "compactionSummary") return true;
    if (hasSummary) return false;
    hasSummary = true;
    return true;
  });
}
