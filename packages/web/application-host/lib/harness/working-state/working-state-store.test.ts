import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { objectPath, openRecoveryJournalCatalog } from "../../recovery/journal-catalog.js";
import { createRecoveryFileStore } from "../../recovery/journal-files.js";
import { WorkingStateStore } from "./working-state-store.js";
import { createHash } from "node:crypto";
import type { HostResourceOperation } from "../../recovery/durable-file-operation.js";

const roots: string[] = [];

const harness = async () => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "piarium-working-state-"));
  roots.push(parent);
  const workspace = path.join(parent, "workspace");
  const root = path.join(parent, "recovery");
  await fs.promises.mkdir(workspace, { recursive: true });
  const database = await openRecoveryJournalCatalog(root, { create: true });
  if (!database) throw new Error("catalog missing");
  const context = {
    database,
    fileStore: createRecoveryFileStore(),
    identity: { authorityId: "test", canonicalRoot: workspace, filesystemProfile: "test", workspaceId: "ws" },
    resourceOperationGate: {
      run: async <Result>(_resources: readonly HostResourceOperation[], operation: () => Promise<Result>) => operation(),
    },
    root,
  };
  return { context, database, parent, root, workspace, store: await WorkingStateStore.open(context) };
};

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

describe("WorkingStateStore", () => {
  it("exposes an effective view of base plus delta and names each path origin", async () => {
    const h = await harness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "base.txt"), "base\n");
      await fs.promises.writeFile(path.join(h.workspace, "draft.txt"), "disk\n");
      const base = await h.store.captureDirectory(h.workspace);
      const draft = await h.store.putObject(Buffer.from("draft\n"));
      await h.store.createBranch("ws", "thread-1", {
        ...base,
        "draft.txt": { kind: "regular-file", objectHash: draft.hash, byteLength: draft.byteLength },
      }, "git-base", ["draft.txt"]);
      expect(h.store.pathOrigin("thread-1", "base.txt")).toBe("base");
      expect(h.store.pathOrigin("thread-1", "draft.txt")).toBe("draft-base");
      const added = await h.store.putObject(Buffer.from("delta\n"));
      await h.store.publishStates("thread-1", {
        ...h.store.effectiveState("thread-1")!,
        "added.txt": { kind: "regular-file", objectHash: added.hash, byteLength: added.byteLength },
        "base.txt": { kind: "missing" },
      });
      expect(h.store.pathOrigin("thread-1", "added.txt")).toBe("delta");
      expect(h.store.pathOrigin("thread-1", "base.txt")).toBe("delta");
      expect(h.store.effectiveState("thread-1")!["added.txt"]).toMatchObject({ kind: "regular-file" });
      expect(h.store.effectiveState("thread-1")!["base.txt"]).toEqual({ kind: "missing" });
      const published = await h.store.publishHeadResult("thread-1");
      expect(published.resultRevision).toBe(1);
      expect(published.changedPaths).toEqual(["added.txt", "base.txt"]);
    } finally {
      h.database.close();
    }
  });

  it("publishes immutable revisions with fixed baselines and keeps old objects referenced", async () => {
    const h = await harness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base\n");
      const base = await h.store.captureDirectory(h.workspace);
      await h.store.createBranch("ws", "thread-1", base, "git-base");

      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "result one\n");
      const first = await h.store.publishDirectoryResult("thread-1", h.workspace);
      const firstHash = first.pathStates["a.txt"]!.kind === "regular-file"
        ? first.pathStates["a.txt"]!.objectHash
        : "";

      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "result two\n");
      const second = await h.store.publishDirectoryResult("thread-1", h.workspace);

      expect(first.resultRevision).toBe(1);
      expect(second.resultRevision).toBe(2);
      expect((await h.store.getObject(firstHash))?.toString()).toBe("result one\n");
      expect(h.store.getResult("thread-1", 1)).toEqual(first);
      await fs.promises.rm(h.workspace, { recursive: true, force: true });
      await h.store.materializeResult("thread-1", first.resultRevision, h.workspace);
      expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("result one\n");
      expect(await h.store.directoryMatchesResult("thread-1", first.resultRevision, h.workspace)).toBe(true);
      await fs.promises.writeFile(path.join(h.workspace, "ignored-output.bin"), Buffer.from([1, 2, 3]));
      expect(await h.store.directoryMatchesResult("thread-1", first.resultRevision, h.workspace)).toBe(false);
      expect(h.database.prepare(`SELECT COUNT(*) AS count FROM object_references WHERE owner_kind = 'thread-result'`).get()).toEqual({ count: 4 });
    } finally {
      h.database.close();
    }
  });

  it("checks draft baseline paths when a narrowed result capture omits them", async () => {
    const h = await harness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, ".gitignore"), "*.draft\n");
      await fs.promises.writeFile(path.join(h.workspace, "ignored.draft"), "draft baseline\n");
      await fs.promises.writeFile(path.join(h.workspace, "ordinary.txt"), "ordinary baseline\n");
      const base = await h.store.captureDirectory(h.workspace);
      await h.store.createBranch("ws", "thread-draft", base, "git-base", ["ignored.draft"]);

      const unchanged = await h.store.publishDirectoryResult("thread-draft", h.workspace, ["tracked.txt"]);
      expect(unchanged.changedPaths).toEqual([]);

      await fs.promises.writeFile(path.join(h.workspace, "ignored.draft"), "draft changed\n");
      await fs.promises.writeFile(path.join(h.workspace, "ordinary.txt"), "ordinary changed\n");
      const changed = await h.store.publishDirectoryResult("thread-draft", h.workspace, ["tracked.txt"]);
      expect(changed.changedPaths).toEqual(["ignored.draft"]);

      await fs.promises.rm(path.join(h.workspace, "ignored.draft"));
      await fs.promises.rm(path.join(h.workspace, "ordinary.txt"));
      const deleted = await h.store.publishDirectoryResult("thread-draft", h.workspace, ["tracked.txt"]);
      expect(deleted.changedPaths).toEqual(["ignored.draft"]);
    } finally {
      h.database.close();
    }
  });

  it("captures configured file and directory scopes around a narrowed Git change set", async () => {
    const h = await harness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "ignored.env"), "base env\n");
      await fs.promises.mkdir(path.join(h.workspace, "ignored-dir"), { recursive: true });
      await fs.promises.writeFile(path.join(h.workspace, "ignored-dir", "old.txt"), "old\n");
      await fs.promises.writeFile(path.join(h.workspace, "ordinary.txt"), "ordinary base\n");
      const base = await h.store.captureDirectory(h.workspace);
      const branch = await h.store.createBranch("ws", "scoped", base, "git-base", [], [
        "./ignored-dir/",
        "ignored.env",
        "ignored.env",
      ]);
      expect(branch.captureScopes).toEqual(["ignored-dir", "ignored.env"]);

      await fs.promises.writeFile(path.join(h.workspace, "ignored.env"), "changed env\n");
      await fs.promises.writeFile(path.join(h.workspace, "ignored-dir", "old.txt"), "changed old\n");
      await fs.promises.writeFile(path.join(h.workspace, "ignored-dir", "new.txt"), "new\n");
      await fs.promises.rm(path.join(h.workspace, "ordinary.txt"));
      const candidateIdentity = await h.store.captureBranchCandidateIdentity("scoped", h.workspace, ["tracked.txt"]);
      const first = await h.store.publishDirectoryResult("scoped", h.workspace, ["tracked.txt"]);
      expect(first.changedPaths).toEqual(["ignored-dir/new.txt", "ignored-dir/old.txt", "ignored.env"]);
      expect(candidateIdentity).toBe(h.store.resultTreeIdentity("scoped", first.resultRevision));

      const reopened = await WorkingStateStore.open(h.context);
      await fs.promises.writeFile(path.join(h.workspace, "ignored-dir", "newer.txt"), "newer\n");
      await fs.promises.rm(path.join(h.workspace, "ignored-dir", "old.txt"));
      const second = await reopened.publishDirectoryResult("scoped", h.workspace, ["tracked.txt"]);
      expect(second.changedPaths).toEqual(["ignored-dir/new.txt", "ignored-dir/newer.txt", "ignored-dir/old.txt", "ignored.env"]);

      const materialized = path.join(h.parent, "materialized-scoped");
      await reopened.materializeResult("scoped", second.resultRevision, materialized);
      expect(await reopened.directoryMatchesResult("scoped", second.resultRevision, materialized)).toBe(true);
      expect(await fs.promises.readFile(path.join(materialized, "ignored.env"), "utf8")).toBe("changed env\n");
      expect(await fs.promises.readFile(path.join(materialized, "ignored-dir", "newer.txt"), "utf8")).toBe("newer\n");
      await expect(fs.promises.lstat(path.join(materialized, "ignored-dir", "old.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.promises.readFile(path.join(materialized, "ordinary.txt"), "utf8")).toBe("ordinary base\n");
    } finally {
      h.database.close();
    }
  });

  it("does not switch the branch head when a later capture fails", async () => {
    const h = await harness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base");
      await h.store.createBranch("ws", "thread-1", await h.store.captureDirectory(h.workspace));
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "published");
      const first = await h.store.publishDirectoryResult("thread-1", h.workspace);
      await fs.promises.rm(h.workspace, { recursive: true, force: true });
      await expect(h.store.publishDirectoryResult("thread-1", h.workspace)).rejects.toThrow();
      expect(h.store.getBranch("thread-1")?.headRevision).toBe(first.resultRevision);
      expect(h.store.getResult("thread-1", first.resultRevision)).not.toBeNull();
    } finally {
      h.database.close();
    }
  });

  it("reopens durable metadata and rejects corrupt JSON without treating it as empty", async () => {
    const h = await harness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base");
      await h.store.createBranch("ws", "thread-1", await h.store.captureDirectory(h.workspace));
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "result");
      await h.store.publishDirectoryResult("thread-1", h.workspace);

      expect((await WorkingStateStore.open(h.context)).getResult("thread-1", 1)).not.toBeNull();
      const catalog = path.join(h.root, "working-state", `${createHash("sha256").update("ws").digest("hex")}.json`);
      await fs.promises.writeFile(catalog, "{bad json", "utf8");
      await expect(WorkingStateStore.open(h.context)).rejects.toThrow();
      expect(h.database.prepare(`SELECT COUNT(*) AS count FROM object_references WHERE owner_kind = 'thread-result'`).get()).toEqual({ count: 2 });
    } finally {
      h.database.close();
    }
  });

  it("persists draft baselines with independent object ownership and fails when content is missing", async () => {
    const h = await harness();
    try {
      const baseline = await h.store.createDraftBaseline("ws", [{
        path: "src/draft.ts",
        content: "export const draft = true;\n",
        provenance: {
          baseRevision: "disk-rev",
          encoding: "utf-8",
          bom: false,
          localEditRevision: 4,
          revision: "surface-draft:ref:4",
        },
      }]);
      const reopened = await WorkingStateStore.open(h.context);
      expect(await reopened.getDraftBaseline(baseline.id)).toEqual(baseline);
      expect(h.database.prepare(`SELECT COUNT(*) AS count FROM object_references WHERE owner_kind = 'draft-baseline'`).get())
        .toEqual({ count: 1 });

      const state = baseline.pathStates["src/draft.ts"]!;
      if (state.kind !== "regular-file") throw new Error("expected regular draft state");
      await fs.promises.rm(objectPath(h.root, state.objectHash));
      await expect(reopened.getDraftBaseline(baseline.id)).rejects.toThrow("content is missing");
    } finally {
      h.database.close();
    }
  });

  it("rejects a branch whose draft closure is absent from its effective base", async () => {
    const h = await harness();
    try {
      await expect(h.store.createBranch("ws", "broken-draft", {}, "base", ["missing.ts"]))
        .rejects.toThrow("does not contain every draft baseline path");
      expect(h.store.getBranch("broken-draft")).toBeNull();
    } finally {
      h.database.close();
    }
  });

  it("does not publish captured directory bytes when the fixed source identity moved", async () => {
    const h = await harness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base\n");
      const base = await h.store.captureDirectory(h.workspace);
      await h.store.createBranch("ws", "fixed-source", base);
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "changed\n");
      await expect(h.store.publishDirectoryResult("fixed-source", h.workspace, ["a.txt"], {
        validateFixedSource: async () => false,
      })).rejects.toThrow("source changed");
      expect(h.store.listResults("fixed-source")).toEqual([]);
      expect(h.store.getBranch("fixed-source")).toMatchObject({ headRevision: 0, deltas: {} });
    } finally {
      h.database.close();
    }
  });

  it("rejects an obsolete schema instead of keeping an internal-format migration path", async () => {
    const h = await harness();
    try {
      await h.store.createBranch("ws", "legacy", {});
      const catalog = path.join(h.root, "working-state", `${createHash("sha256").update("ws").digest("hex")}.json`);
      const v1 = JSON.parse(await fs.promises.readFile(catalog, "utf8")) as Record<string, unknown>;
      v1.schemaVersion = 1;
      delete v1.draftBaselines;
      for (const branch of Object.values(v1.branches as Record<string, Record<string, unknown>>)) delete branch.draftBasePaths;
      await fs.promises.writeFile(catalog, JSON.stringify(v1), "utf8");

      await expect(WorkingStateStore.open(h.context)).rejects.toThrow("schema or workspace identity is malformed");
    } finally {
      h.database.close();
    }
  });

  it("rejects schema 4 flat maps instead of accepting a hidden second representation", async () => {
    const h = await harness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "draft.ts"), "draft\n");
      const draftBaseline = await h.store.createDraftBaseline("ws", [{
        path: "draft.ts",
        content: "draft\n",
        provenance: {
          baseRevision: null,
          encoding: "utf-8",
          bom: false,
          localEditRevision: 1,
          revision: "surface:1",
        },
      }]);
      const base = await h.store.captureDirectory(h.workspace);
      await h.store.createBranch("ws", "legacy-v2", base, "base", ["draft.ts"], ["ignored"]);
      const catalog = path.join(h.root, "working-state", `${createHash("sha256").update("ws").digest("hex")}.json`);
      const v2 = JSON.parse(await fs.promises.readFile(catalog, "utf8")) as Record<string, unknown>;
      const branch = (v2.branches as Record<string, Record<string, unknown>>)["legacy-v2"]!;
      branch.baseState = base;
      await fs.promises.writeFile(catalog, JSON.stringify(v2), "utf8");
      await expect(WorkingStateStore.open(h.context)).rejects.toThrow("must reference a state trie root");
      expect(draftBaseline.id).toBeTruthy();
    } finally {
      h.database.close();
    }
  });

  it("persists verification records without a schema bump and reopens them", async () => {
    const h = await harness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "base\n");
      const base = await h.store.captureDirectory(h.workspace);
      await h.store.createBranch("ws", "thread-1", base);
      await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "next\n");
      const published = await h.store.publishDirectoryResult("thread-1", h.workspace);
      await h.store.putChildVerification("thread-a", {
        resultRevision: published.resultRevision,
        branchId: "thread-1",
        resultTreeHash: h.store.resultTreeIdentity("thread-1", published.resultRevision)!,
        recordedAt: 1,
        binding: "bound",
        bindingReason: "same run",
        checks: [{
          id: "cmd-1",
          runId: "run-1",
          command: "bun test",
          cwd: h.workspace,
          startedAt: 1,
          endedAt: 2,
          exitCode: 0,
          cancelled: false,
          actor: { authorityInstanceId: "host", sessionId: "session", workerId: "worker", workerGeneration: 1, runId: "run-1" },
          bindingGeneration: 1,
          inputIdentity: {
            kind: "tree", branchId: "thread-1", root: h.workspace,
            startTreeHash: h.store.resultTreeIdentity("thread-1", published.resultRevision)!,
            endTreeHash: h.store.resultTreeIdentity("thread-1", published.resultRevision)!,
          },
          inputChangedDuringRun: false,
          relationToPublished: "same-run-matching-result",
        }],
      });
      const reopened = await WorkingStateStore.open(h.context);
      expect(reopened.getChildVerification("thread-a", published.resultRevision)?.checks[0]?.command).toBe("bun test");
      expect(reopened.getResult("thread-1", published.resultRevision)).toEqual(published);
    } finally {
      h.database.close();
    }
  });

  it("commits unpublished virtual writes with a single-writer CAS token", async () => {
    const h = await harness();
    try {
      await fs.promises.writeFile(path.join(h.workspace, "kept.txt"), "base\n");
      const base = await h.store.captureDirectory(h.workspace);
      await h.store.createBranch("ws", "thread-1", base);
      const first = await h.store.putObject(Buffer.from("child write\n"));
      expect(await h.store.commitVirtualWrite("thread-1", 0, "kept.txt", {
        kind: "regular-file",
        objectHash: first.hash,
        byteLength: first.byteLength,
      })).toEqual({ status: "committed", writeRevision: 1 });
      const stale = await h.store.putObject(Buffer.from("stale write\n"));
      expect(await h.store.commitVirtualWrite("thread-1", 0, "kept.txt", {
        kind: "regular-file",
        objectHash: stale.hash,
        byteLength: stale.byteLength,
      })).toEqual({ status: "conflict", writeRevision: 1 });
      const added = await h.store.putObject(Buffer.from("new file\n"));
      expect(await h.store.commitVirtualWrites("thread-1", 1, {
        "src/new.ts": { kind: "regular-file", objectHash: added.hash, byteLength: added.byteLength },
        "kept.txt": { kind: "missing" },
      })).toEqual({ status: "committed", writeRevision: 2 });
      expect(h.store.pathOrigin("thread-1", "src/new.ts")).toBe("delta");
      expect(h.store.effectiveState("thread-1")!["src/new.ts"]).toMatchObject({
        kind: "regular-file",
        mode: expect.any(Number),
      });
      expect(h.store.effectiveState("thread-1")!["kept.txt"]).toEqual({ kind: "missing" });
      expect(await fs.promises.readFile(path.join(h.workspace, "kept.txt"), "utf8")).toBe("base\n");
      const published = await h.store.publishHeadResult("thread-1");
      expect(published.changedPaths).toEqual(["kept.txt", "src/new.ts"]);
    } finally {
      h.database.close();
    }
  });

  it("projects the most recently merged parent operation instead of the highest result revision", async () => {
    const h = await harness();
    try {
      await h.store.putParentVerification("thread-a", {
        mergedResultRevision: 2, mergeOperationId: "merge-r2", windowOpenedAt: 10, recordedAt: 10,
        draftUnsaved: false, binding: "not-recorded", checks: [],
      });
      await h.store.putParentVerification("thread-a", {
        mergedResultRevision: 1, mergeOperationId: "merge-r1-later", windowOpenedAt: 20, recordedAt: 20,
        draftUnsaved: false, binding: "not-recorded", checks: [],
      });
      expect(h.store.getParentVerification("thread-a")).toMatchObject({
        mergedResultRevision: 1,
        mergeOperationId: "merge-r1-later",
      });
      expect(h.store.getParentVerification("thread-a", 2)?.mergeOperationId).toBe("merge-r2");
      await h.store.putParentVerification("thread-a", {
        mergedResultRevision: 2, mergeOperationId: "merge-r2", windowOpenedAt: 10, recordedAt: 30,
        draftUnsaved: false, binding: "bound", checks: [],
      });
      expect(h.store.getParentVerification("thread-a")?.mergeOperationId).toBe("merge-r1-later");
    } finally {
      h.database.close();
    }
  });

  it("stamps a new-file mode without creating a probe file in the user source root", async () => {
    const h = await harness();
    const writes: string[] = [];
    const store = await WorkingStateStore.open({
      ...h.context,
      fsPromises: {
        ...fs.promises,
        writeFile: (async (target: Parameters<typeof fs.promises.writeFile>[0], data: Parameters<typeof fs.promises.writeFile>[1], options?: Parameters<typeof fs.promises.writeFile>[2]) => {
          writes.push(String(target));
          return fs.promises.writeFile(target, data, options);
        }) as typeof fs.promises.writeFile,
      },
    });
    try {
      const before = await fs.promises.readdir(h.workspace);
      await fs.promises.writeFile(path.join(h.workspace, "kept.txt"), "base\n");
      const base = await store.captureDirectory(h.workspace);
      await store.createBranch("ws", "thread-mode", base);
      const added = await store.putObject(Buffer.from("new file\n"));
      await store.commitVirtualWrites("thread-mode", 0, {
        "fresh.ts": { kind: "regular-file", objectHash: added.hash, byteLength: added.byteLength },
      });
      expect(store.effectiveState("thread-mode")!["fresh.ts"]).toMatchObject({
        kind: "regular-file",
        mode: expect.any(Number),
      });
      expect(writes.some((file) => file.includes(".piarium-mode-probe-"))).toBe(false);
      const after = await fs.promises.readdir(h.workspace);
      expect(after.filter((name) => name.startsWith(".piarium-mode-probe-"))).toEqual([]);
      expect(before.filter((name) => name.startsWith(".piarium-mode-probe-"))).toEqual([]);
    } finally {
      h.database.close();
    }
  });
});
