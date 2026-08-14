import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PiariumExtensionInstallationRecord } from "@piarium/extension-contract";
import {
  ApplicationExtensionCatalog,
  ExtensionCatalogRevisionConflictError,
  ExtensionCatalogStorageError,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "piarium-extension-host-"));
  temporaryDirectories.push(directory);
  return directory;
}

function installation(id = "dev.example.extension"): PiariumExtensionInstallationRecord {
  const now = "2026-08-14T00:00:00.000Z";
  return {
    manifest: {
      schemaVersion: 1,
      id,
      version: "1.0.0",
      engines: { piarium: ">=0.1.0" },
      entrypoints: { surfaces: [{ id: "main", mode: "managed", file: "dist/main.mjs", supports: ["web"] }] },
    },
    source: { kind: "npm", specifier: `npm:${id}`, display: `npm:${id}` },
    resolvedVersion: "1.0.0",
    selectedVersion: "1.0.0",
    desired: { enabled: true, revision: 1, updatedAt: now },
    capabilityGrants: [],
    installedAt: now,
    updatedAt: now,
  };
}

test.after(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("distinguishes a missing catalog from a persisted empty catalog", async () => {
  const dataDir = await temporaryDirectory();
  const catalog = new ApplicationExtensionCatalog({ dataDir });
  const missing = await catalog.snapshot();
  assert.equal(missing.storageState, "missing");
  assert.equal(missing.authoritative, true);
  assert.deepEqual(missing.extensions, []);

  const persisted = await catalog.upsert(installation(), 0);
  const empty = await catalog.remove("dev.example.extension", persisted.revision);
  assert.equal(empty.storageState, "ready");
  assert.equal(empty.authoritative, true);
  assert.deepEqual(empty.extensions, []);

  await writeFile(catalog.store.catalogPath, JSON.stringify({
    schemaVersion: 1,
    revision: 0,
    updatedAt: "2026-08-14T00:00:00.000Z",
    extensions: {},
  }), "utf8");
  const freshHostView = new ApplicationExtensionCatalog({ dataDir });
  const persistedRevisionZero = await freshHostView.setAllEnabled(false, 0);
  assert.equal(persistedRevisionZero.storageState, "ready");
});

test("preserves the last valid catalog when the file becomes malformed or disappears", async () => {
  const catalog = new ApplicationExtensionCatalog({ dataDir: await temporaryDirectory() });
  const installed = await catalog.upsert(installation(), 0);
  assert.equal(installed.extensions.length, 1);

  await writeFile(catalog.store.catalogPath, "{ malformed", "utf8");
  const malformed = await catalog.snapshot();
  assert.equal(malformed.storageState, "stale");
  assert.equal(malformed.authoritative, false);
  assert.equal(malformed.extensions.length, 1);

  await unlink(catalog.store.catalogPath);
  const disappeared = await catalog.snapshot();
  assert.equal(disappeared.storageState, "stale");
  assert.equal(disappeared.extensions.length, 1);
});

test("reports initial malformed storage as failure rather than an empty catalog", async () => {
  const directory = await temporaryDirectory();
  const catalog = new ApplicationExtensionCatalog({ dataDir: directory });
  await catalog.store.getHostIdentity();
  await writeFile(catalog.store.catalogPath, "[]", "utf8");
  await assert.rejects(() => catalog.snapshot(), ExtensionCatalogStorageError);
});

test("serializes mutations and rejects a stale expected revision", async () => {
  const catalog = new ApplicationExtensionCatalog({ dataDir: await temporaryDirectory() });
  const installed = await catalog.upsert(installation(), 0);
  const enabled = installed.extensions[0]?.desired.enabled;
  assert.equal(enabled, true);

  const first = await catalog.setEnabled("dev.example.extension", false, installed.revision);
  await assert.rejects(
    () => catalog.setEnabled("dev.example.extension", true, installed.revision),
    ExtensionCatalogRevisionConflictError,
  );
  const stored = JSON.parse(await readFile(catalog.store.catalogPath, "utf8")) as { revision: number };
  assert.equal(stored.revision, first.revision);
  assert.equal((await catalog.snapshot()).extensions[0]?.desired.enabled, false);
});
