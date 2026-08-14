import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ExtensionStorageRevisionConflictError,
  ExtensionStorageStore,
  WorkbenchProfileStore,
} from "../src/index.js";

const directories: string[] = [];
test.after(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))));

test("workbench layouts persist replacement choices and retain missing contribution references", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "piarium-workbench-profile-"));
  directories.push(dataDir);
  const storage = new ExtensionStorageStore(dataDir);
  const store = new WorkbenchProfileStore({
    hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a",
    storage,
  });
  const missing = await store.read();
  assert.equal(missing.storageState, "missing");
  const written = await store.updateLayout({
    expectedRevision: 0,
    layer: {
      profileId: "default",
      references: [{ contributionId: "dev.example.not-installed", region: "right" }],
      replacementSelections: { "workbench.shell": "dev.example.alternative-shell" },
      scope: "workspace",
      scopeId: "/workspace",
      surface: "web",
    },
  });
  assert.equal(written.document.revision, 1);
  const restarted = new WorkbenchProfileStore({ hostId: written.hostId, storage: new ExtensionStorageStore(dataDir) });
  assert.deepEqual((await restarted.read()).document.layouts, written.document.layouts);
  await assert.rejects(
    store.updateLayout({ expectedRevision: 0, layer: written.document.layouts[0] as never }),
    ExtensionStorageRevisionConflictError,
  );
});
