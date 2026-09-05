import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
    if (input.mode === "existing") {
      git(directory, ["worktree", "add", "--force", target, String(input.branchName ?? input.startRef)]);
    } else {
      git(directory, ["worktree", "add", "-b", String(input.branchName), target, String(input.startRef)]);
    }
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
      const snapshotted = await runtime.snapshot(prepared.worktree!);
      expect(snapshotted.branch).toBe("piarium/thread-one");
      expect(snapshotted.resultCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(git(childPath, ["status", "--porcelain"])).toBe("");
      const inspected = await runtime.inspect(snapshotted);
      expect(inspected.changedFiles.toSorted()).toEqual(["child-note.txt", "tracked.txt"]);

      const merged = await runtime.merge(fixture.repo, snapshotted);
      expect(merged.conflicts).toEqual([]);
      expect(merged.conflictState).toBe("none");
      expect(merged.merged).toBe(2);
      expect(readFileSync(join(fixture.repo, "tracked.txt"), "utf8")).toBe("child result\n");
      expect(readFileSync(join(fixture.repo, "child-note.txt"), "utf8")).toBe("new child file\n");
      expect(readFileSync(join(fixture.repo, "parent-note.txt"), "utf8")).toBe("untracked baseline\n");
      expect(git(fixture.repo, ["rev-parse", `${snapshotted.branch}^{commit}`])).toBe(snapshotted.resultCommit);
      expect(existsSync(childPath)).toBe(true);
    } finally {
      if (childPath && existsSync(childPath)) {
        try { git(fixture.repo, ["worktree", "remove", "--force", childPath]); } catch { /* test cleanup */ }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 25_000);

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

  it.skipIf(process.platform === "win32")("preserves a relative child symlink without dereferencing it into the parent", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    let childPath = "";
    try {
      const prepared = await runtime.prepare({ mode: "isolated", sourceRoot: fixture.repo, threadId: "thread-symlink" });
      childPath = prepared.cwd;
      fs.symlinkSync("tracked.txt", join(childPath, "linked.txt"));
      const snapshotted = await runtime.snapshot(prepared.worktree!);
      const merged = await runtime.merge(fixture.repo, snapshotted);
      expect(merged).toMatchObject({ conflicts: [], merged: 1 });
      expect(fs.lstatSync(join(fixture.repo, "linked.txt")).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(join(fixture.repo, "linked.txt"))).toBe("tracked.txt");
    } finally {
      if (childPath && existsSync(childPath)) {
        try { git(fixture.repo, ["worktree", "remove", "--force", childPath]); } catch { /* test cleanup */ }
      }
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
      if (childPath && existsSync(childPath)) {
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

      const snapshotted = await runtime.snapshot(prepared.worktree!);
      const merged = await runtime.merge(fixture.repo, snapshotted);
      expect(merged).toMatchObject({ conflicts: ["new.txt"], conflictState: "parent-unchanged", merged: 0 });
      expect(readFileSync(join(fixture.repo, "tracked.txt"), "utf8")).toBe("base\n");
      expect(readFileSync(join(fixture.repo, "new.txt"), "utf8")).toBe("parent untracked\n");
    } finally {
      if (childPath && existsSync(childPath)) {
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
      if (childPath && existsSync(childPath)) {
        try { git(fixture.repo, ["worktree", "remove", "--force", childPath]); } catch { /* test cleanup */ }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("consumes fixed result commit and ignores post-snapshot live modifications", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    let childPath = "";
    try {
      const prepared = await runtime.prepare({ mode: "isolated", sourceRoot: fixture.repo, threadId: "thread-fixed-rev" });
      childPath = prepared.cwd;
      writeFileSync(join(childPath, "tracked.txt"), "clean child tracked\n");
      writeFileSync(join(childPath, "new.txt"), "clean child new\n");
      const binaryPayload = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff]);
      fs.writeFileSync(join(childPath, "binary.bin"), binaryPayload);

      const snapshotted = await runtime.snapshot(prepared.worktree!);
      expect(snapshotted.resultCommit).toBeDefined();

      // Post-snapshot live modifications: dirty changes, new files, binary alterations
      writeFileSync(join(childPath, "tracked.txt"), "DIRTY LIVE TRACKED\n");
      writeFileSync(join(childPath, "new.txt"), "DIRTY LIVE NEW\n");
      writeFileSync(join(childPath, "leak.txt"), "SHOULD NEVER LEAK\n");
      fs.writeFileSync(join(childPath, "binary.bin"), Buffer.from([0xde, 0xad, 0xbe, 0xef]));

      const inspected = await runtime.inspect(snapshotted);
      expect(inspected.changedFiles.toSorted()).toEqual(["binary.bin", "new.txt", "tracked.txt"]);

      const merged = await runtime.merge(fixture.repo, snapshotted);
      expect(merged.conflicts).toEqual([]);
      expect(merged.conflictState).toBe("none");
      expect(merged.merged).toBe(3);

      expect(readFileSync(join(fixture.repo, "tracked.txt"), "utf8")).toBe("clean child tracked\n");
      expect(readFileSync(join(fixture.repo, "new.txt"), "utf8")).toBe("clean child new\n");
      expect(fs.readFileSync(join(fixture.repo, "binary.bin"))).toEqual(binaryPayload);
      expect(existsSync(join(fixture.repo, "leak.txt"))).toBe(false);
    } finally {
      if (childPath && existsSync(childPath)) {
        try { git(fixture.repo, ["worktree", "remove", "--force", childPath]); } catch { /* test cleanup */ }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("reclaims directory after snapshot and rematerializes at the same path", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    let childPath: string | null = null;
    try {
      const prepared = await runtime.prepare({
        mode: "isolated",
        sourceRoot: fixture.repo,
        threadId: "thread-lifecycle",
      });
      childPath = prepared.worktree!.path;
      writeFileSync(join(childPath, "work.txt"), "some work done\n");
      git(childPath, ["add", "-A"]);
      git(childPath, ["commit", "-m", "child work"]);

      const snapshotted = await runtime.snapshot(prepared.worktree!);
      expect(snapshotted.resultCommit).toBeDefined();

      // Measure disk usage
      const bytes = await runtime.measureDiskUsage(snapshotted);
      expect(bytes).toBeGreaterThan(0);
      expect(snapshotted.diskBytes).toBe(bytes);

      // Reclaim directory
      const reclaimResult = await runtime.reclaim(snapshotted);
      expect(reclaimResult.reclaimed).toBe(true);
      expect(snapshotted.materialized).toBe(false);
      expect(existsSync(childPath)).toBe(false);

      // Materialize at same path
      const materialized = await runtime.materialize(fixture.repo, snapshotted);
      expect(materialized.materialized).toBe(true);
      expect(existsSync(childPath)).toBe(true);
      expect(readFileSync(join(childPath, "work.txt"), "utf8")).toBe("some work done\n");
    } finally {
      if (childPath && existsSync(childPath)) {
        try { git(fixture.repo, ["worktree", "remove", "--force", childPath]); } catch { /* test cleanup */ }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("runs setup command and copies ignored whitelist files", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    let childPath: string | null = null;
    try {
      // Create an ignored file in source repo
      writeFileSync(join(fixture.repo, ".env.local"), "SECRET_KEY=12345\n");

      const prepared = await runtime.prepare({
        mode: "isolated",
        sourceRoot: fixture.repo,
        threadId: "thread-setup",
      });
      childPath = prepared.worktree!.path;

      // Run setup with echo and copyIgnored
      const settings = {
        setup: "echo setup completed",
        copyIgnored: [".env.local"],
      };
      await runtime.prepareInputs(fixture.repo, prepared.worktree!, settings);
      const setupResult = await runtime.runSetup(fixture.repo, prepared.worktree!, settings);
      expect(setupResult.output).toMatch(/setup[\s\r\n]+completed/);
      expect(existsSync(join(childPath, ".env.local"))).toBe(true);
      expect(readFileSync(join(childPath, ".env.local"), "utf8")).toBe("SECRET_KEY=12345\n");
    } finally {
      if (childPath && existsSync(childPath)) {
        try { git(fixture.repo, ["worktree", "remove", "--force", childPath]); } catch { /* test cleanup */ }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails setup cleanly when command fails with exitReason setup-failed", async () => {
    const fixture = createRepo();
    const runtime = runtimeFor(fixture.worktrees);
    let childPath: string | null = null;
    try {
      const prepared = await runtime.prepare({
        mode: "isolated",
        sourceRoot: fixture.repo,
        threadId: "thread-setup-fail",
      });
      childPath = prepared.worktree!.path;

      let caughtError: unknown = null;
      try {
        await runtime.runSetup(fixture.repo, prepared.worktree!, {
          setup: "exit 1",
        });
      } catch (err) {
        caughtError = err;
      }
      expect(caughtError).not.toBeNull();
      expect(caughtError).toMatchObject({ exitReason: "setup-failed" });
    } finally {
      if (childPath && existsSync(childPath)) {
        try { git(fixture.repo, ["worktree", "remove", "--force", childPath]); } catch { /* test cleanup */ }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("preserves non-git / zero-commit thread results across reclaim, rematerialize, and merge", async () => {
    const root = mkdtempSync(join(tmpdir(), "non-git-root-"));
    const sourceRoot = join(root, "project");
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(sourceRoot, "original.txt"), "hello world\n");

    const runtime = createThreadWorktreeRuntime({
      createWorktree: async (_dir, input) => {
        const p = join(root, "worktrees", String(input.worktreeName));
        mkdirSync(p, { recursive: true });
        return { path: p };
      },
      getWorktreeBootstrapStatus: async () => ({ status: "ready", phase: "setup-ready", error: null, updatedAt: Date.now() }),
    });

    try {
      const prepared = await runtime.prepare({
        mode: "isolated",
        sourceRoot,
        threadId: "zero-commit-thread",
      });
      expect(prepared.worktree).not.toBeNull();
      expect(prepared.worktree!.base).toBe("zero-commit");

      // Child edits a file and creates a new one
      writeFileSync(join(prepared.cwd, "original.txt"), "hello from child\n");
      writeFileSync(join(prepared.cwd, "result.txt"), "new result file\n");

      // Cannot reclaim before snapshot!
      const unSnapshottedReclaim = await runtime.reclaim(prepared.worktree!);
      expect(unSnapshottedReclaim.reclaimed).toBe(false);

      // Snapshot
      const snapshotted = await runtime.snapshot(prepared.worktree!);
      expect(snapshotted.resultCommit).toBeDefined();
      expect(snapshotted.resultCommit!.length).toBe(40);

      // Reclaim
      const reclaimed = await runtime.reclaim(snapshotted);
      expect(reclaimed.reclaimed).toBe(true);
      expect(existsSync(prepared.cwd)).toBe(false);

      // Rematerialize
      const rematerialized = await runtime.materialize(sourceRoot, snapshotted);
      expect(rematerialized.materialized).toBe(true);
      expect(existsSync(prepared.cwd)).toBe(true);
      expect(readFileSync(join(prepared.cwd, "result.txt"), "utf8")).toBe("new result file\n");
      expect(readFileSync(join(prepared.cwd, "original.txt"), "utf8")).toBe("hello from child\n");

      // Merge into parent
      const merged = await runtime.merge(sourceRoot, rematerialized);
      expect(merged.conflicts).toEqual([]);
      expect(merged.merged).toBe(2);
      expect(readFileSync(join(sourceRoot, "result.txt"), "utf8")).toBe("new result file\n");
      expect(readFileSync(join(sourceRoot, "original.txt"), "utf8")).toBe("hello from child\n");
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows cleanup */ }
    }
  });

  it("zero-commit snapshot ignores post-snapshot live modifications during inspect and merge", async () => {
    const root = mkdtempSync(join(tmpdir(), "non-git-fixed-"));
    const sourceRoot = join(root, "project");
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(sourceRoot, "file.txt"), "initial\n");

    const runtime = createThreadWorktreeRuntime({
      createWorktree: async (_dir, input) => {
        const p = join(root, "worktrees", String(input.worktreeName));
        mkdirSync(p, { recursive: true });
        return { path: p };
      },
      getWorktreeBootstrapStatus: async () => ({ status: "ready", phase: "setup-ready", error: null, updatedAt: Date.now() }),
    });

    try {
      const prepared = await runtime.prepare({
        mode: "isolated",
        sourceRoot,
        threadId: "fixed-rev-thread",
      });

      // Child edits file
      writeFileSync(join(prepared.cwd, "file.txt"), "published\n");

      // Snapshot to freeze result
      const snapshotted = await runtime.snapshot(prepared.worktree!);
      expect(snapshotted.resultCommit).toBeDefined();

      // Child makes a later live modification (not snapshotted)
      writeFileSync(join(prepared.cwd, "file.txt"), "later-live\n");

      // Inspect should see "published", not "later-live"
      const inspected = await runtime.inspect(snapshotted);
      expect(inspected.changedFiles).toEqual(["file.txt"]);

      // Merge should apply "published", NOT "later-live"
      const merged = await runtime.merge(sourceRoot, snapshotted);
      expect(merged.conflicts).toEqual([]);
      expect(readFileSync(join(sourceRoot, "file.txt"), "utf8")).toBe("published\n");
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows cleanup */ }
    }
  });

  it("zero-commit snapshot cleanly deletes removed files in parent without residue", async () => {
    const root = mkdtempSync(join(tmpdir(), "non-git-delete-"));
    const sourceRoot = join(root, "project");
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(sourceRoot, "keep.txt"), "keep me\n");
    writeFileSync(join(sourceRoot, "delete-me.txt"), "delete me\n");

    const runtime = createThreadWorktreeRuntime({
      createWorktree: async (_dir, input) => {
        const p = join(root, "worktrees", String(input.worktreeName));
        mkdirSync(p, { recursive: true });
        return { path: p };
      },
      getWorktreeBootstrapStatus: async () => ({ status: "ready", phase: "setup-ready", error: null, updatedAt: Date.now() }),
    });

    try {
      const prepared = await runtime.prepare({
        mode: "isolated",
        sourceRoot,
        threadId: "delete-thread",
      });

      // First snapshot with all files
      let snapshotted = await runtime.snapshot(prepared.worktree!);
      const firstResultPath = snapshotted.resultPath!;

      // Now child deletes delete-me.txt
      unlinkSync(join(prepared.cwd, "delete-me.txt"));

      // Second snapshot captures the deletion
      snapshotted = await runtime.snapshot(prepared.worktree!);
      expect(snapshotted.resultPath).not.toBe(firstResultPath);
      expect(readFileSync(join(firstResultPath, "delete-me.txt"), "utf8")).toBe("delete me\n");

      // Reclaim should succeed (snapshot matches live cwd, no uncommitted modifications)
      const reclaimed = await runtime.reclaim(snapshotted);
      expect(reclaimed.reclaimed).toBe(true);

      // Merge into parent
      const merged = await runtime.merge(sourceRoot, snapshotted);
      expect(merged.conflicts).toEqual([]);
      expect(existsSync(join(sourceRoot, "keep.txt"))).toBe(true);
      expect(existsSync(join(sourceRoot, "delete-me.txt"))).toBe(false);
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows cleanup */ }
    }
  });

  it("keeps the previous immutable copy result when a later snapshot fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "non-git-snapshot-failure-"));
    const sourceRoot = join(root, "project");
    const worktreeRoot = join(root, "worktrees");
    mkdirSync(sourceRoot, { recursive: true });
    writeFileSync(join(sourceRoot, "file.txt"), "base\n");
    const createWorktree = async (_dir: string, input: Record<string, unknown>) => {
      const target = join(worktreeRoot, String(input.worktreeName));
      mkdirSync(target, { recursive: true });
      return { path: target };
    };
    const bootstrap = async () => ({ status: "ready", phase: "setup-ready", error: null, updatedAt: Date.now() } as const);
    try {
      const runtime = createThreadWorktreeRuntime({ createWorktree, getWorktreeBootstrapStatus: bootstrap });
      const prepared = await runtime.prepare({ mode: "isolated", sourceRoot, threadId: "failure" });
      writeFileSync(join(prepared.cwd, "file.txt"), "first\n");
      const first = await runtime.snapshot(prepared.worktree!);
      const failedRuntime = createThreadWorktreeRuntime({
        createWorktree,
        getWorktreeBootstrapStatus: bootstrap,
        fsPromises: new Proxy(fs.promises, {
          get(target, property, receiver) {
            if (property === "copyFile") return async () => { throw new Error("injected snapshot failure"); };
            return Reflect.get(target, property, receiver);
          },
        }),
      });
      writeFileSync(join(prepared.cwd, "file.txt"), "second\n");
      await expect(failedRuntime.snapshot(first)).rejects.toThrow("injected snapshot failure");
      expect(readFileSync(join(first.resultPath!, "file.txt"), "utf8")).toBe("first\n");
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows may retain the injected-failure staging path briefly. */ }
    }
  });
});
