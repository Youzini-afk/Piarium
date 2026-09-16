import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { minePiBranchEntries } from "../src/harness-fresh-input.js";
import type { PiSessionEntry } from "../src/session.js";

const entries: PiSessionEntry[] = ["old", "middle", "new"].map((id, index, ids) => ({
  type: "message",
  id,
  parentId: ids[index - 1] ?? null,
  timestamp: "2026-09-16T00:00:00.000Z",
  message: { role: "user", content: `requirement ${id}`, timestamp: index },
}));

describe("fresh protocol input selection", () => {
  it("an explicit zero carries no user messages, not the whole old history", () => {
    assert.deepEqual(minePiBranchEntries(entries, 0).carriedUserMessages, []);
    assert.deepEqual(minePiBranchEntries(entries, -1).carriedUserMessages, []);
    assert.deepEqual(minePiBranchEntries(entries, 0.5).carriedUserMessages, []);
  });

  it("carries the requested most recent whole messages in source order", () => {
    assert.deepEqual(minePiBranchEntries(entries, 2).carriedUserMessages.map((entry) => entry.entryId), ["middle", "new"]);
    assert.deepEqual(minePiBranchEntries(entries).carriedUserMessages.map((entry) => entry.entryId), ["old", "middle", "new"]);
  });
});
