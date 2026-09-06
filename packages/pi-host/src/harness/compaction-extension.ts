import { sessionEntryToContextMessages, type ExtensionFactory, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import type { CompactionBeforeResult, CompactionAfterParams, HarnessMemoryMode } from "@piarium/protocol";

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
  getMode: () => HarnessMemoryMode;
  onFailure?: (message: string) => void;
  onSuccess?: () => void;
}

export function deriveCompactionCoverage(
  branchEntries: SessionEntry[],
  firstKeptEntryId: string,
): { branchEntryIds: string[]; removedEntryIds: string[] } | null {
  const branchEntryIds = branchEntries.map((entry) => entry.id);
  const firstKeptIndex = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
  if (firstKeptIndex < 0) return null;
  const previousCompactionIndex = branchEntries.findLastIndex((entry) => entry.type === "compaction");
  let boundaryStart = 0;
  if (previousCompactionIndex >= 0) {
    const previousCompaction = branchEntries[previousCompactionIndex]!;
    const previousFirstKept = previousCompaction.type === "compaction"
      ? branchEntries.findIndex((entry) => entry.id === previousCompaction.firstKeptEntryId)
      : -1;
    boundaryStart = previousFirstKept >= 0 ? previousFirstKept : previousCompactionIndex + 1;
  }
  const removedEntryIds = branchEntries
    .slice(boundaryStart, firstKeptIndex)
    .flatMap((entry) => (
      entry.type !== "compaction" && sessionEntryToContextMessages(entry).length > 0 ? [entry.id] : []
    ));
  return { branchEntryIds, removedEntryIds };
}

export function createCompactionExtension(options: CompactionExtensionOptions): ExtensionFactory {
  const { bridge } = options;

  return (pi) => {
    pi.on("session_before_compact", async (event) => {
      if (options.getMode() !== "takeover") return undefined;
      try {
        const firstKept = event.preparation.firstKeptEntryId;
        const coverage = deriveCompactionCoverage(event.branchEntries, firstKept);
        if (!coverage || coverage.removedEntryIds.length === 0) {
          options.onFailure?.(
            coverage
              ? "Pi reported no removable context entries for compaction coverage"
              : "Pi's kept entry is not on the active session branch",
          );
          return undefined;
        }
        const result = await bridge.request<"compaction.before">("compaction.before", {
          firstKeptEntryId: firstKept,
          tokensBefore: event.preparation.tokensBefore,
          branchEntryIds: coverage.branchEntryIds,
          removedEntryIds: coverage.removedEntryIds,
          mode: "takeover",
        }, { timeoutMs: 5_000, signal: event.signal });
        if (options.getMode() !== "takeover") return undefined;
        const compaction = result as CompactionBeforeResult;
        // Only return { compaction } when firstKeptEntryId is non-empty.
        // If the host returns unavailable (empty firstKeptEntryId), let
        // Pi do its own LLM summarization.
        if (compaction && compaction.summary && compaction.firstKeptEntryId) {
          options.onSuccess?.();
          return { compaction };
        }
        options.onFailure?.("Host returned an incomplete compaction result");
      } catch (error) {
        // If the host doesn't support compaction.before (unavailable or
        // not wired), let Pi do its own LLM summarization.
        if (options.getMode() === "takeover") {
          options.onFailure?.(error instanceof Error ? error.message : String(error));
        }
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
