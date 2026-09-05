import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { materializeWorkingState } from "./materializer.js";
import type { RecoveryState } from "./types.js";

describe("materializer", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "piarium-materializer-test-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("materializes regular files and creates parent directories", async () => {
    const states: Record<string, RecoveryState> = {
      "src/index.ts": {
        kind: "regular-file",
        objectHash: "hash-index",
        byteLength: 20,
      },
      "README.md": {
        kind: "regular-file",
        objectHash: "hash-readme",
        byteLength: 12,
      },
    };

    const contentMap: Record<string, Buffer> = {
      "hash-index": Buffer.from("console.log('hi');\n"),
      "hash-readme": Buffer.from("# Hello World"),
    };

    const result = await materializeWorkingState({
      targetDir: tempDir,
      states,
      readContent: async (state) => {
        if (state.kind === "regular-file") {
          return contentMap[state.objectHash] ?? null;
        }
        return null;
      },
    });

    expect(result.materializedPaths).toContain("src/index.ts");
    expect(result.materializedPaths).toContain("README.md");

    const readIndex = await fs.promises.readFile(path.join(tempDir, "src", "index.ts"), "utf8");
    const readReadme = await fs.promises.readFile(path.join(tempDir, "README.md"), "utf8");
    expect(readIndex).toBe("console.log('hi');\n");
    expect(readReadme).toBe("# Hello World");
  });

  it("cleans unreferenced leftover files when cleanUnreferenced is true", async () => {
    // Write an old file that should be removed
    const oldFile = path.join(tempDir, "old-unreferenced.txt");
    await fs.promises.writeFile(oldFile, "to be deleted");

    const states: Record<string, RecoveryState> = {
      "new-file.txt": {
        kind: "regular-file",
        objectHash: "hash-new",
        byteLength: 7,
      },
    };

    const result = await materializeWorkingState({
      targetDir: tempDir,
      states,
      cleanUnreferenced: true,
      readContent: async () => Buffer.from("content"),
    });

    expect(result.cleanedPaths).toContain("old-unreferenced.txt");
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(path.join(tempDir, "new-file.txt"))).toBe(true);
  });

  it("removes files explicitly marked as missing", async () => {
    const existingFile = path.join(tempDir, "deleted.txt");
    await fs.promises.writeFile(existingFile, "exists initially");

    const states: Record<string, RecoveryState> = {
      "deleted.txt": { kind: "missing" },
    };

    const result = await materializeWorkingState({
      targetDir: tempDir,
      states,
      readContent: async () => null,
    });

    expect(result.removedPaths).toContain("deleted.txt");
    expect(fs.existsSync(existingFile)).toBe(false);
  });

  it("materializes symlinks if supported by platform", async () => {
    const states: Record<string, RecoveryState> = {
      "target.txt": {
        kind: "regular-file",
        objectHash: "hash-target",
        byteLength: 6,
      },
      "link-to-target.txt": {
        kind: "symlink",
        symlinkTarget: "target.txt",
      },
    };

    try {
      await materializeWorkingState({
        targetDir: tempDir,
        states,
        readContent: async () => Buffer.from("target"),
      });

      const stat = await fs.promises.lstat(path.join(tempDir, "link-to-target.txt"));
      expect(stat.isSymbolicLink()).toBe(true);
      const target = await fs.promises.readlink(path.join(tempDir, "link-to-target.txt"));
      expect(target).toBe("target.txt");
    } catch (err) {
      if (process.platform === "win32") {
        // Windows without developer mode may fail symlinks with EPERM
        return;
      }
      throw err;
    }
  });
});
