import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { IntegrationCoordinator } from "./integration-coordinator.js";
import type { ThreeWayMergePlan } from "./types.js";

describe("IntegrationCoordinator", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-integration-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("applies clean child changes and clean text merges", async () => {
    // Setup initial parent workspace
    await fs.writeFile(path.join(tmpDir, "existing.txt"), "line 1\nline 2\nline 3\n");
    await fs.writeFile(path.join(tmpDir, "to_delete.txt"), "delete me\n");

    const contentMap = new Map<string, Buffer>();
    contentMap.set("hash-new", Buffer.from("hello from child\n"));

    const coordinator = new IntegrationCoordinator({
      workspaceRoot: tmpDir,
      readContent: async (state) => {
        if (state.kind === "regular-file" && contentMap.has(state.objectHash)) {
          return contentMap.get(state.objectHash)!;
        }
        return null;
      },
    });

    const plan: ThreeWayMergePlan = {
      operationId: "op-1",
      workspaceId: "ws-1",
      threadId: "th-1",
      resultRevision: 1,
      clean: true,
      paths: [
        {
          path: "new_file.txt",
          decision: "apply-child",
          baseState: { kind: "missing" },
          parentState: { kind: "missing" },
          childState: { kind: "regular-file", objectHash: "hash-new", byteLength: 17 },
          isText: true,
        },
        {
          path: "existing.txt",
          decision: "merge-clean",
          baseState: { kind: "regular-file", objectHash: "hash-base", byteLength: 21 },
          parentState: { kind: "regular-file", objectHash: "hash-parent", byteLength: 21 },
          childState: { kind: "regular-file", objectHash: "hash-child", byteLength: 21 },
          mergedText: "line 1\nline 2 merged\nline 3\n",
          isText: true,
        },
        {
          path: "to_delete.txt",
          decision: "apply-child",
          baseState: { kind: "regular-file", objectHash: "hash-del", byteLength: 10 },
          parentState: { kind: "regular-file", objectHash: "hash-del", byteLength: 10 },
          childState: { kind: "missing" },
          isText: true,
        },
      ],
      appliedPaths: ["new_file.txt", "existing.txt", "to_delete.txt"],
      conflictPaths: [],
      diffStats: { files: 3, insertions: 2, deletions: 1 },
    };

    const result = await coordinator.apply(plan);
    expect(result.status).toBe("applied");
    expect(result.appliedPaths).toEqual(["new_file.txt", "existing.txt", "to_delete.txt"]);

    // Verify files on disk
    expect(await fs.readFile(path.join(tmpDir, "new_file.txt"), "utf8")).toBe("hello from child\n");
    expect(await fs.readFile(path.join(tmpDir, "existing.txt"), "utf8")).toBe("line 1\nline 2 merged\nline 3\n");
    await expect(fs.stat(path.join(tmpDir, "to_delete.txt"))).rejects.toThrow();
  });

  it("writes conflict markers for text conflicts and leaves non-text conflicts untouched", async () => {
    await fs.writeFile(path.join(tmpDir, "conflict_text.txt"), "parent line\n");
    await fs.writeFile(path.join(tmpDir, "binary_file.bin"), Buffer.from([1, 2, 3]));

    const coordinator = new IntegrationCoordinator({
      workspaceRoot: tmpDir,
      readContent: async () => null,
    });

    const conflictMarkers = "<<<<<<< parent\nparent line\n=======\nchild line\n>>>>>>> child\n";
    const plan: ThreeWayMergePlan = {
      operationId: "op-2",
      workspaceId: "ws-1",
      threadId: "th-1",
      resultRevision: 2,
      clean: false,
      paths: [
        {
          path: "conflict_text.txt",
          decision: "conflict",
          conflictMarkers,
          conflictReason: "Text divergence",
          baseState: { kind: "regular-file", objectHash: "base", byteLength: 5 },
          parentState: { kind: "regular-file", objectHash: "parent", byteLength: 12 },
          childState: { kind: "regular-file", objectHash: "child", byteLength: 11 },
          isText: true,
        },
        {
          path: "binary_file.bin",
          decision: "conflict",
          conflictReason: "Binary conflict",
          baseState: { kind: "regular-file", objectHash: "base-bin", byteLength: 3 },
          parentState: { kind: "regular-file", objectHash: "parent-bin", byteLength: 3 },
          childState: { kind: "regular-file", objectHash: "child-bin", byteLength: 3 },
          isText: false,
        },
      ],
      appliedPaths: [],
      conflictPaths: ["conflict_text.txt", "binary_file.bin"],
      diffStats: { files: 2, insertions: 1, deletions: 0 },
    };

    const result = await coordinator.apply(plan);
    expect(result.status).toBe("conflict");
    expect(result.conflictPaths).toEqual(["conflict_text.txt", "binary_file.bin"]);

    // Text file should have conflict markers
    expect(await fs.readFile(path.join(tmpDir, "conflict_text.txt"), "utf8")).toBe(conflictMarkers);
    // Binary file should be untouched
    const binaryContent = await fs.readFile(path.join(tmpDir, "binary_file.bin"));
    expect(binaryContent.equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it("triggers conditional compensation on unexpected I/O failure and restores before-state", async () => {
    await fs.writeFile(path.join(tmpDir, "file_a.txt"), "original a\n");

    const contentMap = new Map<string, Buffer>();
    contentMap.set("hash-a", Buffer.from("modified a\n"));

    const coordinator = new IntegrationCoordinator({
      workspaceRoot: tmpDir,
      readContent: async (state) => {
        if (state.kind === "regular-file") {
          if (state.objectHash === "hash-a") return contentMap.get("hash-a")!;
          if (state.objectHash === "hash-fail") {
            throw new Error("Disk error reading blob");
          }
        }
        return null;
      },
    });

    const plan: ThreeWayMergePlan = {
      operationId: "op-3",
      workspaceId: "ws-1",
      threadId: "th-1",
      resultRevision: 3,
      clean: true,
      paths: [
        {
          path: "file_a.txt",
          decision: "apply-child",
          baseState: { kind: "regular-file", objectHash: "base", byteLength: 11 },
          parentState: { kind: "regular-file", objectHash: "parent", byteLength: 11 },
          childState: { kind: "regular-file", objectHash: "hash-a", byteLength: 11 },
          isText: true,
        },
        {
          path: "file_b.txt",
          decision: "apply-child",
          baseState: { kind: "missing" },
          parentState: { kind: "missing" },
          childState: { kind: "regular-file", objectHash: "hash-fail", byteLength: 10 },
          isText: true,
        },
      ],
      appliedPaths: ["file_a.txt", "file_b.txt"],
      conflictPaths: [],
      diffStats: { files: 2, insertions: 2, deletions: 0 },
    };

    const result = await coordinator.apply(plan);
    expect(result.status).toBe("compensated");
    expect(result.compensatedPaths).toContain("file_a.txt");

    // file_a.txt should be compensated back to "original a\n"
    expect(await fs.readFile(path.join(tmpDir, "file_a.txt"), "utf8")).toBe("original a\n");
    // file_b.txt should not exist
    await expect(fs.stat(path.join(tmpDir, "file_b.txt"))).rejects.toThrow();
  });

  it("does not overwrite subsequent user edits during compensation and reports needs-attention", async () => {
    await fs.writeFile(path.join(tmpDir, "file_user.txt"), "before state\n");

    const contentMap = new Map<string, Buffer>();
    contentMap.set("hash-write", Buffer.from("attempted write\n"));

    let coordinator: IntegrationCoordinator;
    coordinator = new IntegrationCoordinator({
      workspaceRoot: tmpDir,
      readContent: async (state) => {
        if (state.kind === "regular-file") {
          if (state.objectHash === "hash-write") {
            return contentMap.get("hash-write")!;
          }
          if (state.objectHash === "hash-trigger-fail") {
            // Simulate user modifying file_user.txt after our write before compensation runs
            await fs.writeFile(path.join(tmpDir, "file_user.txt"), "user edited this file concurrently!");
            throw new Error("Simulated failure on second file");
          }
        }
        return null;
      },
    });

    const plan: ThreeWayMergePlan = {
      operationId: "op-user-edit",
      workspaceId: "ws-1",
      threadId: "th-1",
      resultRevision: 4,
      clean: true,
      paths: [
        {
          path: "file_user.txt",
          decision: "apply-child",
          baseState: { kind: "regular-file", objectHash: "base", byteLength: 13 },
          parentState: { kind: "regular-file", objectHash: "parent", byteLength: 13 },
          childState: { kind: "regular-file", objectHash: "hash-write", byteLength: 16 },
          isText: true,
        },
        {
          path: "file_fail.txt",
          decision: "apply-child",
          baseState: { kind: "missing" },
          parentState: { kind: "missing" },
          childState: { kind: "regular-file", objectHash: "hash-trigger-fail", byteLength: 10 },
          isText: true,
        },
      ],
      appliedPaths: ["file_user.txt", "file_fail.txt"],
      conflictPaths: [],
      diffStats: { files: 2, insertions: 2, deletions: 0 },
    };

    const result = await coordinator.apply(plan);
    expect(result.status).toBe("needs-attention");
    expect(result.needsAttentionPaths).toEqual(["file_user.txt"]);
    expect(result.compensatedPaths).toEqual([]);

    // The user edit must be preserved on disk! Not reverted to "before state\n"
    expect(await fs.readFile(path.join(tmpDir, "file_user.txt"), "utf8")).toBe(
      "user edited this file concurrently!"
    );

    // Verify journal file was written
    const journalPath = path.join(tmpDir, ".piarium", "journal", "operations", "op-user-edit.json");
    const journalContent = JSON.parse(await fs.readFile(journalPath, "utf8"));
    expect(journalContent.operationId).toBe("op-user-edit");
    expect(journalContent.status).toBe("needs-attention");
    expect(journalContent.needsAttentionPaths).toEqual(["file_user.txt"]);
  });
});
