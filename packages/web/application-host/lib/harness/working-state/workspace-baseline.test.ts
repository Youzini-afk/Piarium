import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRecoveryFileStore } from "../../recovery/journal-files.js";
import { openRecoveryJournalCatalog } from "../../recovery/journal-catalog.js";
import { createThreadWorktreeRuntime } from "../thread-worktree.js";
import { WorkingStateStore } from "./working-state-store.js";
import { gitBaselineFingerprint, withAncestorDirectories } from "./workspace-baseline.js";

const roots: string[] = [];
const catalogs: Array<{ close(): void }> = [];

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const harness = async () => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "piarium-workspace-baseline-"));
  roots.push(parent);
  const workspace = path.join(parent, "workspace");
  const recovery = path.join(parent, "recovery");
  await fs.promises.mkdir(workspace);
  const database = await openRecoveryJournalCatalog(recovery, { create: true });
  if (!database) throw new Error("catalog missing");
  catalogs.push(database);
  const context = {
    database,
    fileStore: createRecoveryFileStore(),
    identity: { authorityId: "test", canonicalRoot: workspace, filesystemProfile: "test", workspaceId: "ws" },
    resourceOperationGate: {
      run: async <Result>(_resources: readonly unknown[], operation: () => Promise<Result>) => operation(),
    },
    root: recovery,
  };
  const worktrees = createThreadWorktreeRuntime({
    createWorktree: async () => ({ path: path.join(parent, "unused") }),
    getWorktreeBootstrapStatus: async () => ({ status: "ready", phase: "setup-ready", error: null, updatedAt: Date.now() }),
  });
  return { parent, workspace, store: await WorkingStateStore.open(context), worktrees };
};

afterEach(async () => {
  for (const catalog of catalogs.splice(0)) catalog.close();
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

describe("workspace baseline capture", () => {
  it("adds virtual ancestor directories for Git file paths", () => {
    expect(withAncestorDirectories(["src/app/main.ts", "src/app/util.ts"])).toEqual([
      "src",
      "src/app",
      "src/app/main.ts",
      "src/app/util.ts",
    ]);
  });

  it("changes the capture fingerprint when only the Git index executable mode changes", () => {
    const base = { kind: "git" as const, baseRef: "abc", unborn: false, paths: ["script.sh"], gitlinks: [] };
    expect(gitBaselineFingerprint({ ...base, indexModes: { "script.sh": "100644" } }))
      .not.toBe(gitBaselineFingerprint({ ...base, indexModes: { "script.sh": "100755" } }));
  });

  it("fixes Git clean, staged, unstaged, untracked, deleted, and captureScopes while omitting ignored files", async () => {
    const h = await harness();
    git(h.workspace, ["init"]);
    git(h.workspace, ["config", "user.name", "Test"]);
    git(h.workspace, ["config", "user.email", "test@example.com"]);
    git(h.workspace, ["config", "core.autocrlf", "false"]);
    await fs.promises.writeFile(path.join(h.workspace, "clean.txt"), "clean-at-dispatch\n");
    await fs.promises.writeFile(path.join(h.workspace, "staged.txt"), "staged-old\n");
    await fs.promises.writeFile(path.join(h.workspace, "unstaged.txt"), "unstaged-old\n");
    await fs.promises.writeFile(path.join(h.workspace, "deleted.txt"), "will-delete\n");
    await fs.promises.writeFile(path.join(h.workspace, ".gitignore"), "ignored.txt\nsecret.env\n");
    git(h.workspace, ["add", "."]);
    git(h.workspace, ["commit", "-m", "base"]);
    await fs.promises.writeFile(path.join(h.workspace, "staged.txt"), "staged-at-dispatch\n");
    git(h.workspace, ["add", "staged.txt"]);
    await fs.promises.writeFile(path.join(h.workspace, "unstaged.txt"), "unstaged-at-dispatch\n");
    await fs.promises.unlink(path.join(h.workspace, "deleted.txt"));
    await fs.promises.writeFile(path.join(h.workspace, "untracked.txt"), "untracked-at-dispatch\n");
    await fs.promises.writeFile(path.join(h.workspace, "ignored.txt"), "should-not-enter\n");
    await fs.promises.writeFile(path.join(h.workspace, "secret.env"), "explicit-scope\n");

    const inventory = await h.worktrees.inspectGitBaselineInventory(h.workspace);
    expect(inventory.kind).toBe("git");
    if (inventory.kind !== "git") throw new Error("expected git inventory");
    const scopes = await h.store.listCaptureScopePaths(h.workspace, ["secret.env"]);
    const paths = withAncestorDirectories([...inventory.paths, ...scopes]);
    expect(paths).toContain("clean.txt");
    expect(paths).toContain("staged.txt");
    expect(paths).toContain("unstaged.txt");
    expect(paths).toContain("deleted.txt");
    expect(paths).toContain("untracked.txt");
    expect(paths).toContain("secret.env");
    expect(paths).not.toContain("ignored.txt");

    const baseline = await h.store.captureDirectory(h.workspace, paths);
    const branch = await h.store.createBranch("ws", "thread-1", baseline, inventory.baseRef, [], ["secret.env"]);
    expect(branch.baseRef).toBe(inventory.baseRef);
    expect(branch.captureScopes).toEqual(["secret.env"]);
    expect(branch.baseState["clean.txt"]).toMatchObject({ kind: "regular-file" });
    expect(branch.baseState["deleted.txt"]).toMatchObject({ kind: "missing" });
    expect(await h.store.getObject((branch.baseState["secret.env"] as { objectHash: string }).objectHash))
      .toEqual(Buffer.from("explicit-scope\n"));

    await fs.promises.writeFile(path.join(h.workspace, "clean.txt"), "parent-drift\n");
    await fs.promises.writeFile(path.join(h.workspace, "untracked.txt"), "parent-changed-untracked\n");
    await fs.promises.writeFile(path.join(h.workspace, "ignored.txt"), "still-ignored\n");
    git(h.workspace, ["add", "clean.txt"]);
    git(h.workspace, ["commit", "-m", "parent moved on"]);

    const live = h.store.effectiveState("thread-1")!;
    expect(await h.store.getObject((live["clean.txt"] as { objectHash: string }).objectHash))
      .toEqual(Buffer.from("clean-at-dispatch\n"));
    expect(await h.store.getObject((live["staged.txt"] as { objectHash: string }).objectHash))
      .toEqual(Buffer.from("staged-at-dispatch\n"));
    expect(await h.store.getObject((live["unstaged.txt"] as { objectHash: string }).objectHash))
      .toEqual(Buffer.from("unstaged-at-dispatch\n"));
    expect(await h.store.getObject((live["untracked.txt"] as { objectHash: string }).objectHash))
      .toEqual(Buffer.from("untracked-at-dispatch\n"));
    expect(live["ignored.txt"]).toBeUndefined();
  });

  it("fixes an unborn Git repository and a non-Git directory", async () => {
    const gitCase = await harness();
    git(gitCase.workspace, ["init"]);
    git(gitCase.workspace, ["config", "core.autocrlf", "false"]);
    await fs.promises.writeFile(path.join(gitCase.workspace, "only.txt"), "unborn\n");
    const gitInventory = await gitCase.worktrees.inspectGitBaselineInventory(gitCase.workspace);
    expect(gitInventory).toMatchObject({ kind: "git", baseRef: "zero-commit", unborn: true, gitlinks: [] });
    if (gitInventory.kind !== "git") throw new Error("expected unborn git");
    const gitBaseline = await gitCase.store.captureDirectory(
      gitCase.workspace,
      withAncestorDirectories(gitInventory.paths),
    );
    await gitCase.store.createBranch("ws", "unborn", gitBaseline, gitInventory.baseRef);
    expect(gitCase.store.effectiveState("unborn")?.["only.txt"]).toMatchObject({ kind: "regular-file" });

    const dirCase = await harness();
    await fs.promises.writeFile(path.join(dirCase.workspace, "plain.txt"), "no-git\n");
    expect(await dirCase.worktrees.inspectGitBaselineInventory(dirCase.workspace)).toEqual({ kind: "directory" });
    const dirBaseline = await dirCase.store.captureDirectory(dirCase.workspace);
    await dirCase.store.createBranch("ws", "nongit", dirBaseline, "zero-commit");
    expect(dirCase.store.effectiveState("nongit")?.["plain.txt"]).toMatchObject({ kind: "regular-file" });
  });

  it("keeps BOM, CRLF, binary, and permission bits as captured bytes, not text", async () => {
    const h = await harness();
    const bom = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    const crlf = Buffer.from("line\r\n");
    const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe]);
    await fs.promises.writeFile(path.join(h.workspace, "bom.txt"), bom);
    await fs.promises.writeFile(path.join(h.workspace, "crlf.txt"), crlf);
    await fs.promises.writeFile(path.join(h.workspace, "data.bin"), binary);
    const baseline = await h.store.captureDirectory(h.workspace);
    expect(baseline["bom.txt"]).toMatchObject({ kind: "regular-file" });
    expect(baseline["crlf.txt"]).toMatchObject({ kind: "regular-file" });
    expect(baseline["data.bin"]).toMatchObject({ kind: "regular-file" });
    expect(await h.store.getObject((baseline["bom.txt"] as { objectHash: string }).objectHash)).toEqual(bom);
    expect(await h.store.getObject((baseline["crlf.txt"] as { objectHash: string }).objectHash)).toEqual(crlf);
    expect(await h.store.getObject((baseline["data.bin"] as { objectHash: string }).objectHash)).toEqual(binary);
    if (process.platform !== "win32") {
      await fs.promises.chmod(path.join(h.workspace, "crlf.txt"), 0o755);
      const modes = await h.store.captureDirectory(h.workspace, ["crlf.txt"]);
      expect((modes["crlf.txt"] as { mode?: number }).mode! & 0o111).toBeTruthy();
    }
  });

  it("aborts an incomplete directory capture without creating a branch", async () => {
    const h = await harness();
    await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "a\n");
    const controller = new AbortController();
    controller.abort();
    await expect(h.store.captureDirectory(h.workspace, ["a.txt"], { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(h.store.getBranch("missing")).toBeNull();
  });

  it("does not invent a complete Git inventory when a listing command fails", async () => {
    const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "piarium-git-inventory-fail-"));
    roots.push(parent);
    const workspace = path.join(parent, "workspace");
    await fs.promises.mkdir(workspace);
    const worktrees = createThreadWorktreeRuntime({
      createWorktree: async () => ({ path: path.join(parent, "unused") }),
      getWorktreeBootstrapStatus: async () => ({ status: "ready", phase: "setup-ready", error: null, updatedAt: Date.now() }),
      runGit: async (_cwd, args) => {
        if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return { stdout: "true\n", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: "abc123\n", stderr: "" };
        if (args[0] === "ls-files" && args.includes("-z") && !args.includes("-s")) {
          throw new Error("Permission denied");
        }
        return { stdout: "", stderr: "" };
      },
    });
    await expect(worktrees.inspectGitBaselineInventory(workspace)).rejects.toThrow(/Permission denied/);
  });

  it("lists gitlinks instead of treating a submodule as an ordinary directory", async () => {
    const h = await harness();
    git(h.workspace, ["init"]);
    git(h.workspace, ["config", "user.name", "Test"]);
    git(h.workspace, ["config", "user.email", "test@example.com"]);
    git(h.workspace, ["config", "core.autocrlf", "false"]);
    await fs.promises.writeFile(path.join(h.workspace, "tracked.txt"), "ok\n");
    git(h.workspace, ["add", "tracked.txt"]);
    git(h.workspace, ["commit", "-m", "base"]);
    git(h.workspace, ["update-index", "--add", "--cacheinfo", "160000,e69de29bb2d1d6434b8b29ae775ad8c2e48c5391,vendor/lib"]);
    const inventory = await h.worktrees.inspectGitBaselineInventory(h.workspace);
    expect(inventory.kind).toBe("git");
    if (inventory.kind !== "git") throw new Error("expected git inventory");
    expect(inventory.gitlinks).toEqual(["vendor/lib"]);
    expect(inventory.paths).toContain("tracked.txt");
  });
});
