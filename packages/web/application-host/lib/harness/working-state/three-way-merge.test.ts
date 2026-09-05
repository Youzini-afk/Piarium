import { describe, expect, it } from "vitest";
import {
  isBinaryBuffer,
  mergeText3Way,
  planThreeWayPath,
  buildThreeWayMergePlan,
} from "./three-way-merge.js";
import type { RecoveryState } from "./types.js";

describe("three-way-merge", () => {
  it("detects binary buffers containing null bytes", () => {
    expect(isBinaryBuffer(Buffer.from("hello world"))).toBe(false);
    expect(isBinaryBuffer(Buffer.from([0x00, 0x01, 0x02]))).toBe(true);
    expect(isBinaryBuffer(Buffer.from("text\0more"))).toBe(true);
  });

  describe("mergeText3Way", () => {
    it("returns clean child when parent equals base", () => {
      const res = mergeText3Way("base", "base", "child");
      expect(res.clean).toBe(true);
      expect(res.text).toBe("child");
    });

    it("returns clean parent when child equals base", () => {
      const res = mergeText3Way("base", "parent", "base");
      expect(res.clean).toBe(true);
      expect(res.text).toBe("parent");
    });

    it("returns clean when parent and child make the same change", () => {
      const res = mergeText3Way("base", "modified", "modified");
      expect(res.clean).toBe(true);
      expect(res.text).toBe("modified");
    });

    it("merges non-overlapping changes cleanly", () => {
      const base = "line1\nline2\nline3";
      const parent = "parent1\nline2\nline3";
      const child = "line1\nline2\nchild3";
      const res = mergeText3Way(base, parent, child);
      expect(res.clean).toBe(true);
      expect(res.text).toBe("parent1\nline2\nchild3");
    });

    it("injects conflict markers for overlapping contradictory changes", () => {
      const base = "line1\nline2\nline3";
      const parent = "line1\nparent2\nline3";
      const child = "line1\nchild2\nline3";
      const res = mergeText3Way(base, parent, child);
      expect(res.clean).toBe(false);
      expect(res.text).toContain("<<<<<<< parent\nparent2\n=======\nchild2\n>>>>>>> child");
    });
  });

  describe("planThreeWayPath", () => {
    const fileState = (hash: string, mode = 0o644): RecoveryState => ({
      kind: "regular-file",
      objectHash: hash,
      byteLength: 10,
      mode,
    });
    const missingState: RecoveryState = { kind: "missing" };

    it("marks identical when parent equals child", async () => {
      const plan = await planThreeWayPath({
        path: "a.txt",
        baseState: fileState("hash-base"),
        parentState: fileState("hash-1"),
        childState: fileState("hash-1"),
        readContent: async () => Buffer.from("content"),
      });
      expect(plan.decision).toBe("identical");
    });

    it("applies child when parent is unchanged from base", async () => {
      const plan = await planThreeWayPath({
        path: "a.txt",
        baseState: fileState("hash-base"),
        parentState: fileState("hash-base"),
        childState: fileState("hash-child"),
        readContent: async () => Buffer.from("content"),
      });
      expect(plan.decision).toBe("apply-child");
    });

    it("keeps parent when child is unchanged from base", async () => {
      const plan = await planThreeWayPath({
        path: "a.txt",
        baseState: fileState("hash-base"),
        parentState: fileState("hash-parent"),
        childState: fileState("hash-base"),
        readContent: async () => Buffer.from("content"),
      });
      expect(plan.decision).toBe("keep-parent");
    });

    it("merges cleanly when text changes do not overlap", async () => {
      const base = "line1\nline2\nline3";
      const parent = "parent1\nline2\nline3";
      const child = "line1\nline2\nchild3";

      const plan = await planThreeWayPath({
        path: "a.txt",
        baseState: fileState("h-base"),
        parentState: fileState("h-parent"),
        childState: fileState("h-child"),
        readContent: async (s) => {
          if (s === missingState) return null;
          if ((s as any).objectHash === "h-base") return Buffer.from(base);
          if ((s as any).objectHash === "h-parent") return Buffer.from(parent);
          if ((s as any).objectHash === "h-child") return Buffer.from(child);
          return null;
        },
      });

      expect(plan.decision).toBe("merge-clean");
      expect(plan.mergedText).toBe("parent1\nline2\nchild3");
    });

    it("flags conflict for binary files modified on both sides", async () => {
      const bin1 = Buffer.from([0x00, 0x01, 0x02]);
      const bin2 = Buffer.from([0x00, 0x01, 0x03]);

      const plan = await planThreeWayPath({
        path: "a.bin",
        baseState: fileState("h-base"),
        parentState: fileState("h-parent"),
        childState: fileState("h-child"),
        readContent: async (s) => {
          if ((s as any).objectHash === "h-base") return Buffer.from([0x00, 0x00]);
          if ((s as any).objectHash === "h-parent") return bin1;
          return bin2;
        },
      });

      expect(plan.decision).toBe("conflict");
      expect(plan.conflictReason).toContain("Binary");
    });

    it("flags structural conflict when deleted on one side and modified on the other", async () => {
      const plan = await planThreeWayPath({
        path: "a.txt",
        baseState: fileState("h-base"),
        parentState: missingState,
        childState: fileState("h-child"),
        readContent: async () => Buffer.from("child content"),
      });

      expect(plan.decision).toBe("conflict");
      expect(plan.conflictReason).toContain("deleted");
    });
  });

  describe("buildThreeWayMergePlan", () => {
    it("aggregates applied and conflict paths", async () => {
      const plan = await buildThreeWayMergePlan({
        operationId: "op-1",
        workspaceId: "ws-1",
        threadId: "th-1",
        resultRevision: 1,
        allPaths: ["clean.txt", "conflict.txt"],
        baseState: {
          "clean.txt": { kind: "regular-file", objectHash: "b-clean", byteLength: 4 },
          "conflict.txt": { kind: "regular-file", objectHash: "b-conf", byteLength: 4 },
        },
        parentState: {
          "clean.txt": { kind: "regular-file", objectHash: "b-clean", byteLength: 4 },
          "conflict.txt": { kind: "regular-file", objectHash: "p-conf", byteLength: 6 },
        },
        childState: {
          "clean.txt": { kind: "regular-file", objectHash: "c-clean", byteLength: 7 },
          "conflict.txt": { kind: "missing" },
        },
        readContent: async (s) => Buffer.from("test"),
      });

      expect(plan.clean).toBe(false);
      expect(plan.appliedPaths).toEqual(["clean.txt"]);
      expect(plan.conflictPaths).toEqual(["conflict.txt"]);
      expect(plan.diffStats.files).toBe(2);
    });
  });
});
