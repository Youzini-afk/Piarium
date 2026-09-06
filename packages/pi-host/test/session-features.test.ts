import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createSessionFeaturesExtension,
  mutateSessionFeatures,
  PIARIUM_SESSION_FEATURES_ENTRY_TYPE,
  PIARIUM_SESSION_MEMORY_MODE_ENTRY_TYPE,
  readSessionFeatures,
  SessionFeatureConflictError,
} from "../src/session-features.js";

describe("Piarium session features", () => {
  it("persists versioned branch-aware state without putting it in model context", () => {
    const manager = SessionManager.inMemory("/workspace");
    const userEntryId = manager.appendMessage({
      content: "Keep this architectural constraint",
      role: "user",
      timestamp: Date.now(),
    });
    const started = mutateSessionFeatures(
      manager,
      { objective: "Complete the native Pi migration", tokenBudget: 40_000, type: "goal.start" },
      { tokenBaseline: 125 },
    );
    assert.equal(started.goal?.objective, "Complete the native Pi migration");
    assert.equal(started.goal?.tokenBaseline, 125);
    assert.equal(started.goal?.tokenBudget, 40_000);
    assert.equal(started.revision, 1);

    assert.equal(
      manager.buildSessionContext().messages.some((message) => (
        message.role === "custom"
        && message.customType === PIARIUM_SESSION_FEATURES_ENTRY_TYPE
      )),
      false,
    );

    manager.branch(userEntryId);
    assert.deepEqual(readSessionFeatures(manager), {
      revision: 0,
      schemaVersion: 1,
    });
  });

  it("rejects stale goal writes and preserves newer assist payloads", () => {
    const manager = SessionManager.inMemory("/workspace");
    const started = mutateSessionFeatures(manager, {
      objective: "Goal A",
      type: "goal.start",
    });
    assert.throws(
      () => mutateSessionFeatures(manager, {
        goalId: "stale-goal",
        note: "stale",
        type: "goal.update",
      }),
      SessionFeatureConflictError,
    );
    const withAssist = mutateSessionFeatures(manager, {
      forEntryId: "assistant-2",
      recap: "Latest recap",
      suggestion: "Continue the implementation",
      type: "assist.set",
    });
    const unchanged = mutateSessionFeatures(manager, {
      field: "suggestion",
      forEntryId: "assistant-1",
      type: "assist.clear",
    });
    assert.equal(unchanged.revision, withAssist.revision);
    assert.equal(unchanged.assist?.suggestion, "Continue the implementation");
    assert.equal(unchanged.goal?.id, started.goal?.id);
  });

  it("ignores retired pinned-context data without discarding Goal or Assist state", () => {
    const manager = SessionManager.inMemory("/workspace");
    manager.appendCustomEntry(PIARIUM_SESSION_FEATURES_ENTRY_TYPE, {
      assist: {
        forEntryId: "assistant-1",
        generatedAt: 1,
        suggestion: "Continue",
      },
      pinnedContext: [{ entryId: "user-1", pinnedAt: 1, role: "user" }],
      revision: 7,
      schemaVersion: 1,
    });

    assert.deepEqual(readSessionFeatures(manager), {
      assist: {
        forEntryId: "assistant-1",
        generatedAt: 1,
        suggestion: "Continue",
      },
      revision: 7,
      schemaVersion: 1,
    });
  });

  it("keeps the memory override session-wide without importing goal or assist from another branch", () => {
    const manager = SessionManager.inMemory("/workspace");
    const root = manager.appendMessage({ content: "root", role: "user", timestamp: 1 });
    mutateSessionFeatures(manager, { objective: "branch A goal", type: "goal.start" });
    mutateSessionFeatures(manager, {
      forEntryId: "assistant-a",
      suggestion: "branch A suggestion",
      type: "assist.set",
    });
    const overridden = mutateSessionFeatures(manager, { mode: "off", type: "memory.mode.set" });
    assert.equal(overridden.memoryMode, "off");
    assert.ok(manager.getEntries().some((entry) => (
      entry.type === "custom" && entry.customType === PIARIUM_SESSION_MEMORY_MODE_ENTRY_TYPE
    )));

    manager.branch(root);
    assert.deepEqual(readSessionFeatures(manager), {
      memoryMode: "off",
      revision: overridden.revision,
      schemaVersion: 1,
    });
    const inherited = mutateSessionFeatures(manager, { mode: "inherit", type: "memory.mode.set" });
    assert.equal(inherited.memoryMode, undefined);
    assert.equal(inherited.goal, undefined);
    assert.equal(inherited.assist, undefined);
  });

  it("does not silently revive an older mode when the latest session override is malformed", () => {
    const manager = SessionManager.inMemory("/workspace");
    mutateSessionFeatures(manager, { mode: "assist", type: "memory.mode.set" });
    manager.appendCustomEntry(PIARIUM_SESSION_MEMORY_MODE_ENTRY_TYPE, {
      mode: "automatic",
      revision: 2,
      schemaVersion: 1,
    });
    assert.throws(() => readSessionFeatures(manager), /Stored session memory mode is malformed/);
  });

  it("injects only the active goal through the native Pi hook", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const api = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
    } as unknown as ExtensionAPI;
    await createSessionFeaturesExtension()(api);

    const manager = SessionManager.inMemory("/workspace");
    mutateSessionFeatures(manager, { objective: "Preserve every custom capability", type: "goal.start" });
    assert.equal(handlers.has("context"), false);

    const goalHandler = handlers.get("before_agent_start");
    assert.ok(goalHandler);
    const goalResult = await goalHandler(
      { systemPrompt: "base", type: "before_agent_start" },
      { sessionManager: manager } as unknown as ExtensionContext,
    ) as { message?: { customType: string; content: string; display: boolean }; systemPrompt?: string };
    // Zone 0 fix: the hook returns a message (Zone 2 append), not a systemPrompt modification.
    assert.equal(goalResult.systemPrompt, undefined);
    assert.ok(goalResult.message);
    assert.equal(goalResult.message.customType, "piarium-goal");
    assert.equal(goalResult.message.display, false);
    assert.match(goalResult.message.content, /Preserve every custom capability/);
  });
});
