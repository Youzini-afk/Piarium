import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { rebaseBranchOntoParentRevision } from "./baseline-rebase.js";
import { WorkingStateStore } from "./working-state-store.js";
import { asTestWorkingStateRootStore } from "./working-state-root-adapter.test-helper.js";
import type { RecoveryState, WorkingStateRootStore } from "./types.js";
import { openRecoveryJournalCatalog, type SqliteDatabase } from "../../recovery/journal-catalog.js";
import { createRecoveryFileStore } from "../../recovery/file-store.test-helper.js";

const file = async (store: WorkingStateRootStore, text: string | Buffer, mode?: number): Promise<RecoveryState> => {
  const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : text;
  const object = await store.putObject(bytes);
  return { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength, ...(mode === undefined ? {} : { mode }) };
};

const headState = async (store: WorkingStateRootStore, branchId: string, revision?: number): Promise<Record<string, RecoveryState>> => {
  const read = await store.listPaths(branchId, [""], revision === undefined ? {} : { revision });
  if (!read) throw new Error(`Working branch not found: ${branchId}`);
  return Object.fromEntries(read.entries.map((entry) => [entry.path, entry.state]));
};

const textOf = async (store: WorkingStateRootStore, states: Record<string, RecoveryState>, file: string): Promise<string | null> => {
  const state = states[file];
  if (state?.kind !== "regular-file") return null;
  const bytes = await store.getObject(state.objectHash);
  return bytes?.toString("utf8") ?? null;
};

describe("baseline-rebase", () => {
  let tempDir: string;
  let store: WorkingStateStore;
  let rootStore: WorkingStateRootStore;
  let database: SqliteDatabase;

  const workspaceId = "ws-test";

  const createParent = async (entries: Record<string, RecoveryState>): Promise<void> => {
    await rootStore.createBranch(workspaceId, "parent", entries);
  };

  /** Publish the parent's current head as a new result revision. */
  const publishParent = async (): Promise<number> => {
    const result = await rootStore.publishHeadResult("parent");
    return result.resultRevision;
  };

  const forkChild = async (parentRevision: number): Promise<void> => {
    const pin = await rootStore.pinBranch("parent", { revision: parentRevision });
    try {
      await rootStore.createBranchFromPin(workspaceId, "child", pin, `parent@${parentRevision}`);
    } finally {
      await pin.release();
    }
  };

  const childWrite = async (entries: Record<string, RecoveryState>): Promise<void> => {
    const branch = await rootStore.getBranchRoot("child");
    const committed = await rootStore.commitVirtualWrites("child", branch!.writeRevision, entries);
    expect(committed.status).toBe("committed");
  };

  const parentWrite = async (entries: Record<string, RecoveryState>): Promise<void> => {
    const branch = await rootStore.getBranchRoot("parent");
    const committed = await rootStore.commitVirtualWrites("parent", branch!.writeRevision, entries);
    expect(committed.status).toBe("committed");
  };

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "varin-rebase-test-"));
    const workspace = path.join(tempDir, "workspace");
    const root = path.join(tempDir, "recovery");
    await fs.promises.mkdir(workspace, { recursive: true });
    database = (await openRecoveryJournalCatalog(root, { create: true }))!;
    store = await WorkingStateStore.open({
      database,
      fileStore: createRecoveryFileStore(),
      identity: { authorityId: "test", canonicalRoot: workspace, filesystemProfile: "test", workspaceId },
      resourceOperationGate: { run: async (_resources, operation) => operation() },
      root,
    });
    rootStore = asTestWorkingStateRootStore(store);
  });

  afterEach(async () => {
    database.close();
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("adopts parent-only changes while preserving child edits", async () => {
    await createParent({
      "shared.txt": await file(rootStore, "shared v1\n"),
      "parent-owned.txt": await file(rootStore, "parent v1\n"),
    });
    const r1 = await publishParent();
    await forkChild(r1);
    await childWrite({ "child-owned.txt": await file(rootStore, "child work\n") });

    await parentWrite({ "parent-owned.txt": await file(rootStore, "parent v2\n") });
    const r2 = await publishParent();

    const outcome = await rebaseBranchOntoParentRevision(rootStore, "child", "parent", r2);
    expect(outcome.status).toBe("committed");
    expect(outcome.updatedFromParent).toContain("parent-owned.txt");
    expect(outcome.updatedFromParent).not.toContain("shared.txt");
    expect(outcome.keptChildPaths).toContain("child-owned.txt");
    expect(outcome.conflicts).toEqual([]);

    const head = await headState(rootStore, "child");
    expect(await textOf(rootStore, head, "parent-owned.txt")).toBe("parent v2\n");
    expect(await textOf(rootStore, head, "child-owned.txt")).toBe("child work\n");
    expect(await textOf(rootStore, head, "shared.txt")).toBe("shared v1\n");

    const base = await headState(rootStore, "child", 0);
    expect(await textOf(rootStore, base, "parent-owned.txt")).toBe("parent v2\n");
  });

  it("merges disjoint text edits on the same file cleanly", async () => {
    await createParent({
      "doc.txt": await file(rootStore, "line1\nline2\nline3\nline4\nline5\n"),
    });
    const r1 = await publishParent();
    await forkChild(r1);

    await childWrite({ "doc.txt": await file(rootStore, "child-top\nline2\nline3\nline4\nline5\n") });
    await parentWrite({ "doc.txt": await file(rootStore, "line1\nline2\nline3\nline4\nparent-bottom\n") });
    const r2 = await publishParent();

    const outcome = await rebaseBranchOntoParentRevision(rootStore, "child", "parent", r2);
    expect(outcome.status).toBe("committed");
    expect(outcome.mergedPaths).toContain("doc.txt");
    expect(outcome.conflicts).toEqual([]);

    const head = await headState(rootStore, "child");
    expect(await textOf(rootStore, head, "doc.txt")).toBe("child-top\nline2\nline3\nline4\nparent-bottom\n");
  });

  it("keeps the child's bytes on conflicting text edits and reports the conflict", async () => {
    await createParent({ "doc.txt": await file(rootStore, "same line\n") });
    const r1 = await publishParent();
    await forkChild(r1);

    await childWrite({ "doc.txt": await file(rootStore, "child version\n") });
    await parentWrite({ "doc.txt": await file(rootStore, "parent version\n") });
    const r2 = await publishParent();

    const outcome = await rebaseBranchOntoParentRevision(rootStore, "child", "parent", r2);
    expect(outcome.status).toBe("committed");
    expect(outcome.conflicts.map((entry) => entry.path)).toContain("doc.txt");

    const head = await headState(rootStore, "child");
    expect(await textOf(rootStore, head, "doc.txt")).toBe("child version\n");
    const base = await headState(rootStore, "child", 0);
    expect(await textOf(rootStore, base, "doc.txt")).toBe("parent version\n");
  });

  it("reports binary, delete/edit, and type divergence without overwriting either side", async () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]);
    await createParent({
      "blob.bin": await file(rootStore, binary),
      "deleted-by-child.txt": await file(rootStore, "victim\n"),
      "type-mismatch.txt": await file(rootStore, "text\n"),
    });
    const r1 = await publishParent();
    await forkChild(r1);

    await childWrite({
      "blob.bin": await file(rootStore, Buffer.from([0x00, 0x09, 0x02, 0x03, 0xff])),
      "deleted-by-child.txt": { kind: "missing" },
      "type-mismatch.txt": { kind: "directory" },
    });
    await parentWrite({
      "blob.bin": await file(rootStore, Buffer.from([0x00, 0x01, 0x07, 0x03, 0xff])),
      "deleted-by-child.txt": await file(rootStore, "parent edited\n"),
      "type-mismatch.txt": await file(rootStore, "parent text\n"),
    });
    const r2 = await publishParent();

    const outcome = await rebaseBranchOntoParentRevision(rootStore, "child", "parent", r2);
    expect(outcome.status).toBe("committed");
    const conflictPaths = outcome.conflicts.map((entry) => entry.path);
    expect(conflictPaths).toEqual(expect.arrayContaining(["blob.bin", "deleted-by-child.txt", "type-mismatch.txt"]));

    const head = await headState(rootStore, "child");
    expect(head["blob.bin"]?.kind).toBe("regular-file");
    const blob = await store.getObject((head["blob.bin"] as { objectHash: string }).objectHash);
    expect([...(blob ?? [])]).toEqual([0x00, 0x09, 0x02, 0x03, 0xff]);
    expect(head["deleted-by-child.txt"]?.kind).toBe("missing");
    expect(head["type-mismatch.txt"]?.kind).toBe("directory");
  });

  it("surfaces a CAS conflict when the child changes mid-plan instead of committing", async () => {
    await createParent({ "a.txt": await file(rootStore, "a1\n") });
    const r1 = await publishParent();
    await forkChild(r1);
    await parentWrite({ "a.txt": await file(rootStore, "a2\n") });
    const r2 = await publishParent();

    const originalGetBranchRoot = rootStore.getBranchRoot;
    rootStore.getBranchRoot = async (branchId, options) => {
      const branch = await originalGetBranchRoot.call(rootStore, branchId, options);
      if (branchId === "child" && branch) {
        await rootStore.commitVirtualWrites("child", branch.writeRevision, {
          "raced.txt": await file(rootStore, "raced\n"),
        });
      }
      return branch;
    };
    let outcome;
    try {
      outcome = await rebaseBranchOntoParentRevision(rootStore, "child", "parent", r2);
    } finally {
      rootStore.getBranchRoot = originalGetBranchRoot;
    }
    expect(outcome.status).toBe("conflict");

    const head = await headState(rootStore, "child");
    expect(await textOf(rootStore, head, "a.txt")).toBe("a1\n");
    const base = await headState(rootStore, "child", 0);
    expect(await textOf(rootStore, base, "a.txt")).toBe("a1\n");
  });

  it("keeps older published results immutable after the baseline moves", async () => {
    await createParent({
      "shared.txt": await file(rootStore, "shared v1\n"),
      "evolving.txt": await file(rootStore, "evolving v1\n"),
    });
    const r1 = await publishParent();
    await forkChild(r1);
    await childWrite({ "child-file.txt": await file(rootStore, "child result content\n") });
    const childR1 = (await rootStore.publishHeadResult("child")).resultRevision;
    const childR1Result = (await rootStore.getResult("child", childR1))!;
    const childR1Base = childR1Result.baseStates["child-file.txt"];
    const childR1State = childR1Result.pathStates["child-file.txt"];

    await parentWrite({ "evolving.txt": await file(rootStore, "evolving v2\n") });
    const r2 = await publishParent();
    const outcome = await rebaseBranchOntoParentRevision(rootStore, "child", "parent", r2);
    expect(outcome.status).toBe("committed");

    await childWrite({ "child-file.txt": await file(rootStore, "child result v2\n") });
    const childR2 = (await rootStore.publishHeadResult("child")).resultRevision;
    expect(childR2).toBe(childR1 + 1);

    const r1After = (await rootStore.getResult("child", childR1))!;
    expect(r1After.baseStates["child-file.txt"]).toEqual(childR1Base);
    expect(r1After.pathStates["child-file.txt"]).toEqual(childR1State);
    expect(r1After.baseRevision ?? 0).toBe(0);

    const r2Result = (await rootStore.getResult("child", childR2))!;
    expect(r2Result.baseRevision).toBe(1);
    expect(r2Result.parentRef).toBe("parent@2");

    const r1View = await headState(rootStore, "child", childR1);
    expect(await textOf(rootStore, r1View, "evolving.txt")).toBe("evolving v1\n");
    expect(await textOf(rootStore, r1View, "child-file.txt")).toBe("child result content\n");
  });
});
