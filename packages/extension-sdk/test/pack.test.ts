import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("public SDK pack exports match the documented authoring surface", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    exports: Record<string, unknown>;
    files: string[];
  };
  assert.deepEqual(pkg.files, ["dist"]);
  assert.deepEqual(Object.keys(pkg.exports).sort(), [".", "./testing"]);
});
