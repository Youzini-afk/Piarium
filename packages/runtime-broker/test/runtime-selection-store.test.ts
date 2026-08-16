import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  loadRuntimeSelection,
  runtimeSelectionPath,
  saveRuntimeSelection,
} from "../src/runtime-selection-store.js";

test("treats a missing selection file as empty success", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "piarium-runtime-selection-"));
  try {
    assert.deepEqual(await loadRuntimeSelection(dataDir), { status: "missing" });
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("preserves malformed selection files instead of converting them to empty", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "piarium-runtime-selection-"));
  const path = runtimeSelectionPath(dataDir);
  try {
    await writeFile(path, "{not-json", "utf8");
    const loaded = await loadRuntimeSelection(dataDir);
    assert.equal(loaded.status, "malformed");
    assert.match(loaded.status === "malformed" ? loaded.issue : "", /JSON|Runtime selection/i);
    assert.equal(await readFile(path, "utf8"), "{not-json");
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("round-trips a selected custom package root", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "piarium-runtime-selection-"));
  try {
    await saveRuntimeSelection(dataDir, {
      selectedId: "custom:selected",
      customPackageRoot: "D:\\pi\\install",
    });
    const loaded = await loadRuntimeSelection(dataDir);
    assert.deepEqual(loaded, {
      selection: {
        customPackageRoot: "D:\\pi\\install",
        selectedId: "custom:selected",
      },
      status: "ok",
    });
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});
