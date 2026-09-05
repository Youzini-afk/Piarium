import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { deriveCompactionCoverage } from "../../src/harness/compaction-extension.js";

const message = (id: string, parentId: string | null, role: "user" | "assistant"): SessionEntry => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-09-05T00:00:00.000Z",
  message: role === "user"
    ? { role, content: id, timestamp: 1 }
    : {
        role,
        content: [{ type: "text", text: id }],
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: 1,
      },
} as SessionEntry);

describe("compaction coverage derivation", () => {
  it("uses the first-compaction boundary and ignores entries that do not enter context", () => {
    const entries = [
      message("e1", null, "user"),
      { type: "model_change", id: "model", parentId: "e1", timestamp: "2026-09-05T00:00:00.000Z", provider: "p", modelId: "m" } as SessionEntry,
      message("e2", "model", "assistant"),
      message("e3", "e2", "user"),
    ];
    assert.deepEqual(deriveCompactionCoverage(entries, "e3"), {
      branchEntryIds: ["e1", "model", "e2", "e3"],
      removedEntryIds: ["e1", "e2"],
    });
  });

  it("starts a later compaction at the previous first-kept entry and excludes the old summary entry", () => {
    const entries = [
      message("old", null, "user"),
      message("kept", "old", "assistant"),
      {
        type: "compaction",
        id: "compact-1",
        parentId: "kept",
        timestamp: "2026-09-05T00:00:00.000Z",
        summary: "previous",
        firstKeptEntryId: "kept",
        tokensBefore: 100,
      } as SessionEntry,
      message("next", "compact-1", "user"),
      message("future", "next", "assistant"),
    ];
    assert.deepEqual(deriveCompactionCoverage(entries, "future"), {
      branchEntryIds: ["old", "kept", "compact-1", "next", "future"],
      removedEntryIds: ["kept", "next"],
    });
  });

  it("fails closed when Pi's kept entry is not on the supplied branch", () => {
    assert.equal(deriveCompactionCoverage([message("e1", null, "user")], "missing"), null);
  });
});
