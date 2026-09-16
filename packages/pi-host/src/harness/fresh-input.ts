import {
  sessionEntryToContextMessages,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  assembleFreshInput,
  type FreshInput,
} from "@piarium/protocol";

/**
 * fresh-input — construct the seed input for a fresh run over the same work.
 *
 * Plan: agent-harness-plan.md §2.6A (fresh input seam), consumed by §3.18B.
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
 * The section assembly lives in @piarium/protocol so the Application Host
 * builds the same input from protocol `PiSessionEntry`s; this wrapper mines
 * raw SDK `SessionEntry`s for pi-host-side use.
 */

export type { FreshInput } from "@piarium/protocol";

export interface FreshInputOptions {
  /** The current task statement, if the caller has one. */
  task?: string;
  /** Session goal/assist state still in force (verbatim). */
  goal?: string;
  /** Selected results/artifacts to carry (thread results, delta references). */
  results?: readonly string[];
  /** Open items: unfinished plan steps, todos, unresolved questions. */
  openItems?: readonly string[];
  /** Branch entries to mine for recent user requirements and anchors. */
  entries: readonly SessionEntry[];
  /** Recent user messages carried verbatim as still-valid requirements (default 3). */
  recentUserMessages?: number;
  /** Per-message excerpt cap in chars (default 2000). */
  excerptChars?: number;
}

function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as { type?: string; text?: string };
    if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
  }
  return parts.join("\n");
}

export function buildFreshInput(options: FreshInputOptions): FreshInput {
  const recentCount = Math.max(0, options.recentUserMessages ?? 3);

  // Recent user messages are carried verbatim: requirements and corrections
  // stay in the user's own words rather than a re-derived summary.
  const userEntries: { entryId: string; text: string }[] = [];
  const boundaryEntryIds: string[] = [];
  for (const entry of options.entries) {
    if (entry.type === "compaction") {
      if (entry.id) boundaryEntryIds.push(entry.id);
      continue;
    }
    if (entry.type !== "message" || !entry.id) continue;
    const messages = sessionEntryToContextMessages(entry);
    const user = messages.find((message) => message.role === "user");
    if (!user) continue;
    const text = messageText(user).trim();
    if (text.length > 0) userEntries.push({ entryId: entry.id, text });
  }

  return assembleFreshInput({
    ...(options.task !== undefined ? { task: options.task } : {}),
    ...(options.goal !== undefined ? { goal: options.goal } : {}),
    ...(options.results !== undefined ? { results: options.results } : {}),
    ...(options.openItems !== undefined ? { openItems: options.openItems } : {}),
    ...(options.excerptChars !== undefined ? { excerptChars: options.excerptChars } : {}),
    carriedUserMessages: userEntries.slice(-recentCount),
    boundaryEntryIds,
  });
}
