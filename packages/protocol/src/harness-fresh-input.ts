/**
 * fresh-input assembly — shared section structure for a `fresh` Run's seed
 * input (agent-harness-plan.md §2.6A, consumed by §3.18B).
 *
 * A fresh continuation is not a summary of the old transcript. The new input
 * carries: the current task and still-valid user requirements (verbatim
 * excerpts, not a model re-derivation), selected results, open items, and
 * history anchors — entry ids the new run can pull verbatim through the
 * public `history` tool. The original Pi history and WorkingState stay
 * untouched; stale verification is not replayed as if it passed on the new
 * revision. Callers publish the new generation only after this input is
 * fully built — no forced re-summarization of the old history.
 *
 * Both entry domains mine into this assembler: pi-host mines raw Pi SDK
 * `SessionEntry`s for in-session use, while the Application Host mines
 * protocol `PiSessionEntry`s for thread reruns.
 */

import type { PiSessionEntry, PiUserContent } from "./session.js";

export interface FreshInputCarriedMessage {
  entryId: string;
  text: string;
}

export interface FreshInputSeed {
  /** The current task statement, if the caller has one. */
  task?: string;
  /** Session goal/assist state still in force (verbatim). */
  goal?: string;
  /** Selected results/artifacts to carry (thread results, delta references). */
  results?: readonly string[];
  /** Open items: unfinished plan steps, todos, unresolved questions. */
  openItems?: readonly string[];
  /** User messages carried verbatim as still-valid requirements. */
  carriedUserMessages?: readonly FreshInputCarriedMessage[];
  /** Compaction boundary entry ids (readback anchors). */
  boundaryEntryIds?: readonly string[];
  /** Per-message excerpt cap in chars (default 2000). */
  excerptChars?: number;
}

export interface FreshInput {
  /** Structured markdown text for the new run's seed input. */
  text: string;
  /** Entry ids of the carried user messages (history anchors). */
  userMessageEntryIds: string[];
  /** Compaction boundary entry ids (readback anchors). */
  boundaryEntryIds: string[];
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated — full text via history]`;
}

export function assembleFreshInput(seed: FreshInputSeed): FreshInput {
  const excerptChars = Math.max(200, seed.excerptChars ?? 2_000);
  const carried = seed.carriedUserMessages ?? [];
  const boundaryEntryIds = [...(seed.boundaryEntryIds ?? [])];

  const sections: string[] = [];
  const task = seed.task?.trim() || seed.goal?.trim();
  if (task) sections.push(`## Task\n${task}`);
  if (carried.length > 0) {
    sections.push(
      `## Still-valid requirements and corrections\n`
      + carried.map((entry) => `- [entry ${entry.entryId}] ${clip(entry.text, excerptChars)}`).join("\n"),
    );
  }
  if (seed.results?.length) {
    sections.push(`## Selected results\n${seed.results.map((item) => `- ${item}`).join("\n")}`);
  }
  if (seed.openItems?.length) {
    sections.push(`## Open items\n${seed.openItems.map((item) => `- ${item}`).join("\n")}`);
  }
  const anchors = [...carried.map((entry) => entry.entryId), ...boundaryEntryIds];
  if (anchors.length > 0) {
    sections.push(
      `## History anchors\n`
      + `Earlier session entries remain readable verbatim with the history tool `
      + `(entry + before/after). Known anchors:\n`
      + anchors.map((id) => `- ${id}`).join("\n"),
    );
  }
  return {
    text: sections.join("\n\n"),
    userMessageEntryIds: carried.map((entry) => entry.entryId),
    boundaryEntryIds,
  };
}

// ── Protocol-entry mining ──────────────────────────────────────────

function userContentText(content: string | PiUserContent[]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * Mine protocol `PiSessionEntry`s (Host `session.entries` shape) for the
 * most recent user messages and compaction boundary ids.
 */
export function minePiBranchEntries(
  entries: readonly PiSessionEntry[],
  recentUserMessages = 3,
): { carriedUserMessages: FreshInputCarriedMessage[]; boundaryEntryIds: string[] } {
  const boundaryEntryIds: string[] = [];
  const userEntries: FreshInputCarriedMessage[] = [];
  for (const entry of entries) {
    if (entry.type === "compaction") {
      if (entry.id) boundaryEntryIds.push(entry.id);
      continue;
    }
    if (entry.type !== "message" || !entry.id || entry.message.role !== "user") continue;
    const text = userContentText(entry.message.content).trim();
    if (text.length > 0) userEntries.push({ entryId: entry.id, text });
  }
  return {
    carriedUserMessages: userEntries.slice(-Math.max(0, recentUserMessages)),
    boundaryEntryIds,
  };
}
