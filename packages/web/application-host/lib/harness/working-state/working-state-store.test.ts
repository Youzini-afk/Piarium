import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WorkingStateStore } from "./working-state-store.js";

describe("WorkingStateStore", () => {
  let tmpDir: string;
  let store: WorkingStateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-state-store-test-"));
    store = new WorkingStateStore({ storageDir: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("stores and retrieves content-addressed objects by SHA-256", async () => {
    const bytes = Buffer.from("test object content 123");
    const { hash, byteLength } = await store.putObject(bytes);

    expect(hash).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(byteLength).toBe(bytes.length);

    expect(await store.hasObject(hash)).toBe(true);
    const retrieved = await store.getObject(hash);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.equals(bytes)).toBe(true);

    const nonExistent = await store.getObject("sha256-0000000000000000000000000000000000000000000000000000000000000000");
    expect(nonExistent).toBeNull();
  });

  it("creates branches, updates deltas, and commits immutable revisions", () => {
    const branch = store.createBranch("ws-1", "branch-1", {
      "file1.txt": { kind: "regular-file", objectHash: "hash-base", byteLength: 10 },
    }, "base-commit-sha");

    expect(branch.branchId).toBe("branch-1");
    expect(branch.headRevision).toBe(0);
    expect(store.getBranch("branch-1")).toEqual(branch);

    // Update delta
    store.updateBranchDeltas("branch-1", {
      "file1.txt": { kind: "regular-file", objectHash: "hash-new", byteLength: 15 },
      "file2.txt": { kind: "regular-file", objectHash: "hash-2", byteLength: 20 },
    });

    // Commit revision
    const result = store.commitRevision("branch-1", ["file1.txt", "file2.txt"]);
    expect(result.resultRevision).toBe(1);
    expect(result.changedPaths).toEqual(["file1.txt", "file2.txt"]);
    expect(result.pathStates["file1.txt"]?.kind).toBe("regular-file");

    // Retrieve committed result
    const retrieved = store.getResult("branch-1", 1);
    expect(retrieved).toEqual(result);
  });

  it("captures directory contents into content-addressed states", async () => {
    const srcDir = path.join(tmpDir, "source-dir");
    await fs.mkdir(path.join(srcDir, "sub"), { recursive: true });
    await fs.writeFile(path.join(srcDir, "hello.txt"), "hello world");
    await fs.writeFile(path.join(srcDir, "sub", "deep.txt"), "deep nested file");

    const states = await store.captureDirectory(srcDir);
    expect(states["hello.txt"]?.kind).toBe("regular-file");
    expect(states["sub/deep.txt"]?.kind).toBe("regular-file");

    const helloHash = (states["hello.txt"] as { objectHash: string }).objectHash;
    const helloBytes = await store.getObject(helloHash);
    expect(helloBytes?.toString("utf8")).toBe("hello world");
  });

  it("persists branches and results to disk and reloads them across store instances", () => {
    store.createBranch("ws-1", "persisted-branch", {
      "foo.txt": { kind: "regular-file", objectHash: "hash-foo", byteLength: 5 },
    });
    store.updateBranchDeltas("persisted-branch", {
      "bar.txt": { kind: "regular-file", objectHash: "hash-bar", byteLength: 10 },
    });
    const result = store.commitRevision("persisted-branch", ["bar.txt"]);

    // Instantiate a new store with the same storageDir
    const store2 = new WorkingStateStore({ storageDir: tmpDir });
    const loadedBranch = store2.getBranch("persisted-branch");
    expect(loadedBranch).not.toBeNull();
    expect(loadedBranch?.branchId).toBe("persisted-branch");
    expect(loadedBranch?.headRevision).toBe(1);
    expect(loadedBranch?.deltas["bar.txt"]?.kind).toBe("regular-file");

    const loadedResult = store2.getResult("persisted-branch", 1);
    expect(loadedResult).not.toBeNull();
    expect(loadedResult?.resultRevision).toBe(1);
    expect(loadedResult?.changedPaths).toEqual(["bar.txt"]);
  });
});
