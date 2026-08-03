import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createSessionFeaturesExtension,
  mutateSessionFeatures,
  PIARIUM_PINNED_CONTEXT_MESSAGE_TYPE,
  PIARIUM_SESSION_FEATURES_ENTRY_TYPE,
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

    const pinned = mutateSessionFeatures(manager, {
      entryId: userEntryId,
      pinned: true,
      type: "context.set",
    });
    assert.deepEqual(pinned.pinnedContext.map((entry) => entry.entryId), [userEntryId]);
    assert.equal(
      manager.buildSessionContext().messages.some((message) => (
        message.role === "custom"
        && message.customType === PIARIUM_SESSION_FEATURES_ENTRY_TYPE
      )),
      false,
    );

    manager.branch(userEntryId);
    assert.deepEqual(readSessionFeatures(manager), {
      pinnedContext: [],
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

  it("injects missing pinned messages and the active goal through native Pi hooks", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const api = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
    } as unknown as ExtensionAPI;
    await createSessionFeaturesExtension()(api);

    const manager = SessionManager.inMemory("/workspace");
    const pinnedEntryId = manager.appendMessage({
      content: "Pinned evidence",
      role: "user",
      timestamp: Date.now(),
    });
    mutateSessionFeatures(manager, { entryId: pinnedEntryId, pinned: true, type: "context.set" });
    mutateSessionFeatures(manager, { objective: "Preserve every custom capability", type: "goal.start" });

    const sessionManager = {
      buildContextEntries: () => [],
      getBranch: () => manager.getBranch(),
      getEntry: (entryId: string) => manager.getEntry(entryId),
    };
    const contextHandler = handlers.get("context");
    assert.ok(contextHandler);
    const contextResult = await contextHandler(
      { messages: [], type: "context" },
      { sessionManager } as unknown as ExtensionContext,
    ) as { messages: Array<{ content: string; customType: string }> };
    assert.equal(contextResult.messages[0]?.customType, PIARIUM_PINNED_CONTEXT_MESSAGE_TYPE);
    assert.match(contextResult.messages[0]?.content ?? "", /Pinned evidence/);

    const goalHandler = handlers.get("before_agent_start");
    assert.ok(goalHandler);
    const goalResult = await goalHandler(
      { systemPrompt: "base", type: "before_agent_start" },
      { sessionManager } as unknown as ExtensionContext,
    ) as { systemPrompt: string };
    assert.match(goalResult.systemPrompt, /base/);
    assert.match(goalResult.systemPrompt, /Preserve every custom capability/);
  });
});
