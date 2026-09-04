import { describe, expect, it, vi } from "vitest";
import type { PiSessionEntry, SessionEntriesResult, TranscriptRef } from "@piarium/protocol";
import { createThreadTranscriptReader } from "./thread-transcript.js";

const entry = (id: string, parentId: string | null, text: string): PiSessionEntry => ({
  id,
  parentId,
  timestamp: "2026-09-04T00:00:00.000Z",
  type: "message",
  message: { role: "user", content: text, timestamp: 0 },
});

const entries: SessionEntriesResult = {
  sessionId: "child-1",
  scope: "all",
  leafId: "e4",
  entries: [
    entry("e1", null, "root"),
    entry("e2", "e1", "chosen branch"),
    entry("e3", "e1", "sibling branch"),
    entry("e4", "e2", "final result"),
  ],
};

const ref: TranscriptRef = {
  runtimeId: "pi",
  sessionId: "child-1",
  fromEntryId: "e2",
  toEntryId: "e4",
  branchLeafId: "e4",
};

describe("thread transcript reader", () => {
  it("reads only the referenced durable branch and range", async () => {
    const readSessionEntries = vi.fn(async () => entries);
    const reader = createThreadTranscriptReader({ readSessionEntries });
    const text = await reader.read(ref);
    expect(text).toContain("chosen branch");
    expect(text).toContain("final result");
    expect(text).not.toContain("sibling branch");
    expect(text).not.toContain("root");
    expect(readSessionEntries).toHaveBeenCalledWith("child-1");
  });

  it("uses since as an entry cursor", async () => {
    const reader = createThreadTranscriptReader({ readSessionEntries: async () => entries });
    const text = await reader.read(ref, 1);
    expect(text).toContain("entries 2–2 of 2");
    expect(text).not.toContain("chosen branch");
    expect(text).toContain("final result");
  });

  it("supports a migrated whole-branch reference", async () => {
    const reader = createThreadTranscriptReader({ readSessionEntries: async () => entries });
    const text = await reader.read({ runtimeId: "pi", sessionId: "child-1", fromEntryId: null, toEntryId: null });
    expect(text).toContain("root");
    expect(text).toContain("final result");
    expect(text).not.toContain("sibling branch");
  });

  it("reports unsupported runtimes and missing ranges distinctly", async () => {
    const reader = createThreadTranscriptReader({ readSessionEntries: async () => entries });
    await expect(reader.read({ ...ref, runtimeId: "other" })).rejects.toMatchObject({ harnessCode: "unavailable" });
    await expect(reader.read({ ...ref, fromEntryId: "missing" })).rejects.toMatchObject({ harnessCode: "not-found" });
  });
});
