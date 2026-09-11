import { describe, expect, it } from "vitest";
import { assertVirtualWriteTree, liveViewRevision, VirtualWriteTreeError } from "./virtual-write-tree.js";

describe("virtual write tree invariants", () => {
  it("labels the live view with writeRevision rather than a published head", () => {
    expect(liveViewRevision({ writeRevision: 3, headRevision: 1 })).toBe(3);
    expect(liveViewRevision({ headRevision: 1 })).toBe(1);
  });

  it("rejects a child path under a regular-file ancestor", () => {
    expect(() => assertVirtualWriteTree(
      { "kept.txt": { kind: "regular-file", objectHash: "h", byteLength: 1 } },
      { "kept.txt/child.ts": { kind: "regular-file", objectHash: "c", byteLength: 1 } },
    )).toThrow(VirtualWriteTreeError);
  });

  it("rejects a same-batch file/directory ancestor conflict", () => {
    expect(() => assertVirtualWriteTree({}, {
      "src": { kind: "regular-file", objectHash: "h", byteLength: 1 },
      "src/a.ts": { kind: "regular-file", objectHash: "c", byteLength: 1 },
    })).toThrow(/same batch/);
  });
});
