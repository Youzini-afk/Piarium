import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import type { CompactionBeforeResult, CompactionAfterParams } from "@piarium/protocol";

/**
 * Compaction extension — hooks session_before_compact to take over
 * compaction with memory blocks + facts, and session_compact to notify
 * the host.
 *
 * Design: agent-harness.md §8.4.2–8.4.4
 * Plan: agent-harness-plan.md §2.6
 *
 * session_before_compact:
 *   Requests a custom compaction result from the host. If the host
 *   returns { summary, firstKeptEntryId, tokensBefore }, Pi skips its
 *   own LLM summarization and uses the provided result.
 *
 * session_compact:
 *   Notifies the host that compaction completed. The host can use this
 *   to trigger a memory agent pre-compaction refresh or update knowledge
 *   blocks.
 */
export interface CompactionExtensionOptions {
  bridge: HostServicesBridge;
  sessionId: string;
}

export function createCompactionExtension(options: CompactionExtensionOptions): ExtensionFactory {
  const { bridge, sessionId } = options;

  return (pi) => {
    pi.on("session_before_compact", async (event) => {
      try {
        const result = await bridge.request<"compaction.before">("compaction.before", {
          sessionId,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        }, { timeoutMs: 5_000, signal: event.signal });
        const compaction = result as CompactionBeforeResult;
        // Only return { compaction } when firstKeptEntryId is non-empty.
        // If the host returns unavailable (empty firstKeptEntryId), let
        // Pi do its own LLM summarization.
        if (compaction && compaction.summary && compaction.firstKeptEntryId) {
          return { compaction };
        }
      } catch {
        // If the host doesn't support compaction.before (unavailable or
        // not wired), let Pi do its own LLM summarization.
      }
      return undefined;
    });

    pi.on("session_compact", async (event) => {
      const compactionEntry = event.compactionEntry as {
        summary?: string;
        firstKeptEntryId?: string;
        tokensBefore?: number;
      } | undefined;
      try {
        await bridge.request<"compaction.after">("compaction.after", {
          sessionId,
          summary: compactionEntry?.summary ?? "",
          firstKeptEntryId: compactionEntry?.firstKeptEntryId ?? "",
          tokensBefore: compactionEntry?.tokensBefore ?? 0,
        } satisfies CompactionAfterParams, { timeoutMs: 5_000 });
      } catch {
        // Best-effort notification — ignore errors.
      }
    });
  };
}
