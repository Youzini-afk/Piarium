import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppStore } from "../src/main/app-store.js";

it("persists the app recovery default and safely migrates older state", async () => {
  const root = await mkdtemp(join(tmpdir(), "piarium-app-store-"));
  const path = join(root, "piarium.json");
  try {
    await writeFile(path, '{"version":1,"recentProjects":[]}\n', "utf8");
    const migrated = new AppStore(path);
    await migrated.load();
    assert.equal(migrated.getPreferences().recoveryDefault, "ask");
    await migrated.setRecoveryDefault("both");

    const reopened = new AppStore(path);
    await reopened.load();
    assert.equal(reopened.getPreferences().recoveryDefault, "both");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
