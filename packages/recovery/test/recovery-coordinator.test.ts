import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { SessionSnapshot } from "@piarium/protocol";
import { RecoveryCoordinator } from "../src/recovery-coordinator.js";

describe("RecoveryCoordinator", () => {
  it("previews, applies, undoes, and redoes a combined turn recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-recovery-coordinator-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "tracked.txt"), "before", "utf8");
    await writeFile(join(cwd, ".env"), "SECRET=preserved", "utf8");
    let leafId: string | null = null;
    const sessionId = "session-1";
    const coordinator = new RecoveryCoordinator({ agentDir, cwd });
    const snapshot = (): SessionSnapshot => ({
      activeTools: [],
      busy: false,
      cwd,
      sessionId,
      thinkingLevel: "off",
    });
    const navigate = async (targetLeafId: string) => {
      leafId = targetLeafId;
      return {
        cancelled: false,
        ...(targetLeafId === "user-1" ? { editorText: "prompt" } : {}),
      };
    };

    try {
      await coordinator.beginTurn(sessionId, null, false);
      await writeFile(join(cwd, "tracked.txt"), "after", "utf8");
      await writeFile(join(cwd, "created.txt"), "created", "utf8");
      leafId = "assistant-1";
      await coordinator.finishTurn({
        entries: [
          { id: "user-1", message: { role: "user" }, parentId: null, type: "message" },
          {
            id: "assistant-1",
            message: { role: "assistant" },
            parentId: "user-1",
            type: "message",
          },
        ],
        leafId,
        sessionId,
      });

      const listed = await coordinator.list(sessionId, leafId);
      assert.equal(listed.available, true);
      assert.equal(listed.turns.length, 1);
      const turn = listed.turns[0];
      assert.ok(turn);
      const preview = await coordinator.preview({
        currentLeafId: leafId,
        mode: "both",
        point: "before",
        sessionId,
        targetId: turn.id,
        targetKind: "turn",
      });
      assert.deepEqual(preview.changes, [
        { kind: "deleted", path: "created.txt" },
        { kind: "modified", path: "tracked.txt" },
      ]);

      const applied = await coordinator.apply({
        currentLeafId: leafId,
        navigate,
        planId: preview.planId,
        sessionId,
        snapshot,
      });
      assert.equal(applied.cancelled, false);
      assert.equal(applied.editorText, "prompt");
      assert.equal(leafId, "user-1");
      assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "before");
      await assert.rejects(readFile(join(cwd, "created.txt"), "utf8"), /ENOENT/);
      assert.equal(await readFile(join(cwd, ".env"), "utf8"), "SECRET=preserved");

      const afterApply = await coordinator.list(sessionId, leafId);
      assert.equal(afterApply.canUndo, true);
      await coordinator.undo({ currentLeafId: leafId, navigate, sessionId, snapshot });
      assert.equal(leafId, "assistant-1");
      assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "after");
      assert.equal(await readFile(join(cwd, "created.txt"), "utf8"), "created");

      const afterUndo = await coordinator.list(sessionId, leafId);
      assert.equal(afterUndo.canRedo, true);
      await coordinator.redo({ currentLeafId: leafId, navigate, sessionId, snapshot });
      assert.equal(leafId, "user-1");
      assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "before");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("invalidates a preview when workspace content changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-recovery-stale-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "tracked.txt"), "before", "utf8");
    const coordinator = new RecoveryCoordinator({ agentDir, cwd });
    const sessionId = "session-stale";
    try {
      await coordinator.beginTurn(sessionId, null, false);
      await writeFile(join(cwd, "tracked.txt"), "after", "utf8");
      await coordinator.finishTurn({
        entries: [{ id: "user", message: { role: "user" }, type: "message" }],
        leafId: "user",
        sessionId,
      });
      const turn = (await coordinator.list(sessionId, "user")).turns[0];
      assert.ok(turn);
      const preview = await coordinator.preview({
        currentLeafId: "user",
        mode: "files",
        point: "before",
        sessionId,
        targetId: turn.id,
        targetKind: "turn",
      });
      await writeFile(join(cwd, "tracked.txt"), "changed after preview", "utf8");
      await assert.rejects(
        coordinator.apply({
          currentLeafId: "user",
          navigate: async () => ({ cancelled: false }),
          planId: preview.planId,
          sessionId,
          snapshot: () => ({
            activeTools: [],
            busy: false,
            cwd,
            sessionId,
            thinkingLevel: "off",
          }),
        }),
        /Workspace changed after preview/,
      );
      assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "changed after preview");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rolls back an interrupted file restore when the conversation did not move", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-recovery-journal-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "tracked.txt"), "before", "utf8");
    const coordinator = new RecoveryCoordinator({ agentDir, cwd });
    const sessionId = "session-journal";
    try {
      await coordinator.beginTurn(sessionId, null, false);
      await writeFile(join(cwd, "tracked.txt"), "after", "utf8");
      await coordinator.finishTurn({
        entries: [
          { id: "user", message: { role: "user" }, type: "message" },
          { id: "assistant", message: { role: "assistant" }, type: "message" },
        ],
        leafId: "assistant",
        sessionId,
      });
      const turn = (await coordinator.list(sessionId, "assistant")).turns[0];
      assert.ok(turn);
      const shadow = new (await import("../src/shadow-git.js")).ShadowGitStore({
        cwd,
        excludePaths: [agentDir],
        root: join(coordinator.root, "shadow"),
      });
      await shadow.restore(turn.beforeCommit);
      const frame = {
        appliedAt: new Date().toISOString(),
        fromCommit: turn.afterCommit,
        fromLeafId: "assistant",
        id: "crash-frame",
        mode: "both",
        toCommit: turn.beforeCommit,
        toLeafId: "user",
      };
      await writeFile(
        join(coordinator.root, "transaction.json"),
        `${JSON.stringify({
          action: "apply",
          frame,
          historyFrame: frame,
          ownerPid: 999_999_999,
          phase: "files-restored",
          sessionId,
          version: 1,
        })}\n`,
        "utf8",
      );

      const recovered = await coordinator.list(sessionId, "assistant");
      assert.equal(recovered.available, true);
      assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "after");
      await assert.rejects(readFile(join(coordinator.root, "transaction.json"), "utf8"), /ENOENT/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("serializes checkpoint writers from independent coordinators", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-recovery-multiwriter-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "tracked.txt"), "stable", "utf8");
    const first = new RecoveryCoordinator({ agentDir, cwd });
    const second = new RecoveryCoordinator({ agentDir, cwd });
    const sessionId = "session-multiwriter";
    try {
      const checkpoints = await Promise.all([
        first.createCheckpoint(sessionId, null, "first"),
        second.createCheckpoint(sessionId, null, "second"),
      ]);
      assert.equal(new Set(checkpoints.map((entry) => entry.id)).size, 2);
      const listed = await first.list(sessionId, null);
      assert.deepEqual(
        new Set(listed.checkpoints.map((entry) => entry.name)),
        new Set(["first", "second"]),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
