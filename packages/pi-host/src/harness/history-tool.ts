import { Type } from "typebox";
import {
  defineTool,
  sessionEntryToContextMessages,
  type SessionEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * history — read back raw session entries the live context no longer shows.
 *
 * Plan: agent-harness-plan.md §2.6A (history readback).
 *
 * After a compaction boundary the original Pi entries stay in the session
 * log; this tool lets the agent locate and re-read them by keyword, path,
 * or entry id with neighbouring context. It operates on the session's own
 * branch via ctx.sessionManager — a child session can only ever see its own
 * entries, so the tool never exposes a parent's transcript. Parent material
 * reaches a child only through explicit inheritance/fresh input.
 *
 * Result size is bounded by `limit`; oversized output goes through the
 * shared tool-result truncation, which stores an ephemeral out_ handle.
 * That handle expires — the entries themselves remain permanently readable
 * by repeating the query or fetching `entry` with before/after.
 */

const MAX_NEIGHBOURS = 20;
const MAX_MATCHES = 50;
const DEFAULT_LIMIT = 8;

const HistoryParams = Type.Object({
  query: Type.Optional(Type.String({
    description: "Case-insensitive substring matched against each entry's text.",
  })),
  path: Type.Optional(Type.String({
    description: "Restrict matches to entries whose text mentions this path fragment.",
  })),
  entry: Type.Optional(Type.String({
    description: "Entry id to read directly. Combine with before/after for neighbouring entries.",
  })),
  before: Type.Optional(Type.Integer({
    minimum: 0, maximum: MAX_NEIGHBOURS,
    description: "Entries before the target to include (with `entry`, default 0).",
  })),
  after: Type.Optional(Type.Integer({
    minimum: 0, maximum: MAX_NEIGHBOURS,
    description: "Entries after the target to include (with `entry`, default 0).",
  })),
  limit: Type.Optional(Type.Integer({
    minimum: 1, maximum: MAX_MATCHES,
    description: `Maximum matching entries to return (default ${DEFAULT_LIMIT}).`,
  })),
});

function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
    else if (typed.type === "thinking" && typeof typed.thinking === "string") parts.push(typed.thinking);
    else if (typed.type === "toolCall") {
      parts.push(`[toolCall ${typed.name ?? "?"} ${JSON.stringify(typed.arguments ?? {})}]`);
    } else if (typed.type === "toolResult") {
      const result = block as { toolName?: string; content?: unknown };
      const inner = typeof result.content === "string" ? result.content : "";
      parts.push(`[toolResult ${result.toolName ?? "?"}]${inner ? ` ${inner}` : ""}`);
    }
  }
  return parts.join("\n");
}

function entryText(entry: SessionEntry): { role: string; text: string } {
  if (entry.type === "compaction") {
    const compact = entry as { summary?: string; firstKeptEntryId?: string };
    return {
      role: "compaction",
      text: `[summary boundary · firstKept=${compact.firstKeptEntryId ?? "?"}]\n${compact.summary ?? ""}`,
    };
  }
  const messages = sessionEntryToContextMessages(entry);
  if (messages.length > 0) {
    const first = messages[0]!;
    const role = first.role ?? entry.type;
    const text = messages.map((message) => messageText(message)).filter((t) => t.length > 0).join("\n");
    return { role, text };
  }
  // Non-context entries still carry searchable metadata.
  const rest = { ...entry } as Record<string, unknown>;
  delete rest.id;
  delete rest.parentId;
  delete rest.timestamp;
  delete rest.type;
  return { role: entry.type, text: JSON.stringify(rest) };
}

function formatEntry(entry: SessionEntry, marker?: string): string {
  const { role, text } = entryText(entry);
  const head = `[entry ${entry.id} · ${entry.type}${role !== entry.type ? `/${role}` : ""} · ${entry.timestamp}${marker ? ` · ${marker}` : ""}]`;
  return text.length > 0 ? `${head}\n${text}` : head;
}

export function createHistoryTool(): ToolDefinition {
  return defineTool({
    name: "history",
    label: "History",
    description:
      "Read raw entries from this session's log that the live context no longer shows "
      + "(e.g. text replaced by a compaction summary). Search by keyword or path, "
      + "or read one entry id with neighbours.",
    promptSnippet: "history: re-read summarized or earlier session entries by keyword, path, or entry id",
    promptGuidelines: [
      "Use history when a summary refers to earlier detail you need verbatim — errors, identifiers, code, decisions. The original entries are never deleted; the summary is a view, not a replacement.",
      "Call history with a query or path to locate entries, then with entry + before/after to read around a specific entry id.",
      "Large results are paged through an ephemeral out_ handle via get_output; that handle expires. The entries themselves stay readable — repeat the query or fetch the entry id again instead of relying on the handle long-term.",
      "history reads this session's own log only. It cannot show another thread's or the parent session's transcript.",
    ],
    parameters: HistoryParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const entries = ctx.sessionManager.getBranch();
      const limit = params.limit ?? DEFAULT_LIMIT;
      const before = params.before ?? 0;
      const after = params.after ?? 0;

      if (params.entry !== undefined) {
        const index = entries.findIndex((entry) => entry.id === params.entry);
        if (index < 0) {
          return {
            content: [{ type: "text", text: `history: no entry ${params.entry} in this branch` }],
            details: { found: false, entry: params.entry },
          };
        }
        const from = Math.max(0, index - before);
        const to = Math.min(entries.length - 1, index + after);
        const lines: string[] = [];
        for (let i = from; i <= to; i++) {
          lines.push(formatEntry(entries[i]!, i === index ? "target" : undefined));
        }
        return {
          content: [{ type: "text", text: lines.join("\n\n") }],
          details: { found: true, entry: params.entry, from, to, total: entries.length },
        };
      }

      if (params.query === undefined && params.path === undefined) {
        // Overview: branch size and compaction boundaries — the regions whose
        // original text the live context replaced with summaries.
        const boundaries = entries
          .map((entry, index) => ({ entry, index }))
          .filter(({ entry }) => entry.type === "compaction");
        const lines = [
          `branch: ${entries.length} entries, ${boundaries.length} compaction boundary(ies)`,
        ];
        for (const { entry, index } of boundaries) {
          const compact = entry as { summary?: string; firstKeptEntryId?: string };
          const head = (compact.summary ?? "").split("\n")[0] ?? "";
          lines.push(`[compaction ${entry.id} at #${index} · firstKept=${compact.firstKeptEntryId ?? "?"}] ${head.slice(0, 160)}`);
        }
        lines.push("Search with query/path, or read one entry id with before/after.");
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { total: entries.length, compactions: boundaries.length },
        };
      }

      const query = params.query?.toLowerCase();
      const path = params.path?.toLowerCase();
      const matches: { entry: SessionEntry; index: number }[] = [];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        const { text } = entryText(entry);
        const haystack = text.toLowerCase();
        if (query !== undefined && !haystack.includes(query)) continue;
        if (path !== undefined && !haystack.includes(path)) continue;
        matches.push({ entry, index: i });
      }
      if (matches.length === 0) {
        return {
          content: [{ type: "text", text: "history: no matching entries" }],
          details: { matches: 0, total: entries.length },
        };
      }
      const shown = matches.slice(0, limit);
      const lines = shown.map(({ entry, index }) => formatEntry(entry, `#${index}`));
      if (matches.length > shown.length) {
        lines.push(`[${matches.length - shown.length} more match(es) — narrow the query or fetch by entry id]`);
      }
      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
        details: { matches: matches.length, shown: shown.length, total: entries.length },
      };
    },
  });
}
