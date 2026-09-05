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

  it("creates a WorkingBranch with draft deltas pre-populated", async () => {
    const baseState: Record<string, RecoveryState> = {
      "main.ts": {
        kind: "regular-file",
        objectHash: "hash-main",
        byteLength: 10,
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
    expect(branch.baseState["main.ts"]).toEqual(baseState["main.ts"]);
    expect(branch.deltas["main.ts"]?.kind).toBe("regular-file");
    expect(branch.deltas["helper.ts"]?.kind).toBe("regular-file");

    const mainDelta = branch.deltas["main.ts"] as RegularFileState;
    const content = await store.getObject(mainDelta.objectHash);
    expect(content?.toString("utf8")).toBe("const x = 42;");
  });
});
