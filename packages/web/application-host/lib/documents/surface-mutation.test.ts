import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentInputContext, DocumentSurfaceWritePathResult } from "@piarium/protocol";
import type { DirtyBufferPublication, DocumentSurfaceOperationRequest, DocumentSurfaceOperationResult } from "./authority.js";
import { applyAgentSurfaceMutation, applyTextEdits } from "./surface-mutation.js";
import type { SurfaceSnapshotInspectResult } from "./surface-snapshot-store.js";

const hash = (text: string) => `sha256-${createHash("sha256").update(text, "utf8").digest("hex")}`;

const context = (workspaceId: string, dirtyPaths: string[]): AgentInputContext => ({
  source: "surface",
  workspaceId,
  dirtyPaths,
  snapshot: { status: "ready", ref: "fixed" },
});

describe("applyTextEdits", () => {
  it("replaces a unique oldText once", () => {
    expect(applyTextEdits("alpha B omega", [{ oldText: "B", newText: "C" }])).toBe("alpha C omega");
  });

  it("refuses an empty or ambiguous replacement", () => {
    expect(() => applyTextEdits("B", [{ oldText: "", newText: "C" }])).toThrow(/empty/i);
    expect(() => applyTextEdits("B and B", [{ oldText: "B", newText: "C" }])).toThrow(/more than once/i);
    expect(() => applyTextEdits("A", [{ oldText: "B", newText: "C" }])).toThrow(/exact text/i);
  });
});

describe("applyAgentSurfaceMutation", () => {
  it("returns the disk sentinel when no path is owned by the fixed snapshot", async () => {
    const { result, record } = await applyAgentSurfaceMutation({
      inspectSnapshot: () => ({ status: "disk" }),
      surfaceOwner: () => null,
      inspectDirtyBuffers: async () => [],
      requestSurfaceOperation: async () => {
        throw new Error("disk-only mutations must not dispatch a surface operation");
      },
      inspectWorkspace: async () => ({ epoch: 1 }),
      readDisk: async () => ({ status: "missing" }),
      writeDisk: async () => {
        throw new Error("disk-only mutations must stay on the journaled disk path");
      },
      deleteDisk: async () => {
        throw new Error("disk-only mutations must stay on the journaled disk path");
      },
    }, {
      sessionId: "s1",
      context: context("ws", []),
      changes: [{ resourceId: "plain.ts", action: "write", content: "n" }],
    });
    expect(result).toEqual({ status: "disk" });
    expect(record).toBeNull();
  });

  it("marks delete and NUL bytes unavailable on a surface path", async () => {
    const inspect: SurfaceSnapshotInspectResult = {
      status: "ready",
      bom: false,
      content: "B",
      encoding: "utf-8",
      localEditRevision: 2,
      baseRevision: "disk-a",
      revision: "surface-draft:fixed:2",
      resource: { workspaceId: "ws", resourceId: "draft.ts" },
      source: "surface-draft",
    };
    const deleted = await applyAgentSurfaceMutation({
      inspectSnapshot: () => inspect,
      surfaceOwner: () => ({ ownerId: "surface", generation: 1, workspaceId: "ws" }),
      inspectDirtyBuffers: async () => [],
      requestSurfaceOperation: async () => {
        throw new Error("unavailable surface ops must not dispatch");
      },
      inspectWorkspace: async () => ({ epoch: 1 }),
      readDisk: async () => ({ status: "ready", content: "A", revision: "disk-a" }),
      writeDisk: async () => ({ status: "written", revision: "disk-b" }),
      deleteDisk: async () => ({ status: "deleted" }),
    }, {
      sessionId: "s1",
      context: context("ws", ["draft.ts"]),
      changes: [{ resourceId: "draft.ts", action: "delete" }],
    });
    expect(deleted.result.status).toBe("unavailable");
    expect(deleted.result.status === "disk" ? "" : deleted.result.results[0]?.target).toBe("surface");

    const binary = await applyAgentSurfaceMutation({
      inspectSnapshot: () => inspect,
      surfaceOwner: () => ({ ownerId: "surface", generation: 1, workspaceId: "ws" }),
      inspectDirtyBuffers: async () => [],
      requestSurfaceOperation: async () => {
        throw new Error("binary surface writes must not dispatch");
      },
      inspectWorkspace: async () => ({ epoch: 1 }),
      readDisk: async () => ({ status: "ready", content: "A", revision: "disk-a" }),
      writeDisk: async () => ({ status: "written", revision: "disk-b" }),
      deleteDisk: async () => ({ status: "deleted" }),
    }, {
      sessionId: "s1",
      context: context("ws", ["draft.ts"]),
      changes: [{ resourceId: "draft.ts", action: "write", content: "bin\0ary" }],
    });
    expect(binary.result.status).toBe("unavailable");
  });

  it("compensates an applied surface path when a later disk path fails", async () => {
    const draftInspect: SurfaceSnapshotInspectResult = {
      status: "ready",
      bom: false,
      content: "B",
      encoding: "utf-8",
      localEditRevision: 2,
      baseRevision: "disk-a",
      revision: "surface-draft:fixed:2",
      resource: { workspaceId: "ws", resourceId: "draft.ts" },
      source: "surface-draft",
    };
    const publication: DirtyBufferPublication = {
      generation: 1,
      ownerId: "surface",
      registrationId: "reg-1",
      resources: [{
        baseRevision: "disk-a",
        localEditRevision: 2,
        documentInstanceId: "doc-1",
        bufferHash: hash("B"),
        encoding: "utf-8",
        bom: false,
        lineEnding: "lf",
        resource: { workspaceId: "ws", resourceId: "draft.ts" },
      }],
      updatedAt: new Date().toISOString(),
      workspaceId: "ws",
    };
    const ops: Array<{ action: string; operationId: string; targets: number }> = [];
    let applyId = "";
    const { result } = await applyAgentSurfaceMutation({
      inspectSnapshot: (_session, _context, resourceId) => (
        resourceId === "draft.ts" ? draftInspect : { status: "disk" }
      ),
      surfaceOwner: () => ({ ownerId: "surface", generation: 1, workspaceId: "ws" }),
      inspectDirtyBuffers: async () => [publication],
      requestSurfaceOperation: async (request: DocumentSurfaceOperationRequest) => {
        ops.push({ action: request.action, operationId: request.operationId, targets: request.targets.length });
        if (request.action === "apply") {
          applyId = request.operationId;
          return [{
            resource: { workspaceId: "ws", resourceId: "draft.ts" },
            status: "applied",
            documentInstanceId: "doc-1",
            beforeLocalEditRevision: 2,
            beforeHash: hash("B"),
            afterLocalEditRevision: 3,
            afterHash: hash("C"),
          } satisfies DocumentSurfaceOperationResult];
        }
        if (request.operationId !== applyId || request.operationId.endsWith(":undo")) {
          return [{
            resource: { workspaceId: "ws", resourceId: "draft.ts" },
            status: "failed",
            message: "The surface undo baseline is unavailable",
          }];
        }
        return [{
          resource: { workspaceId: "ws", resourceId: "draft.ts" },
          status: "undone",
          documentInstanceId: "doc-1",
          content: "B",
          afterLocalEditRevision: 4,
          afterHash: hash("B"),
        }];
      },
      inspectWorkspace: async () => ({ epoch: 1 }),
      readDisk: async (_workspaceId, resourceId) => (
        resourceId === "other.ts"
          ? { status: "binary" as const, revision: "disk-x" }
          : { status: "ready" as const, content: "A", revision: "disk-a" }
      ),
      writeDisk: async () => {
        throw new Error("failed disk path must not write");
      },
      deleteDisk: async () => ({ status: "deleted" }),
    }, {
      sessionId: "s1",
      context: context("ws", ["draft.ts"]),
      changes: [
        { resourceId: "draft.ts", action: "edit", edits: [{ oldText: "B", newText: "C" }] },
        { resourceId: "other.ts", action: "write", content: "disk-new" },
      ],
    });
    expect(ops.map((entry) => entry.action)).toEqual(["apply", "undo"]);
    expect(ops[0]?.operationId).toBe(ops[1]?.operationId);
    expect(ops[1]?.targets).toBe(1);
    expect(result.status).toBe("conflict");
    if (result.status === "disk") throw new Error("expected mixed results");
    const byPath = Object.fromEntries(result.results.map((row: DocumentSurfaceWritePathResult) => [row.path, row]));
    expect(byPath["draft.ts"]).toMatchObject({ target: "surface", status: "compensated" });
    expect(byPath["other.ts"]).toMatchObject({ target: "disk", status: "unavailable" });
    expect(result.message).toMatch(/compensated/);
  });

  it("compensates with a fresh signal after the forward mutation is aborted", async () => {
    const draftInspect: SurfaceSnapshotInspectResult = {
      status: "ready",
      bom: false,
      content: "B",
      encoding: "utf-8",
      localEditRevision: 2,
      baseRevision: "disk-a",
      revision: "surface-draft:fixed:2",
      resource: { workspaceId: "ws", resourceId: "draft.ts" },
      source: "surface-draft",
    };
    const publication: DirtyBufferPublication = {
      generation: 1,
      ownerId: "surface",
      registrationId: "reg-1",
      resources: [{
        baseRevision: "disk-a",
        localEditRevision: 2,
        documentInstanceId: "doc-1",
        bufferHash: hash("B"),
        encoding: "utf-8",
        bom: false,
        lineEnding: "lf",
        resource: { workspaceId: "ws", resourceId: "draft.ts" },
      }],
      updatedAt: new Date().toISOString(),
      workspaceId: "ws",
    };
    const forward = new AbortController();
    const { result } = await applyAgentSurfaceMutation({
      inspectSnapshot: (_session, _context, resourceId) => (
        resourceId === "draft.ts" ? draftInspect : { status: "disk" }
      ),
      surfaceOwner: () => ({ ownerId: "surface", generation: 1, workspaceId: "ws" }),
      inspectDirtyBuffers: async () => [publication],
      requestSurfaceOperation: async (request, options) => {
        if (request.action === "apply") {
          forward.abort();
          return [{
            resource: { workspaceId: "ws", resourceId: "draft.ts" },
            status: "applied",
            documentInstanceId: "doc-1",
            beforeLocalEditRevision: 2,
            beforeHash: hash("B"),
            afterLocalEditRevision: 3,
            afterHash: hash("C"),
          }];
        }
        expect(options?.signal?.aborted).toBeFalsy();
        expect(request.operationId.endsWith(":undo")).toBe(false);
        return [{
          resource: { workspaceId: "ws", resourceId: "draft.ts" },
          status: "undone",
          documentInstanceId: "doc-1",
          content: "B",
          afterLocalEditRevision: 4,
          afterHash: hash("B"),
        }];
      },
      inspectWorkspace: async () => ({ epoch: 1 }),
      readDisk: async () => ({ status: "ready", content: "A", revision: "disk-a" }),
      writeDisk: async () => {
        throw new Error("aborted mutations must not write disk");
      },
      deleteDisk: async () => ({ status: "deleted" }),
    }, {
      sessionId: "s1",
      context: context("ws", ["draft.ts"]),
      changes: [
        { resourceId: "draft.ts", action: "edit", edits: [{ oldText: "B", newText: "C" }] },
        { resourceId: "other.ts", action: "write", content: "disk-new" },
      ],
      signal: forward.signal,
    });
    expect(result.status).toBe("conflict");
    if (result.status === "disk") throw new Error("expected mixed results");
    expect(result.results.find((row) => row.path === "draft.ts")).toMatchObject({
      target: "surface",
      status: "compensated",
    });
  });

  it("leaves a later user edit untouched when compensation can no longer match the applied buffer", async () => {
    const draftInspect: SurfaceSnapshotInspectResult = {
      status: "ready",
      bom: false,
      content: "B",
      encoding: "utf-8",
      localEditRevision: 2,
      baseRevision: "disk-a",
      revision: "surface-draft:fixed:2",
      resource: { workspaceId: "ws", resourceId: "draft.ts" },
      source: "surface-draft",
    };
    const publication: DirtyBufferPublication = {
      generation: 1,
      ownerId: "surface",
      registrationId: "reg-1",
      resources: [{
        baseRevision: "disk-a",
        localEditRevision: 2,
        documentInstanceId: "doc-1",
        bufferHash: hash("B"),
        encoding: "utf-8",
        bom: false,
        lineEnding: "lf",
        resource: { workspaceId: "ws", resourceId: "draft.ts" },
      }],
      updatedAt: new Date().toISOString(),
      workspaceId: "ws",
    };
    const { result } = await applyAgentSurfaceMutation({
      inspectSnapshot: (_session, _context, resourceId) => (
        resourceId === "draft.ts" ? draftInspect : { status: "disk" }
      ),
      surfaceOwner: () => ({ ownerId: "surface", generation: 1, workspaceId: "ws" }),
      inspectDirtyBuffers: async () => [publication],
      requestSurfaceOperation: async (request) => {
        if (request.action === "undo" && request.operationId.endsWith(":undo")) {
          throw new Error("compensation must reuse the apply operationId");
        }
        if (request.action === "apply") {
          return [{
            resource: { workspaceId: "ws", resourceId: "draft.ts" },
            status: "applied",
            documentInstanceId: "doc-1",
            beforeLocalEditRevision: 2,
            beforeHash: hash("B"),
            afterLocalEditRevision: 3,
            afterHash: hash("C"),
          }];
        }
        return [{
          resource: { workspaceId: "ws", resourceId: "draft.ts" },
          status: "failed",
          message: "user continued editing",
          documentInstanceId: "doc-1",
          afterLocalEditRevision: 4,
          afterHash: hash("D"),
        }];
      },
      inspectWorkspace: async () => ({ epoch: 1 }),
      readDisk: async () => ({ status: "binary", revision: "disk-x" }),
      writeDisk: async () => ({ status: "conflict" }),
      deleteDisk: async () => ({ status: "conflict" }),
    }, {
      sessionId: "s1",
      context: context("ws", ["draft.ts"]),
      changes: [
        { resourceId: "draft.ts", action: "edit", edits: [{ oldText: "B", newText: "C" }] },
        { resourceId: "other.ts", action: "write", content: "disk-new" },
      ],
    });
    expect(result.status).toBe("conflict");
    if (result.status === "disk") throw new Error("expected mixed results");
    expect(result.results.find((row) => row.path === "draft.ts")).toMatchObject({
      target: "surface",
      status: "needs-attention",
    });
    expect(result.message).toMatch(/needs-attention/);
  });

  it("compares CRLF snapshot text to the editor-normalized bufferHash", async () => {
    const draftInspect: SurfaceSnapshotInspectResult = {
      status: "ready",
      bom: false,
      content: "B\r\n",
      encoding: "utf-8",
      localEditRevision: 2,
      baseRevision: "disk-a",
      revision: "surface-draft:fixed:2",
      resource: { workspaceId: "ws", resourceId: "draft.ts" },
      source: "surface-draft",
      bufferHash: hash("B\n"),
      lineEnding: "crlf",
    };
    const publication: DirtyBufferPublication = {
      generation: 1,
      ownerId: "surface",
      registrationId: "reg-1",
      resources: [{
        baseRevision: "disk-a",
        localEditRevision: 2,
        documentInstanceId: "doc-1",
        bufferHash: hash("B\n"),
        encoding: "utf-8",
        bom: false,
        lineEnding: "crlf",
        resource: { workspaceId: "ws", resourceId: "draft.ts" },
      }],
      updatedAt: new Date().toISOString(),
      workspaceId: "ws",
    };
    const { result } = await applyAgentSurfaceMutation({
      inspectSnapshot: () => draftInspect,
      surfaceOwner: () => ({ ownerId: "surface", generation: 1, workspaceId: "ws" }),
      inspectDirtyBuffers: async () => [publication],
      requestSurfaceOperation: async (request) => {
        expect(request.targets[0]?.newText).toBe("C\n");
        return [{
          resource: { workspaceId: "ws", resourceId: "draft.ts" },
          status: "applied",
          documentInstanceId: "doc-1",
          beforeLocalEditRevision: 2,
          beforeHash: hash("B\n"),
          afterLocalEditRevision: 3,
          afterHash: hash("C\n"),
        }];
      },
      inspectWorkspace: async () => ({ epoch: 1 }),
      readDisk: async () => ({ status: "ready", content: "A\r\n", revision: "disk-a" }),
      writeDisk: async () => {
        throw new Error("CRLF surface edits must not write disk");
      },
      deleteDisk: async () => ({ status: "deleted" }),
    }, {
      sessionId: "s1",
      context: context("ws", ["draft.ts"]),
      changes: [{ resourceId: "draft.ts", action: "edit", edits: [{ oldText: "B\n", newText: "C\n" }] }],
    });
    expect(result.status).toBe("applied");
  });

  it("undoes a two-path surface batch once with the apply operationId", async () => {
    const inspectFor = (resourceId: string, content: string): SurfaceSnapshotInspectResult => ({
      status: "ready",
      bom: false,
      content,
      encoding: "utf-8",
      localEditRevision: 2,
      baseRevision: "disk-a",
      revision: `surface-draft:fixed:2`,
      resource: { workspaceId: "ws", resourceId },
      source: "surface-draft",
    });
    const publication: DirtyBufferPublication = {
      generation: 1,
      ownerId: "surface",
      registrationId: "reg-1",
      resources: [
        {
          baseRevision: "disk-a",
          localEditRevision: 2,
          documentInstanceId: "doc-a",
          bufferHash: hash("A"),
          encoding: "utf-8",
          bom: false,
          lineEnding: "lf",
          resource: { workspaceId: "ws", resourceId: "a.ts" },
        },
        {
          baseRevision: "disk-a",
          localEditRevision: 2,
          documentInstanceId: "doc-b",
          bufferHash: hash("B"),
          encoding: "utf-8",
          bom: false,
          lineEnding: "lf",
          resource: { workspaceId: "ws", resourceId: "b.ts" },
        },
      ],
      updatedAt: new Date().toISOString(),
      workspaceId: "ws",
    };
    const ops: Array<{ action: string; operationId: string; targets: string[] }> = [];
    let applyId = "";
    const { result } = await applyAgentSurfaceMutation({
      inspectSnapshot: (_session, _context, resourceId) => (
        resourceId === "a.ts" ? inspectFor("a.ts", "A")
          : resourceId === "b.ts" ? inspectFor("b.ts", "B")
            : { status: "disk" }
      ),
      surfaceOwner: () => ({ ownerId: "surface", generation: 1, workspaceId: "ws" }),
      inspectDirtyBuffers: async () => [publication],
      requestSurfaceOperation: async (request, options) => {
        ops.push({
          action: request.action,
          operationId: request.operationId,
          targets: request.targets.map((target) => target.resource.resourceId),
        });
        if (request.action === "apply") {
          applyId = request.operationId;
          return request.targets.map((target, index) => ({
            resource: target.resource,
            status: "applied" as const,
            documentInstanceId: target.documentInstanceId,
            beforeLocalEditRevision: 2,
            beforeHash: target.bufferHash,
            afterLocalEditRevision: 3,
            afterHash: hash(index === 0 ? "C" : "D"),
          }));
        }
        expect(options?.signal?.aborted).toBeFalsy();
        expect(request.operationId).toBe(applyId);
        return request.targets.map((target) => ({
          resource: target.resource,
          status: "undone" as const,
          documentInstanceId: target.documentInstanceId,
          content: target.resource.resourceId === "a.ts" ? "A" : "B",
          afterLocalEditRevision: 4,
          afterHash: target.bufferHash,
        }));
      },
      inspectWorkspace: async () => ({ epoch: 1 }),
      readDisk: async () => ({ status: "binary", revision: "disk-x" }),
      writeDisk: async () => {
        throw new Error("failed disk path must not write");
      },
      deleteDisk: async () => ({ status: "deleted" }),
    }, {
      sessionId: "s1",
      context: context("ws", ["a.ts", "b.ts"]),
      changes: [
        { resourceId: "a.ts", action: "edit", edits: [{ oldText: "A", newText: "C" }] },
        { resourceId: "b.ts", action: "edit", edits: [{ oldText: "B", newText: "D" }] },
        { resourceId: "other.ts", action: "write", content: "disk-new" },
      ],
    });
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ action: "apply", targets: ["a.ts", "b.ts"] });
    expect(ops[1]).toMatchObject({ action: "undo", operationId: ops[0]?.operationId, targets: ["a.ts", "b.ts"] });
    expect(result.status).toBe("conflict");
    if (result.status === "disk") throw new Error("expected mixed results");
    expect(result.results.filter((row) => row.target === "surface").every((row) => row.status === "compensated")).toBe(true);
  });

  it("compensates applied surface paths while retaining a definite rejection", async () => {
    const inspectFor = (resourceId: string, content: string): SurfaceSnapshotInspectResult => ({
      status: "ready",
      bom: false,
      content,
      encoding: "utf-8",
      localEditRevision: 2,
      baseRevision: "disk-a",
      revision: "surface-draft:fixed:2",
      resource: { workspaceId: "ws", resourceId },
      source: "surface-draft",
    });
    const publication: DirtyBufferPublication = {
      generation: 1,
      ownerId: "surface",
      registrationId: "reg-1",
      resources: ["a.ts", "b.ts"].map((resourceId) => ({
        baseRevision: "disk-a",
        localEditRevision: 2,
        documentInstanceId: `doc-${resourceId}`,
        bufferHash: hash(resourceId === "a.ts" ? "A" : "B"),
        encoding: "utf-8" as const,
        bom: false,
        lineEnding: "lf" as const,
        resource: { workspaceId: "ws", resourceId },
      })),
      updatedAt: new Date().toISOString(),
      workspaceId: "ws",
    };
    const operations: Array<{ action: string; targets: string[] }> = [];
    const { result } = await applyAgentSurfaceMutation({
      inspectSnapshot: (_session, _context, resourceId) => (
        resourceId === "a.ts" ? inspectFor("a.ts", "A") : inspectFor("b.ts", "B")
      ),
      surfaceOwner: () => ({ ownerId: "surface", generation: 1, workspaceId: "ws" }),
      inspectDirtyBuffers: async () => [publication],
      requestSurfaceOperation: async (request) => {
        operations.push({ action: request.action, targets: request.targets.map((target) => target.resource.resourceId) });
        if (request.action === "apply") {
          return request.targets.map((target) => target.resource.resourceId === "a.ts"
            ? {
                resource: target.resource,
                status: "applied" as const,
                documentInstanceId: target.documentInstanceId,
                beforeLocalEditRevision: 2,
                beforeHash: target.bufferHash,
                afterLocalEditRevision: 3,
                afterHash: hash("C"),
              }
            : {
                resource: target.resource,
                status: "failed" as const,
                message: "surface rejected this path",
              });
        }
        return request.targets.map((target) => ({
          resource: target.resource,
          status: "undone" as const,
          documentInstanceId: target.documentInstanceId,
          content: "A",
          afterLocalEditRevision: 4,
          afterHash: hash("A"),
        }));
      },
      inspectWorkspace: async () => ({ epoch: 1 }),
      readDisk: async () => ({ status: "binary" as const, revision: "disk-binary" }),
      writeDisk: async () => ({ status: "conflict" as const }),
      deleteDisk: async () => ({ status: "conflict" as const }),
    }, {
      sessionId: "s1",
      context: context("ws", ["a.ts", "b.ts"]),
      changes: [
        { resourceId: "a.ts", action: "edit", edits: [{ oldText: "A", newText: "C" }] },
        { resourceId: "b.ts", action: "edit", edits: [{ oldText: "B", newText: "D" }] },
      ],
    });
    expect(operations).toEqual([
      { action: "apply", targets: ["a.ts", "b.ts"] },
      { action: "undo", targets: ["a.ts"] },
    ]);
    if (result.status === "disk") throw new Error("expected surface results");
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "a.ts", status: "compensated" }),
      expect.objectContaining({ path: "b.ts", status: "conflict" }),
    ]));
  });
});
