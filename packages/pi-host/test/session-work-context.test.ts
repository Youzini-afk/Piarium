import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { commitSessionWorkContext, initializeSessionWorkContext, readSessionWorkContext, VARIN_WORK_CONTEXT_ENTRY_TYPE } from "../src/session-work-context.js";

const binding = { workspaceId: "workspace", authorityRoot: "/workspace", sessionRoot: "/workspace" };

test("a child starts with its own durable context and later branch changes stay local", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-child-work-context-"));
  try {
    const manager = SessionManager.create(root, join(root, "sessions"));
    initializeSessionWorkContext(manager, {
      workspaceId: "child-workspace", authorityRoot: root, sessionRoot: root,
      operationDir: "project-a", queryScope: ["project-a/src"], revision: 1,
    });
    const seeded = readSessionWorkContext(manager);
    assert.equal(seeded.context?.operationDir, "project-a");
    assert.deepEqual(seeded.context?.queryScope, ["project-a/src"]);
    const parentMarker = manager.appendCustomEntry("parent-note", { text: "unrelated" });
    commitSessionWorkContext(manager, {
      sessionId: manager.getSessionId(), expectedLeafId: parentMarker, expectedRevision: 1,
      context: { workspaceId: "child-workspace", authorityRoot: root, sessionRoot: root,
        operationDir: "project-b", queryScope: null, revision: 2 },
    });
    assert.equal(readSessionWorkContext(manager).context?.operationDir, "project-b");
    // Pi intentionally delays the JSONL write until an assistant turn exists.
    manager.appendMessage({ role: "assistant", api: "test", provider: "test", model: "test",
      content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    const reopened = SessionManager.open(sessionFile, undefined, root);
    assert.equal(readSessionWorkContext(reopened).context?.operationDir, "project-b");
    reopened.branch(seeded.entryId!);
    assert.equal(readSessionWorkContext(reopened).context?.operationDir, "project-a");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("work context follows the active Pi branch and exact-leaf CAS", () => {
  const manager = SessionManager.inMemory("/workspace");
  const first = manager.appendCustomEntry("other", { note: "fork point" });
  const initial = readSessionWorkContext(manager);
  assert.equal(initial.leafId, first);
  assert.equal(initial.context, null);

  const selected = commitSessionWorkContext(manager, {
    sessionId: manager.getSessionId(), expectedLeafId: first, expectedRevision: 0,
    context: { ...binding, operationDir: "project-a", queryScope: null, revision: 1 },
  });
  assert.equal(selected.context?.operationDir, "project-a");
  assert.equal(readSessionWorkContext(manager).context?.revision, 1);
  assert.throws(() => commitSessionWorkContext(manager, {
    sessionId: manager.getSessionId(), expectedLeafId: first, expectedRevision: 0,
    context: { ...binding, operationDir: "project-b", queryScope: null, revision: 1 },
  }), /branch changed/);

  manager.branch(first);
  assert.equal(readSessionWorkContext(manager).context, null);
  const sibling = commitSessionWorkContext(manager, {
    sessionId: manager.getSessionId(), expectedLeafId: first, expectedRevision: 0,
    context: { ...binding, operationDir: "project-b", queryScope: ["project-b"], revision: 1 },
  });
  assert.equal(sibling.context?.operationDir, "project-b");
  manager.branch(selected.leafId!);
  assert.equal(readSessionWorkContext(manager).context?.operationDir, "project-a");
  manager.branch(sibling.leafId!);
  assert.equal(readSessionWorkContext(manager).context?.operationDir, "project-b");
});

test("corrupt active-branch entry is explicit and never falls back to an ancestor", () => {
  const manager = SessionManager.inMemory("/workspace");
  const initial = readSessionWorkContext(manager);
  commitSessionWorkContext(manager, {
    sessionId: manager.getSessionId(), expectedLeafId: initial.leafId, expectedRevision: 0,
    context: { ...binding, operationDir: "project-a", queryScope: null, revision: 1 },
  });
  manager.appendCustomEntry(VARIN_WORK_CONTEXT_ENTRY_TYPE, { operationDir: "" });
  assert.throws(() => readSessionWorkContext(manager), /invalid work-context entry/);
});

test("native compaction keeps the branch's work-context marker in its ancestry", () => {
  const manager = SessionManager.inMemory("/workspace");
  manager.appendMessage({ role: "user", content: "first task", timestamp: 1 });
  const initial = readSessionWorkContext(manager);
  const selected = commitSessionWorkContext(manager, {
    sessionId: manager.getSessionId(), expectedLeafId: initial.leafId, expectedRevision: 0,
    context: { ...binding, operationDir: "project-a", queryScope: null, revision: 1 },
  });
  const kept = manager.appendMessage({ role: "user", content: "continue", timestamp: 2 });
  manager.appendCompaction("summary", kept, 100);
  const restored = readSessionWorkContext(manager);
  assert.equal(restored.entryId, selected.entryId);
  assert.equal(restored.context?.operationDir, "project-a");
});
