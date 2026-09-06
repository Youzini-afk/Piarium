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

  it("migrates a schema v1 catalog to v2 with no draft baselines", async () => {
    const h = await harness();
    try {
      await h.store.createBranch("ws", "legacy", {});
      const catalog = path.join(h.root, "working-state", `${createHash("sha256").update("ws").digest("hex")}.json`);
      const v1 = JSON.parse(await fs.promises.readFile(catalog, "utf8")) as Record<string, unknown>;
      v1.schemaVersion = 1;
      delete v1.draftBaselines;
      for (const branch of Object.values(v1.branches as Record<string, Record<string, unknown>>)) delete branch.draftBasePaths;
      await fs.promises.writeFile(catalog, JSON.stringify(v1), "utf8");

      const migrated = await WorkingStateStore.open(h.context);
      expect(migrated.getBranch("legacy")?.draftBasePaths).toEqual([]);
      expect(await migrated.getDraftBaseline("missing")).toBeNull();
      await migrated.createBranch("ws", "next", {});
      const persisted = JSON.parse(await fs.promises.readFile(catalog, "utf8")) as Record<string, unknown>;
      expect(persisted.schemaVersion).toBe(2);
      expect(persisted.draftBaselines).toEqual({});
    } finally {
      h.database.close();
    }
  });
});
