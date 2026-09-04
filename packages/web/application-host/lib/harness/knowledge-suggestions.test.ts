import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../knowledge/store.js";
import {
  createSuggestion,
  suggestSupersedes,
  acceptSuggestion,
  dismissSuggestion,
  DEFAULT_SUGGESTIONS_SETTINGS,
} from "./knowledge-suggestions.js";

// Scratch stores live in the OS temp dir; see recall-tool.test.ts.
const TEST_DIR = join(tmpdir(), "piarium-test-suggestions");
function cleanup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
}

let store: KnowledgeStore;
let storeCounter = 0;

async function openStore() {
  storeCounter++;
  const dir = join(TEST_DIR, `store-${storeCounter}`);
  mkdirSync(dir, { recursive: true });
  return openWorkspaceKnowledge({
    dataDir: dir, hostId: "test-host", workspaceId: "ws-test", embedding: null,
  });
}

describe("createSuggestion", () => {
  beforeEach(async () => {
    cleanup();
    store = await openStore();
  });
  afterEach(async () => {
    await store.close();
    cleanup();
  });

  it("creates suggestion with raw content when no model", async () => {
    const result = await createSuggestion(
      { trigger: "user-mark", content: "Always use bun", sessionId: "s1", kind: "message" },
      { store, settings: DEFAULT_SUGGESTIONS_SETTINGS },
    );
    expect(result.status).toBe("suggested");
    expect(result.content).toBe("Always use bun");
    expect(result.trigger).toBe("");

    const list = await store.listKnowledge({ status: "suggested" });
    expect(list).toHaveLength(1);
  });

  it("uses model to draft content and trigger when provided", async () => {
    const result = await createSuggestion(
      {
        trigger: "user-message", content: "I prefer bun over npm",
        sessionId: "s1", kind: "message",
        draftWithModel: async () => ({ content: "Use bun for package management", trigger: "package management" }),
      },
      { store, settings: DEFAULT_SUGGESTIONS_SETTINGS },
    );
    expect(result.content).toBe("Use bun for package management");
    expect(result.trigger).toBe("package management");
  });

  it("auto-accepts when configured", async () => {
    await createSuggestion(
      { trigger: "user-mark", content: "Always use bun", sessionId: "s1", kind: "message" },
      { store, settings: { ...DEFAULT_SUGGESTIONS_SETTINGS, autoAcceptSuggestions: { workspace: true, user: false } } },
    );
    const accepted = await store.listKnowledge({ status: "accepted" });
    expect(accepted).toHaveLength(1);
  });
});

describe("suggestSupersedes", () => {
  beforeEach(async () => {
    cleanup();
    store = await openStore();
  });
  afterEach(async () => {
    await store.close();
    cleanup();
  });

  it("finds entries with similar trigger", async () => {
    const oldId = await store.putKnowledge({
      scope: "workspace", status: "accepted",
      content: "Use npm", trigger: "package management",
    });
    const newId = await store.putKnowledge({
      scope: "workspace", status: "suggested",
      content: "Use bun", trigger: "package management",
    });

    const suggestions = await suggestSupersedes(newId, "package management", {
      store, settings: DEFAULT_SUGGESTIONS_SETTINGS,
    });
    expect(suggestions).toContain(oldId);
  });

  it("returns empty for dissimilar triggers", async () => {
    await store.putKnowledge({
      scope: "workspace", status: "accepted",
      content: "Use vim", trigger: "editor preference",
    });
    const newId = await store.putKnowledge({
      scope: "workspace", status: "suggested",
      content: "Use bun", trigger: "package management",
    });

    const suggestions = await suggestSupersedes(newId, "package management", {
      store, settings: DEFAULT_SUGGESTIONS_SETTINGS,
    });
    expect(suggestions).toHaveLength(0);
  });

  it("returns empty for empty trigger", async () => {
    const suggestions = await suggestSupersedes(1, "", {
      store, settings: DEFAULT_SUGGESTIONS_SETTINGS,
    });
    expect(suggestions).toHaveLength(0);
  });
});

describe("review tray actions", () => {
  beforeEach(async () => {
    cleanup();
    store = await openStore();
  });
  afterEach(async () => {
    await store.close();
    cleanup();
  });

  it("acceptSuggestion moves to accepted", async () => {
    const id = await store.putKnowledge({
      scope: "workspace", status: "suggested",
      content: "test", trigger: "",
    });
    await acceptSuggestion(id, { store, settings: DEFAULT_SUGGESTIONS_SETTINGS }, {});
    const list = await store.listKnowledge({ status: "accepted" });
    expect(list).toHaveLength(1);
  });

  it("acceptSuggestion with supersedes", async () => {
    const oldId = await store.putKnowledge({
      scope: "workspace", status: "accepted",
      content: "old", trigger: "test",
    });
    const newId = await store.putKnowledge({
      scope: "workspace", status: "suggested",
      content: "new", trigger: "test",
    });
    await acceptSuggestion(newId, { store, settings: DEFAULT_SUGGESTIONS_SETTINGS }, { supersedes: [oldId] });
    const active = await store.listKnowledge({ activeOnly: true });
    expect(active.find((k) => k.id === oldId)).toBeUndefined();
    expect(active.find((k) => k.id === newId)).toBeDefined();
  });

  it("dismissSuggestion moves to dismissed", async () => {
    const id = await store.putKnowledge({
      scope: "workspace", status: "suggested",
      content: "test", trigger: "",
    });
    await dismissSuggestion(id, { store, settings: DEFAULT_SUGGESTIONS_SETTINGS });
    const list = await store.listKnowledge({ status: "dismissed" });
    expect(list).toHaveLength(1);
  });
});
