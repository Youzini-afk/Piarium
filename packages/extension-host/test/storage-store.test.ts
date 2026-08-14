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
