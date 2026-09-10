import { describe, expect, it } from "vitest";
import { classifyIntegrationTarget, dirtyResourceMap, parentRevisionOf, selectDirtyResource } from "./integration-parents.js";

const resource = (ownerId: string, generation: number, localEditRevision: number) => ({
  ownerId,
  generation,
  registrationId: `registration-${ownerId}`,
  resources: [{
    baseRevision: `base-${ownerId}`,
    localEditRevision,
    resource: { resourceId: "note.txt" },
    documentInstanceId: `document-${ownerId}`,
    bufferHash: `sha256-${"a".repeat(64)}`,
    encoding: "utf-8",
    bom: false,
    lineEnding: "lf" as const,
  }],
});

describe("integration parent classification", () => {
  it("keeps every owner and selects only an explicit or unique surface", () => {
    const dirty = dirtyResourceMap([
      resource("other-owner", 2, 2),
      resource("focused-window", 9, 9),
    ]);
    expect(dirty.get("note.txt")).toHaveLength(2);
    expect(selectDirtyResource(dirty.get("note.txt"))).toEqual({ status: "ambiguous" });
    expect(selectDirtyResource(dirty.get("note.txt"), { ownerId: "focused-window", generation: 9 }))
      .toMatchObject({ status: "selected", resource: { ownerId: "focused-window", localEditRevision: 9 } });
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
    })).toBe("unavailable");
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
      dirty: {
        resourceId: "note.txt", baseRevision: "base", localEditRevision: 1, ownerId: "editor",
        generation: 1, registrationId: "registration", documentInstanceId: "document",
        bufferHash: `sha256-${"b".repeat(64)}`, encoding: "utf-8", bom: false, lineEnding: "lf",
      },
      parentState: disk,
      baseState: draft,
      childState: child,
    })).toBe("surface");
    expect(parentRevisionOf(disk)).toMatch(/^disk:[0-9a-f]{64}$/u);
  });
});
