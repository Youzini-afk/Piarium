import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listObjectReferences, openRecoveryJournalCatalog, replaceObjectReferences } from "../../recovery/journal-catalog.js";
import { createRecoveryFileStore } from "../../recovery/journal-files.js";
import { WorkingStateStore } from "./working-state-store.js";
import type { WorkspaceRecoveryStorageContext } from "../../recovery/journal-engine.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "piarium-state-retention-"));
  const database = await openRecoveryJournalCatalog(root, { create: true });
  if (!database) throw new Error("catalog missing");
  cleanups.push(async () => { database.close(); await fs.promises.rm(root, { recursive: true, force: true }); });
  const context: WorkspaceRecoveryStorageContext = {
    root, database, fileStore: createRecoveryFileStore(),
    identity: { workspaceId: "ws", authorityId: "host", canonicalRoot: root, filesystemProfile: "test" },
    resourceOperationGate: { run: async (_resources, operation) => operation() },
  };
  const store = await WorkingStateStore.open(context);
  await store.createBranch("ws", "branch", {});
  const state = async (text: string) => {
    const object = await store.putObject(Buffer.from(text));
    return { kind: "regular-file" as const, objectHash: object.hash, byteLength: object.byteLength, mode: 0o644 };
  };
  const old = await state("old value");
  const latest = await state("latest value");
  await store.publishStates("branch", { "a.txt": old });
  await store.publishStates("branch", { "a.txt": latest });
  const catalog = path.join(root, "working-state", `${createHash("sha256").update("ws").digest("hex")}.json`);
  const refs = (kind: string, id: string) => listObjectReferences(database, "ws", kind, id).map((ref) => ref.objectHash);
  const failCatalogWrite = (afterRename = false) => WorkingStateStore.open({
    ...context,
    fsPromises: {
      ...fs.promises,
      rename: async (from, to) => {
        if (String(to) !== catalog) return fs.promises.rename(from, to);
        if (afterRename) await fs.promises.rename(from, to);
        throw Object.assign(new Error("catalog I/O failure"), { code: "EIO" });
      },
    },
  });
  return { store, context, database, state, old, latest, catalog, refs, failCatalogWrite };
}

describe("working-state retention persistence", () => {
  it("keeps old metadata and ownership when deletion cannot publish the catalog", async () => {
    const h = await setup();
    const failing = await h.failCatalogWrite();
    await expect(failing.deleteResults("branch", [1])).rejects.toThrow("catalog I/O failure");
    const reopened = await WorkingStateStore.open(h.context);
    expect(reopened.getResult("branch", 1)).not.toBeNull();
    expect(h.refs("thread-result", "branch@1")).toContain(h.old.objectHash);
    expect((await reopened.getObject(h.old.objectHash))?.toString()).toBe("old value");
  });

  it("repairs a crash between durable metadata removal and reference removal without touching another owner", async () => {
    const h = await setup();
    replaceObjectReferences(h.database, "other-workspace", "work-branch", "other-branch", [
      { slot: "shared", objectHash: h.old.objectHash },
    ]);
    h.database.exec(`CREATE TRIGGER fail_reference_removal BEFORE DELETE ON object_references
      WHEN OLD.owner_kind = 'thread-result' BEGIN SELECT RAISE(ABORT, 'reference cleanup interrupted'); END;`);
    await expect(h.store.deleteResults("branch", [1])).rejects.toThrow("reference cleanup interrupted");
    const reopened = await WorkingStateStore.open(h.context);
    expect(reopened.getResult("branch", 1)).toBeNull();
    expect(h.refs("thread-result", "branch@1")).toContain(h.old.objectHash);
    h.database.exec("DROP TRIGGER fail_reference_removal");
    await reopened.reconcileObjectReferences();
    expect(h.refs("thread-result", "branch@1")).toEqual([]);
    expect(h.refs("thread-result", "branch@2")).toContain(h.latest.objectHash);
    expect(listObjectReferences(h.database, "other-workspace", "work-branch", "other-branch"))
      .toEqual([{ slot: "shared", objectHash: h.old.objectHash }]);
    expect(await reopened.deleteResults("branch", [1])).toEqual([]);
  });

  it.each([false, true])("protects both sides when branch publication fails (after rename: %s)", async (afterRename) => {
    const h = await setup();
    const candidate = await h.state("unpublished candidate");
    const failing = await h.failCatalogWrite(afterRename);
    await expect(failing.commitVirtualWrites("branch", 0, { "a.txt": candidate })).rejects.toThrow("catalog I/O failure");
    expect(h.refs("work-branch", "branch")).toContain(h.latest.objectHash);
    const pending = h.database.prepare("SELECT object_hash FROM object_references WHERE owner_kind = 'working-state-write'").all();
    expect(pending).toContainEqual({ object_hash: candidate.objectHash });
    const reopened = await WorkingStateStore.open(h.context);
    await reopened.reconcileObjectReferences();
    expect(reopened.effectiveState("branch")?.["a.txt"]).toMatchObject({
      objectHash: afterRename ? candidate.objectHash : h.latest.objectHash,
    });
    expect(h.refs("work-branch", "branch")).toContain(afterRename ? candidate.objectHash : h.latest.objectHash);
    expect(h.database.prepare("SELECT COUNT(*) AS count FROM object_references WHERE owner_kind = 'working-state-write'").get())
      .toEqual({ count: 0 });
  });

  it("does not interpret a missing or null catalog as permission to release retained content", async () => {
    const h = await setup();
    await fs.promises.rm(h.catalog);
    const missing = await WorkingStateStore.open(h.context);
    await expect(missing.reconcileObjectReferences()).rejects.toThrow("catalog is missing");
    expect(h.refs("thread-result", "branch@1")).toContain(h.old.objectHash);
    await fs.promises.writeFile(h.catalog, "null");
    await expect(WorkingStateStore.open(h.context)).rejects.toThrow("catalog is malformed");
    expect(h.refs("thread-result", "branch@1")).toContain(h.old.objectHash);
  });
});
