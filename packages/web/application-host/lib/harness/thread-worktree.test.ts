import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createThreadWorktreeRuntime } from "./thread-worktree.js";

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const createRepo = (): { root: string; repo: string; worktrees: string } => {
  const root = mkdtempSync(join(tmpdir(), "thread-worktree-"));
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");
  fs.mkdirSync(repo);
  fs.mkdirSync(worktrees);
  git(repo, ["init"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  return { root, repo, worktrees };
};

const runtimeFor = (worktrees: string) => createThreadWorktreeRuntime({
  createWorktree: async (directory, input) => {
    const target = join(worktrees, String(input.worktreeName));
    git(directory, ["worktree", "add", "-b", String(input.branchName), target, String(input.startRef)]);
    return { path: target };
  },
  getWorktreeBootstrapStatus: async () => ({ status: "ready", phase: "setup-ready", error: null, updatedAt: Date.now() }),
});

describe("thread worktree runtime", () => {
  it("captures the parent working state as an internal baseline and merges only child deltas", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    let childPath = "";
    try {
      writeFileSync(join(fixture.repo, "tracked.txt"), "parent dirty\n");
      writeFileSync(join(fixture.repo, "parent-note.txt"), "untracked baseline\n");
      const prepared = await runtime.prepare({ mode: "isolated", sourceRoot: fixture.repo, threadId: "thread-one" });
      childPath = prepared.cwd;
      expect(prepared.worktree).not.toBeNull();
      expect(readFileSync(join(childPath, "tracked.txt"), "utf8")).toBe("parent dirty\n");
      expect(readFileSync(join(childPath, "parent-note.txt"), "utf8")).toBe("untracked baseline\n");
      expect(git(childPath, ["status", "--porcelain"])).toBe("");

      writeFileSync(join(childPath, "tracked.txt"), "child result\n");
      writeFileSync(join(childPath, "child-note.txt"), "new child file\n");
      const inspected = await runtime.inspect(prepared.worktree!);
      expect(inspected.changedFiles).toEqual(["tracked.txt", "child-note.txt"]);

      const merged = await runtime.merge(fixture.repo, prepared.worktree!);
      expect(merged.conflicts).toEqual([]);
      expect(merged.conflictState).toBe("none");
      expect(merged.merged).toBe(2);
      expect(readFileSync(join(fixture.repo, "tracked.txt"), "utf8")).toBe("child result\n");
      expect(readFileSync(join(fixture.repo, "child-note.txt"), "utf8")).toBe("new child file\n");
      expect(readFileSync(join(fixture.repo, "parent-note.txt"), "utf8")).toBe("untracked baseline\n");
    } finally {
      if (childPath) {
        try { git(fixture.repo, ["worktree", "remove", "--force", childPath]); } catch { /* test cleanup */ }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("returns the source workspace unchanged for shared and no-worktree roles", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    try {
      await expect(runtime.prepare({ mode: "shared", sourceRoot: fixture.repo, threadId: "shared" })).resolves.toEqual({
        cwd: fixture.repo,
        worktree: null,
      });
      await expect(runtime.prepare({ mode: "none", sourceRoot: fixture.repo, threadId: "none" })).resolves.toEqual({
        cwd: fixture.repo,
        worktree: null,
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not overwrite a different parent untracked file during merge", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    let childPath = "";
    try {
      const prepared = await runtime.prepare({ mode: "isolated", sourceRoot: fixture.repo, threadId: "thread-conflict" });
      childPath = prepared.cwd;
      writeFileSync(join(childPath, "new.txt"), "child\n");
      writeFileSync(join(fixture.repo, "new.txt"), "parent\n");
      const merged = await runtime.merge(fixture.repo, prepared.worktree!);
      expect(merged.conflicts).toEqual(["new.txt"]);
      expect(merged.conflictState).toBe("parent-unchanged");
      expect(readFileSync(join(fixture.repo, "new.txt"), "utf8")).toBe("parent\n");
    } finally {
      if (childPath) {
        try { git(fixture.repo, ["worktree", "remove", "--force", childPath]); } catch { /* test cleanup */ }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("preflights untracked conflicts before applying any tracked child changes", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    let childPath = "";
    try {
      const prepared = await runtime.prepare({ mode: "isolated", sourceRoot: fixture.repo, threadId: "thread-preflight" });
      childPath = prepared.cwd;
      writeFileSync(join(childPath, "tracked.txt"), "child tracked\n");
      writeFileSync(join(childPath, "new.txt"), "child untracked\n");
      writeFileSync(join(fixture.repo, "new.txt"), "parent untracked\n");

      const merged = await runtime.merge(fixture.repo, prepared.worktree!);
      expect(merged).toMatchObject({ conflicts: ["new.txt"], conflictState: "parent-unchanged", merged: 0 });
      expect(readFileSync(join(fixture.repo, "tracked.txt"), "utf8")).toBe("base\n");
      expect(readFileSync(join(fixture.repo, "new.txt"), "utf8")).toBe("parent untracked\n");
    } finally {
      if (childPath) {
        try { git(fixture.repo, ["worktree", "remove", "--force", childPath]); } catch { /* test cleanup */ }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("reports a tracked divergence without claiming conflict markers were written", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    let childPath = "";
    try {
      const prepared = await runtime.prepare({ mode: "isolated", sourceRoot: fixture.repo, threadId: "thread-tracked-conflict" });
      childPath = prepared.cwd;
      writeFileSync(join(childPath, "tracked.txt"), "child\n");
      writeFileSync(join(fixture.repo, "tracked.txt"), "parent\n");

      const merged = await runtime.merge(fixture.repo, prepared.worktree!);
      expect(merged).toMatchObject({ conflicts: ["tracked.txt"], conflictState: "parent-unchanged", merged: 0 });
      expect(readFileSync(join(fixture.repo, "tracked.txt"), "utf8")).toBe("parent\n");
    } finally {
      if (childPath) {
        try { git(fixture.repo, ["worktree", "remove", "--force", childPath]); } catch { /* test cleanup */ }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
