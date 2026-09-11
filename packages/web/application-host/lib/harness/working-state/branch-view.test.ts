import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openRecoveryJournalCatalog } from "../../recovery/journal-catalog.js";
import { createRecoveryFileStore } from "../../recovery/journal-files.js";
import { listBranchTextFiles, listBranchView, readBranchFile } from "./branch-view.js";
import { WorkingStateStore } from "./working-state-store.js";

const roots: string[] = [];

const harness = async () => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "piarium-branch-view-"));
  roots.push(parent);
  const workspace = path.join(parent, "workspace");
  const root = path.join(parent, "recovery");
  await fs.promises.mkdir(workspace, { recursive: true });
  await fs.promises.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.promises.writeFile(path.join(workspace, "kept.txt"), "baseline kept\n");
  await fs.promises.writeFile(path.join(workspace, "changed.txt"), "baseline changed\n");
  await fs.promises.writeFile(path.join(workspace, "deleted.txt"), "baseline deleted\n");
  await fs.promises.writeFile(path.join(workspace, "src", "nested.ts"), "nested baseline\n");
  const database = await openRecoveryJournalCatalog(root, { create: true });
  if (!database) throw new Error("catalog missing");
  const context = {
    database,
    fileStore: createRecoveryFileStore(),
    identity: { authorityId: "test", canonicalRoot: workspace, filesystemProfile: "test", workspaceId: "ws" },
    resourceOperationGate: {
      run: async <Result>(_resources: readonly unknown[], operation: () => Promise<Result>) => operation(),
    },
    root,
  };
  const store = await WorkingStateStore.open(context);
  return { context, database, store, workspace };
};

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

describe("WorkingState branch view", () => {
  it("overlays delta add/modify/delete and synthesizes virtual ancestor directories", async () => {
    const h = await harness();
    try {
      const base = await h.store.captureDirectory(h.workspace);
      await h.store.createBranch("ws", "thread-1", base);
      await fs.promises.writeFile(path.join(h.workspace, "changed.txt"), "parent live\n");
      await fs.promises.writeFile(path.join(h.workspace, "kept.txt"), "parent live kept\n");
      const added = await h.store.putObject(Buffer.from("added from delta\n"));
      const changed = await h.store.putObject(Buffer.from("delta changed\n"));
      const nested = await h.store.putObject(Buffer.from("new nested\n"));
      await h.store.publishStates("thread-1", {
        ...h.store.effectiveState("thread-1")!,
        "added.ts": { kind: "regular-file", objectHash: added.hash, byteLength: added.byteLength },
        "changed.txt": { kind: "regular-file", objectHash: changed.hash, byteLength: changed.byteLength },
        "deleted.txt": { kind: "missing" },
        "virtual/dir/new.ts": { kind: "regular-file", objectHash: nested.hash, byteLength: nested.byteLength },
      });

      const listed = listBranchView(h.store.effectiveState("thread-1")!, "", { branchId: "thread-1", revision: 1 });
      expect(listed.map((entry) => `${entry.kind}:${entry.path}`)).toEqual(expect.arrayContaining([
        "file:added.ts",
        "file:changed.txt",
        "file:kept.txt",
        "directory:src",
        "directory:virtual",
        "directory:virtual/dir",
        "file:virtual/dir/new.ts",
      ]));
      expect(listed.some((entry) => entry.path === "deleted.txt")).toBe(false);

      const kept = await readBranchFile(h.store, "thread-1", "kept.txt");
      if ("bytes" in kept) {
        expect(kept.bytes.toString("utf8")).toBe("baseline kept\n");
        expect(kept.origin).toBe("base");
      } else {
        throw new Error("kept.txt should remain the fixed base");
      }
      const changedFile = await readBranchFile(h.store, "thread-1", "changed.txt");
      if ("bytes" in changedFile) {
        expect(changedFile.bytes.toString("utf8")).toBe("delta changed\n");
        expect(changedFile.origin).toBe("delta");
      } else {
        throw new Error("changed.txt should read the delta");
      }
      await expect(readBranchFile(h.store, "thread-1", "deleted.txt")).resolves.toMatchObject({ missing: true, origin: "delta" });
      const texts = await listBranchTextFiles(h.store, "thread-1", [""]);
      expect(texts.map((file) => file.path)).not.toContain("deleted.txt");
      expect(texts.find((file) => file.path === "kept.txt")?.text).toBe("baseline kept\n");
    } finally {
      h.database.close();
    }
  });

  it("labels unpublished virtual writes with writeRevision instead of headRevision", async () => {
    const h = await harness();
    try {
      const base = await h.store.captureDirectory(h.workspace);
      await h.store.createBranch("ws", "thread-1", base);
      const added = await h.store.putObject(Buffer.from("only virtual\n"));
      await h.store.commitVirtualWrites("thread-1", 0, {
        "added.ts": { kind: "regular-file", objectHash: added.hash, byteLength: added.byteLength },
      });
      expect(h.store.getBranch("thread-1")?.headRevision).toBe(0);
      const file = await readBranchFile(h.store, "thread-1", "added.ts");
      expect(file).toMatchObject({ revision: "working-branch:thread-1@1:delta" });
      const texts = await listBranchTextFiles(h.store, "thread-1", [""]);
      expect(texts.find((entry) => entry.path === "added.ts")?.revision).toBe("working-branch:thread-1@1:delta");
    } finally {
      h.database.close();
    }
  });

  it("hides descendants when a directory is tombstoned", async () => {
    const h = await harness();
    try {
      const base = await h.store.captureDirectory(h.workspace);
      await h.store.createBranch("ws", "thread-1", base);
      await h.store.publishStates("thread-1", {
        ...h.store.effectiveState("thread-1")!,
        src: { kind: "missing" },
      });
      expect(listBranchView(h.store.effectiveState("thread-1")!, "", { branchId: "thread-1", revision: 1 })
        .some((entry) => entry.path === "src" || entry.path.startsWith("src/"))).toBe(false);
      await expect(readBranchFile(h.store, "thread-1", "src/nested.ts")).resolves.toMatchObject({ missing: true });
    } finally {
      h.database.close();
    }
  });
});
