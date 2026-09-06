import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { overlayDraftsOnBaseline, createBranchWithDraftBaseline } from "./draft-baseline.js";
import { WorkingStateStore } from "./working-state-store.js";
import type { RecoveryState, RegularFileState } from "./types.js";
import { openRecoveryJournalCatalog, type SqliteDatabase } from "../../recovery/journal-catalog.js";
import { createRecoveryFileStore } from "../../recovery/journal-files.js";

describe("draft-baseline", () => {
  let tempDir: string;
  let store: WorkingStateStore;
  let database: SqliteDatabase;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "piarium-draft-test-"));
    const workspace = path.join(tempDir, "workspace");
    const root = path.join(tempDir, "recovery");
    await fs.promises.mkdir(workspace, { recursive: true });
    database = (await openRecoveryJournalCatalog(root, { create: true }))!;
    store = await WorkingStateStore.open({
      database,
      fileStore: createRecoveryFileStore(),
      identity: { authorityId: "test", canonicalRoot: workspace, filesystemProfile: "test", workspaceId: "ws-test" },
      resourceOperationGate: { run: async (_resources, operation) => operation() },
      root,
    });
  });

  afterEach(async () => {
    database.close();
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("overlays modified, added, and deleted drafts onto baseline", async () => {
    const baseState: Record<string, RecoveryState> = {
      "file1.txt": {
        kind: "regular-file",
        objectHash: "hash-old-1",
        byteLength: 5,
      },
      "file2.txt": {
        kind: "regular-file",
        objectHash: "hash-old-2",
        byteLength: 5,
      },
      "untouched.txt": {
        kind: "regular-file",
        objectHash: "hash-untouched",
        byteLength: 9,
      },
    };

    const drafts = [
      { path: "file1.txt", content: "modified content" },
      { path: "file2.txt", content: null }, // deleted
      { path: "brand-new.txt", content: "new file content" },
    ];

    const result = await overlayDraftsOnBaseline({
      baseState,
      drafts,
      putObject: (b) => store.putObject(b),
    });

    expect(result.modifiedPaths).toEqual(["file1.txt"]);
    expect(result.deletedPaths).toEqual(["file2.txt"]);
    expect(result.addedPaths).toEqual(["brand-new.txt"]);
    expect(result.changedPaths).toEqual(["brand-new.txt", "file1.txt", "file2.txt"]);

    expect(result.effectiveState["untouched.txt"]).toEqual(baseState["untouched.txt"]);
    expect(result.effectiveState["file2.txt"]).toEqual({ kind: "missing" });

    const f1State = result.effectiveState["file1.txt"] as RegularFileState;
    expect(f1State.kind).toBe("regular-file");
    const f1Bytes = await store.getObject(f1State.objectHash);
    expect(f1Bytes?.toString("utf8")).toBe("modified content");

    const newFileState = result.effectiveState["brand-new.txt"] as RegularFileState;
    expect(newFileState.kind).toBe("regular-file");
    const newFileBytes = await store.getObject(newFileState.objectHash);
    expect(newFileBytes?.toString("utf8")).toBe("new file content");
  });

  it("creates a WorkingBranch with draft baseline paths and no result deltas", async () => {
    const baseState: Record<string, RecoveryState> = {
      "main.ts": {
        kind: "regular-file",
        objectHash: "hash-main",
        byteLength: 10,
        mode: 0o755,
      },
    };

    const drafts = {
      "main.ts": "const x = 42;",
      "helper.ts": "export const y = 100;",
    };

    const branch = await createBranchWithDraftBaseline(
      store,
      "ws-test",
      "branch-feature",
      baseState,
      drafts,
      "main",
    );

    expect(branch.branchId).toBe("branch-feature");
    expect(branch.headRevision).toBe(0);
    expect(branch.deltas).toEqual({});
    expect(branch.draftBasePaths).toEqual(["helper.ts", "main.ts"]);
    expect(branch.baseState["main.ts"]).toMatchObject({ kind: "regular-file", mode: 0o755 });
    expect(branch.baseState["helper.ts"]?.kind).toBe("regular-file");

    const mainBase = branch.baseState["main.ts"] as RegularFileState;
    const content = await store.getObject(mainBase.objectHash);
    expect(content?.toString("utf8")).toBe("const x = 42;");
  });

  it("keeps nested draft baselines structurally materializable", async () => {
    const workspace = path.join(tempDir, "workspace");
    await fs.promises.mkdir(path.join(workspace, "dir"), { recursive: true });
    await fs.promises.mkdir(path.join(workspace, "stable"), { recursive: true });
    await fs.promises.writeFile(path.join(workspace, "dir", "old.txt"), "old\n");
    await fs.promises.writeFile(path.join(workspace, "file-base"), "file\n");
    const baseState = await store.captureDirectory(workspace);
    const drafts = [
      { path: "newdir/new.ts", content: "new nested draft\n" },
      { path: "dir", content: "directory replaced by file\n" },
      { path: "file-base/child.ts", content: "file replaced by directory\n" },
      { path: "stable/new.ts", content: "existing directory remains baseline\n" },
    ];

    const result = await overlayDraftsOnBaseline({
      baseState,
      drafts,
      putObject: (bytes) => store.putObject(bytes),
    });
    expect(result.modifiedPaths).toEqual(["dir"]);
    expect(result.deletedPaths).toEqual([]);
    expect(result.addedPaths).toEqual(["newdir/new.ts", "file-base/child.ts", "stable/new.ts"]);
    expect(result.changedPaths).toEqual([
      "dir",
      "dir/old.txt",
      "file-base",
      "file-base/child.ts",
      "newdir",
      "newdir/new.ts",
      "stable/new.ts",
    ]);
    expect(result.effectiveState["newdir"]).toEqual({
      kind: "directory",
      mode: (process.platform === "win32" ? 0o666 : 0o777) & ~process.umask(),
    });
    expect(result.effectiveState["dir/old.txt"]).toEqual({ kind: "missing" });
    expect(result.effectiveState["file-base"]).toMatchObject({ kind: "directory" });

    const branch = await createBranchWithDraftBaseline(
      store,
      "ws-test",
      "branch-structure",
      baseState,
      drafts,
      "main",
    );
    expect(branch.draftBasePaths).toEqual(result.changedPaths);
    const child = path.join(tempDir, "materialized-child");
    await store.materializeStates(
      Object.fromEntries(branch.draftBasePaths.map((file) => [file, branch.baseState[file]!])),
      child,
    );
    expect((await fs.promises.lstat(path.join(child, "newdir"))).isDirectory()).toBe(true);
    expect(await fs.promises.readFile(path.join(child, "newdir", "new.ts"), "utf8")).toBe("new nested draft\n");
    expect((await fs.promises.lstat(path.join(child, "dir"))).isFile()).toBe(true);
    await expect(fs.promises.lstat(path.join(child, "dir", "old.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.promises.lstat(path.join(child, "file-base"))).isDirectory()).toBe(true);
    expect(await fs.promises.readFile(path.join(child, "file-base", "child.ts"), "utf8")).toBe("file replaced by directory\n");
    expect(await fs.promises.readFile(path.join(child, "stable", "new.ts"), "utf8")).toBe("existing directory remains baseline\n");

    const published = await store.publishDirectoryResult("branch-structure", child, branch.draftBasePaths);
    expect(published.changedPaths).toEqual([]);
    await expect(store.directoryMatchesResult("branch-structure", published.resultRevision, child)).resolves.toBe(true);
  });

  it("rejects conflicting draft paths before creating an impossible state", async () => {
    await expect(overlayDraftsOnBaseline({
      baseState: {},
      drafts: [
        { path: "a", content: "file\n" },
        { path: "a/b.ts", content: "nested\n" },
      ],
      putObject: (bytes) => store.putObject(bytes),
    })).rejects.toThrow(/ancestor\/descendant conflict/);

    await expect(store.createDraftBaseline("ws-test", [
      {
        path: "a",
        content: "file\n",
        provenance: { baseRevision: null, encoding: "utf-8", bom: false, localEditRevision: 1, revision: "a" },
      },
      {
        path: "a/b.ts",
        content: "nested\n",
        provenance: { baseRevision: null, encoding: "utf-8", bom: false, localEditRevision: 1, revision: "a/b" },
      },
    ])).rejects.toThrow(/ancestor\/descendant conflict/);
  });
});
