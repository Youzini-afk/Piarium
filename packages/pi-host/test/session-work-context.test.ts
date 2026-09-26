import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { commitSessionWorkContext, readSessionWorkContext, VARIN_WORK_CONTEXT_ENTRY_TYPE } from "../src/session-work-context.js";

const binding = { workspaceId: "workspace", authorityRoot: "/workspace", sessionRoot: "/workspace" };

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
