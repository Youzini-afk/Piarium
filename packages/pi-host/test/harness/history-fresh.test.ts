import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry, SessionMessageEntry, CompactionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { createHistoryTool } from "../../src/harness/history-tool.js";
import { assembleFreshInput, minePiBranchEntries, type FreshInputSeed } from "@varin/protocol";
import { projectSessionEntry } from "../../src/protocol-projector.js";

const buildFreshInput = ({ entries, recentUserMessages = 3, ...seed }: FreshInputSeed & {
  entries: SessionEntry[]; recentUserMessages?: number;
}) => assembleFreshInput({ ...seed, ...minePiBranchEntries(entries.map(projectSessionEntry), recentUserMessages) });

const userMessage = (text: string): AgentMessage => ({
  role: "user",
  content: text,
  timestamp: Date.now(),
} as AgentMessage);

const assistantMessage = (text: string): AgentMessage => ({
  role: "assistant",
  api: "faux",
  provider: "faux",
  model: "faux-1",
  content: [{ type: "text", text }],
  stopReason: "stop",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  timestamp: Date.now(),
} as unknown as AgentMessage);

const messageEntry = (id: string, parentId: string | null, message: AgentMessage): SessionMessageEntry => ({
  type: "message",
  id,
  parentId,
  timestamp: new Date().toISOString(),
  message,
});

const compactionEntry = (id: string, parentId: string, firstKeptEntryId: string): CompactionEntry => ({
  type: "compaction",
  id,
  parentId,
  timestamp: new Date().toISOString(),
  summary: "Summary of the first phase.",
  firstKeptEntryId,
  tokensBefore: 9000,
});

const branch = (): SessionEntry[] => [
  messageEntry("e1", null, userMessage("Inspect the repository layout and report the package map.")),
  messageEntry("e2", "e1", assistantMessage("I will list the directories first.")),
  messageEntry("e3", "e2", userMessage("Correction: skip the kernel directory, it is generated.")),
  compactionEntry("c1", "e3", "e4"),
  messageEntry("e4", "c1", assistantMessage("Continuing with the package list.")),
  messageEntry("e5", "e4", userMessage("Also compare the web bundle size.")),
];

const ctxFor = (entries: SessionEntry[]) => ({
  sessionManager: {
    getBranch: () => entries,
    getSessionId: () => "session-1",
  },
});

const runHistory = async (entries: SessionEntry[], params: Record<string, unknown>) => {
  const tool = createHistoryTool();
  const result = await tool.execute("call-1", params as never, undefined, undefined, ctxFor(entries) as never);
  return {
    text: (result.content as { text: string }[]).map((block) => block.text).join(""),
    details: result.details as Record<string, unknown>,
  };
};

describe("history tool", () => {
  it("overviews the branch with compaction boundaries when called without filters", async () => {
    const { text, details } = await runHistory(branch(), {});
    assert.match(text, /branch: 6 entries, 1 compaction boundary/);
    assert.match(text, /compaction c1 at #3 · firstKept=e4/);
    assert.equal(details.total, 6);
    assert.equal(details.compactions, 1);
  });

  it("finds summarized raw text by keyword that the live context no longer shows", async () => {
    const { text, details } = await runHistory(branch(), { query: "repository layout" });
    assert.match(text, /entry e1 · message\/user/);
    assert.match(text, /Inspect the repository layout/);
    assert.equal(details.matches, 1);
  });

  it("combines query and path filters, and reports misses honestly", async () => {
    const hit = await runHistory(branch(), { query: "skip the kernel", path: "kernel" });
    assert.match(hit.text, /entry e3 · message\/user/);
    const miss = await runHistory(branch(), { query: "nonexistent phrase" });
    assert.match(miss.text, /no matching entries/);
    assert.equal(miss.details.matches, 0);
  });

  it("reads a specific entry with neighbours by id", async () => {
    const { text, details } = await runHistory(branch(), { entry: "e3", before: 1, after: 1 });
    assert.match(text, /entry e2 · message\/assistant/);
    assert.match(text, /entry e3 · message\/user · .*target/);
    assert.match(text, /entry c1 · compaction/);
    assert.match(text, /firstKept=e4/);
    assert.deepEqual([details.from, details.to], [1, 3]);
  });

  it("reports an unknown entry id instead of inventing one", async () => {
    const { text, details } = await runHistory(branch(), { entry: "zzz" });
    assert.match(text, /no entry zzz/);
    assert.equal(details.found, false);
  });

  it("caps matches at limit and points at narrower queries", async () => {
    const { text, details } = await runHistory(branch(), { query: "the", limit: 2 });
    assert.equal(details.shown, 2);
    assert.match(text, /more match\(es\) — continue with offset: 2/);
  });
});

describe("production fresh input assembler", () => {
  it("carries task, recent verbatim user requirements, results, open items, and anchors", () => {
    const input = buildFreshInput({
      task: "Continue the package map report",
      entries: branch(),
      results: ["packages-map.md (draft at packages-map.md)"],
      openItems: ["web bundle comparison not started"],
    });
    assert.match(input.text, /## Task\nContinue the package map report/);
    // recentUserMessages defaults to 3 → e1, e3, e5 verbatim, newest order kept
    assert.match(input.text, /Inspect the repository layout/);
    assert.match(input.text, /Correction: skip the kernel directory/);
    assert.match(input.text, /compare the web bundle size/);
    assert.match(input.text, /## Selected results\n- packages-map\.md/);
    assert.match(input.text, /## Open items\n- web bundle comparison not started/);
    assert.match(input.text, /## History anchors/);
    assert.deepEqual(input.userMessageEntryIds, ["e1", "e3", "e5"]);
    assert.deepEqual(input.boundaryEntryIds, ["c1"]);
    assert.match(input.text, /- c1/);
  });

  it("selects messages without truncating requirements behind an inaccessible history promise", () => {
    const long = "x".repeat(5_000);
    const entries = [
      messageEntry("u1", null, userMessage("first requirement")),
      messageEntry("u2", "u1", userMessage("second requirement")),
      messageEntry("u3", "u2", userMessage(long)),
    ];
    const input = buildFreshInput({ entries, recentUserMessages: 2 });
    assert.deepEqual(input.userMessageEntryIds, ["u2", "u3"]);
    assert.ok(!input.text.includes("first requirement"));
    assert.ok(input.text.includes(long));
    assert.doesNotMatch(input.text, /truncated|full text via history/);
    assert.match(input.text, /current-session history tool cannot resolve/);
  });

  it("produces honest empty input when nothing carries over", () => {
    const input = buildFreshInput({ entries: [] });
    assert.equal(input.text, "");
    assert.deepEqual(input.userMessageEntryIds, []);
    assert.deepEqual(input.boundaryEntryIds, []);
  });

  it("falls back to the session goal when no explicit task is supplied", () => {
    const input = buildFreshInput({ goal: "Map the packages", entries: branch(), recentUserMessages: 0 });
    assert.match(input.text, /## Task\nMap the packages/);
    assert.deepEqual(input.userMessageEntryIds, [], "zero selects no prior user messages, not all of them");
    assert.doesNotMatch(input.text, /## Selected prior user statements/);
  });
});


describe("history pagination acceptance", () => {
  it("can reach every matching entry without guessing an unseen id", async () => {
    const entries = Array.from({ length: 11 }, (_, i) => messageEntry(
      `p${i}`, i === 0 ? null : `p${i - 1}`, userMessage("SAME-MARKER shared requirement"),
    ));
    const first = await runHistory(entries, { query: "SAME-MARKER", limit: 2 });
    assert.equal(first.details.nextOffset, 2);
    const second = await runHistory(entries, { query: "SAME-MARKER", offset: first.details.nextOffset, limit: 2 });
    assert.match(second.text, /entry p2 /);
    assert.ok(!second.text.includes("entry p0 "));
    const last = await runHistory(entries, { query: "SAME-MARKER", offset: 10, limit: 2 });
    assert.match(last.text, /entry p10 /);
    assert.equal(last.details.shown, 1);
    assert.equal(last.details.nextOffset, undefined);
    const end = await runHistory(entries, { query: "SAME-MARKER", offset: 11, limit: 2 });
    assert.equal(end.details.shown, 0);
    assert.match(end.text, /end of matching entries/);
  });
});
