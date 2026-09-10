import { describe, expect, it } from "vitest";
import { classifyIntegrationTarget, dirtyResourceMap, parentRevisionOf } from "./integration-parents.js";

describe("integration parent classification", () => {
  it("maps the first dirty publication per resource, not the focused window", () => {
    const dirty = dirtyResourceMap([
      {
        ownerId: "other-owner",
        resources: [{
          baseRevision: "base-a",
          localEditRevision: 2,
          resource: { resourceId: "note.txt" },
        }],
      },
      {
        ownerId: "focused-window",
        resources: [{
          baseRevision: "base-b",
          localEditRevision: 9,
          resource: { resourceId: "note.txt" },
        }],
      },
    ]);
    expect(dirty.get("note.txt")).toMatchObject({ ownerId: "other-owner", localEditRevision: 2 });
  });

  it("uses live dirty inspection when injected and falls back to the draft heuristic otherwise", () => {
    const disk = { kind: "regular-file" as const, objectHash: "disk", byteLength: 4 };
    const draft = { kind: "regular-file" as const, objectHash: "draft", byteLength: 5 };
    const child = { kind: "regular-file" as const, objectHash: "child", byteLength: 5 };
    expect(classifyIntegrationTarget({
      draftBasePath: true,
      inspectDirtyBuffers: true,
      parentState: disk,
      baseState: draft,
      childState: child,
    })).toBe("disk");
    expect(classifyIntegrationTarget({
      draftBasePath: true,
      inspectDirtyBuffers: false,
      parentState: disk,
      baseState: draft,
      childState: child,
    })).toBe("surface");
    expect(classifyIntegrationTarget({
      draftBasePath: true,
      inspectDirtyBuffers: true,
      dirty: { resourceId: "note.txt", baseRevision: "base", localEditRevision: 1, ownerId: "editor" },
      parentState: disk,
      baseState: draft,
      childState: child,
    })).toBe("surface");
    expect(parentRevisionOf(disk)).toBe("disk:disk");
  });
});
