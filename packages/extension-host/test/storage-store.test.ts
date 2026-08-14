import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExtensionStorageStore } from "../src/index.js";

const directories: string[] = [];
const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "piarium-extension-storage-"));
  directories.push(directory);
  return directory;
};
test.after(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))));

const address = { extensionId: "dev.example.storage", key: "state", scope: "application" as const };

test("storage distinguishes missing data, preserves last valid state, and rolls back a first migration", async () => {
  const dataDir = await temporaryDirectory();
  const storage = new ExtensionStorageStore(dataDir);
  const missing = await storage.read(address);
  assert.equal(missing.storageState, "missing");
  assert.equal(missing.exists, false);
  const migration = await storage.prepareMigration(address, 1, ({ data }) => ({ ...data, ready: true }));
  assert.ok(migration);
  const committed = await migration.commit();
  assert.equal(committed.document.schemaVersion, 1);
  await migration.rollbackCommitted();
  const restored = await storage.read(address);
  assert.equal(restored.exists, false);
  assert.equal(restored.storageState, "missing");
});

test("failed migration and malformed replacement never become authoritative empty storage", async () => {
  const dataDir = await temporaryDirectory();
  const storage = new ExtensionStorageStore(dataDir);
  const written = await storage.update(address, 0, 1, { value: "kept" });
  await assert.rejects(
    storage.prepareMigration(address, 2, async () => { throw new Error("migration failed"); }),
    /migration failed/,
  );
  assert.deepEqual((await storage.read(address)).document.data, { value: "kept" });
  const directory = join(dataDir, "extensions", "storage", address.extensionId, address.scope);
  const [filename] = (await readdir(directory)).filter((value) => value.endsWith(".json"));
  assert.ok(filename);
  const path = join(directory, filename);
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  await writeFile(path, JSON.stringify({ ...raw, revision: written.document.revision, data: { value: "tampered" } }), "utf8");
  const stale = await storage.read(address);
  assert.equal(stale.authoritative, false);
  assert.equal(stale.storageState, "stale");
  assert.deepEqual(stale.document.data, { value: "kept" });
});

test("storage scopes and keys keep independent revisions and conflicts", async () => {
  const dataDir = await temporaryDirectory();
  const storage = new ExtensionStorageStore(dataDir);
  const profile = { extensionId: address.extensionId, key: "preferences", scope: "profile" as const };
  const workspace = { extensionId: address.extensionId, key: "preferences", scope: "workspace" as const };
  const alternate = { extensionId: address.extensionId, key: "layout", scope: "workspace" as const };
  const profileWritten = await storage.update(profile, 0, 1, { value: "profile" });
  const workspaceWritten = await storage.update(workspace, 0, 2, { value: "workspace" });
  const alternateWritten = await storage.update(alternate, 0, 1, { value: "layout" });
  assert.equal(profileWritten.document.revision, 1);
  assert.equal(workspaceWritten.document.revision, 1);
  assert.equal(alternateWritten.document.revision, 1);
  assert.deepEqual((await storage.read(profile)).document.data, { value: "profile" });
  assert.deepEqual((await storage.read(workspace)).document.data, { value: "workspace" });
  await assert.rejects(storage.update(workspace, 0, 2, { value: "stale" }), /expected revision 0, actual revision 1/i);
  assert.deepEqual((await storage.read(alternate)).document.data, { value: "layout" });
});

test("deleting extension data removes only the exact validated namespace and clears cached state", async () => {
  const dataDir = await temporaryDirectory();
  const storage = new ExtensionStorageStore(dataDir);
  const neighbor = { ...address, extensionId: "dev.example.storage-neighbor" };
  await storage.update(address, 0, 1, { value: "delete" });
  await storage.update(neighbor, 0, 1, { value: "keep" });
  await storage.deleteExtensionData(address.extensionId);
  assert.equal((await storage.read(address)).exists, false);
  assert.deepEqual((await storage.read(neighbor)).document.data, { value: "keep" });
  await assert.rejects(storage.deleteExtensionData("../escape"), /Invalid Piarium extension ID/);
});

test("prepared writes validate every address before committing the group", async () => {
  const dataDir = await temporaryDirectory();
  const storage = new ExtensionStorageStore(dataDir);
  const first = { ...address, key: "first" };
  const second = { ...address, key: "second", scope: "workspace" as const };
  await storage.update(first, 0, 1, { value: "old-first" });
  await storage.update(second, 0, 1, { value: "old-second" });
  const firstWrite = await storage.prepareWrite(first, 1, { value: "new-first" });
  const secondWrite = await storage.prepareWrite(second, 1, { value: "new-second" });
  await storage.update(second, 1, 1, { value: "concurrent" });
  await assert.rejects(storage.commitPrepared([firstWrite, secondWrite]), /expected revision 1, actual revision 2/i);
  assert.deepEqual((await storage.read(first)).document.data, { value: "old-first" });
  assert.deepEqual((await storage.read(second)).document.data, { value: "concurrent" });
});
