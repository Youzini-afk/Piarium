import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ShadowGitStore } from "../src/shadow-git.js";

describe("ShadowGitStore", () => {
  it("captures and restores workspace files without touching ignored secrets or project git", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-shadow-git-"));
    const cwd = join(root, "项目 workspace");
    const shadow = join(root, "recovery", "shadow");
    await mkdir(join(cwd, ".git"), { recursive: true });
    await mkdir(join(cwd, "node_modules"), { recursive: true });
    await writeFile(join(cwd, ".gitignore"), "ignored.log\n", "utf8");
    await writeFile(join(cwd, ".git", "sentinel"), "project git", "utf8");
    await writeFile(join(cwd, ".env"), "TOKEN=before", "utf8");
    await writeFile(join(cwd, "node_modules", "keep.txt"), "dependency", "utf8");
    await writeFile(join(cwd, "ignored.log"), "ignored", "utf8");
    await writeFile(join(cwd, "alpha.txt"), "before", "utf8");
    await writeFile(join(cwd, "你好.txt"), "unicode", "utf8");

    try {
      const store = new ShadowGitStore({ cwd, root: shadow });
      const before = await store.snapshot("before");
      await writeFile(join(cwd, "alpha.txt"), "after", "utf8");
      await rm(join(cwd, "你好.txt"));
      await writeFile(join(cwd, "new.txt"), "new", "utf8");
      await writeFile(join(cwd, ".env"), "TOKEN=after", "utf8");
      const after = await store.snapshot("after");

      assert.notEqual(after, before);
      assert.deepEqual(await store.diff(after, before), [
        { kind: "modified", path: "alpha.txt" },
        { kind: "deleted", path: "new.txt" },
        { kind: "added", path: "你好.txt" },
      ]);

      await store.restore(before);
      assert.equal(await readFile(join(cwd, "alpha.txt"), "utf8"), "before");
      assert.equal(await readFile(join(cwd, "你好.txt"), "utf8"), "unicode");
      await assert.rejects(readFile(join(cwd, "new.txt"), "utf8"), /ENOENT/);
      assert.equal(await readFile(join(cwd, ".env"), "utf8"), "TOKEN=after");
      assert.equal(await readFile(join(cwd, ".git", "sentinel"), "utf8"), "project git");
      assert.equal(await readFile(join(cwd, "node_modules", "keep.txt"), "utf8"), "dependency");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
