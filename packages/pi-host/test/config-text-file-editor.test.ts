import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConfigTextFileEditor } from "../src/config-text-file-editor.js";

describe("ConfigTextFileEditor", () => {
  it("preserves a complete JSONC document and detects stale writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-config-text-"));
    const path = join(root, ".cortexkit", "magic-context.jsonc");
    const editor = new ConfigTextFileEditor(path, "jsonc");
    try {
      const missing = await editor.read();
      assert.equal(missing.exists, false);
      const content = "{\n  // Plugin-owned option\n  \"todowrite\": { \"enabled\": true, },\n}\n";
      const saved = await editor.update(content, missing.revision);
      assert.equal(saved.exists, true);
      assert.equal(await readFile(path, "utf8"), content);

      await writeFile(path, "{ \"enabled\": false }\n", "utf8");
      await assert.rejects(
        editor.update("{ \"enabled\": true }\n", saved.revision),
        /changed since it was opened/,
      );
      assert.equal(await readFile(path, "utf8"), "{ \"enabled\": false }\n");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects invalid JSONC without replacing the current file", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-config-text-invalid-"));
    const path = join(root, "config.jsonc");
    const editor = new ConfigTextFileEditor(path, "jsonc");
    try {
      await writeFile(path, "{}\n", "utf8");
      const current = await editor.read();
      await assert.rejects(editor.update("{ nope", current.revision), /not valid JSONC/);
      assert.equal(await readFile(path, "utf8"), "{}\n");

      await writeFile(path, "{ broken", "utf8");
      assert.equal((await editor.read()).content, "{ broken");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
