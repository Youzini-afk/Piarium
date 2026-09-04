import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDecisionSuggestionRuntime, decisionEntries } from "./decision-suggestions.js";
import { openWorkspaceKnowledge, type BlockChange, type KnowledgeStore } from "./store.js";

const TEST_DIR = join(tmpdir(), "piarium-decision-suggestions");

describe("decision suggestion runtime", () => {
  let store: KnowledgeStore;
  let publish = (_sessionId: string, _change: BlockChange): void => undefined;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = await openWorkspaceKnowledge({
      dataDir: TEST_DIR,
      hostId: "host",
      workspaceId: "workspace",
      embedding: null,
      onBlocksChanged: (sessionId, change) => publish(sessionId, change),
    });
  });

  afterEach(async () => {
    publish = () => undefined;
    await store.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("extracts only explicit list or Decision entries", () => {
    expect(decisionEntries("Notes\n- Use WAL\n2. Keep history\nDecision: Prefer typed errors\nplain prose"))
      .toEqual(["Use WAL", "Keep history", "Prefer typed errors"]);
  });

  it("turns new memory decisions into review-only suggestions without repeating history", async () => {
    const changed: string[] = [];
    const runtime = createDecisionSuggestionRuntime({
      getStore: async () => store,
      onChanged: (sessionId) => { changed.push(sessionId); },
    });
    publish = (sessionId, change) => runtime.observeBlockChange("workspace", sessionId, change);
    try {
      await store.upsertBlock({ sessionId: "s1", label: "progress", content: "- not a decision", updatedBy: "memory-agent" });
      await store.upsertBlock({ sessionId: "s1", label: "decisions", content: "- Use WAL\n- Keep history", updatedBy: "memory-agent" });
      await runtime.drain();
      const initial = await store.listKnowledge({ scope: "workspace", status: "suggested" });
      expect(initial.map((entry) => entry.content).toSorted()).toEqual(["Keep history", "Use WAL"]);
      expect(initial.every((entry) => entry.trigger === "" && entry.source?.sessionId === "s1" && entry.source.kind === "memory-decision")).toBe(true);

      await store.upsertBlock({ sessionId: "s1", label: "decisions", content: "- Use WAL\n- Keep history\n- Prefer typed errors", updatedBy: "memory-agent" });
      await runtime.drain();
      expect(await store.listKnowledge({ scope: "workspace", status: "suggested" })).toHaveLength(3);

      // Removing and later re-adding a dismissed decision must not recreate it.
      const useWal = (await store.listKnowledge({ scope: "workspace" })).find((entry) => entry.content === "Use WAL")!;
      await store.dismissKnowledge(useWal.id, "workspace");
      await store.upsertBlock({ sessionId: "s1", label: "decisions", content: "- Keep history", updatedBy: "memory-agent" });
      await store.upsertBlock({ sessionId: "s1", label: "decisions", content: "- Keep history\n- Use WAL", updatedBy: "memory-agent" });
      await runtime.drain();
      expect((await store.listKnowledge({ scope: "workspace" })).filter((entry) => entry.content === "Use WAL")).toHaveLength(1);
      expect(changed).toEqual(["s1", "s1"]);
    } finally {
      await runtime.dispose();
    }
  });

  it("ignores user-owned decisions blocks", async () => {
    const runtime = createDecisionSuggestionRuntime({ getStore: async () => store });
    publish = (sessionId, change) => runtime.observeBlockChange("workspace", sessionId, change);
    try {
      await store.upsertBlock({ sessionId: "s1", label: "decisions", content: "- User note", updatedBy: "user" });
      await runtime.drain();
      expect(await store.listKnowledge({ scope: "workspace" })).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });
});
