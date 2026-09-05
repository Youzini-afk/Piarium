import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openRecoveryJournalCatalog } from "../../recovery/journal-catalog.js";
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
});
