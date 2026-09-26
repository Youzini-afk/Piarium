import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDocumentAuthorityHarness } from "../documents/contract-fixtures.js";
import type { KernelComputeResult } from "../kernel/compute-runner.js";
import type { KernelComputeService } from "../kernel/compute-service.js";
import type { KernelComputeRecord } from "../kernel/protocol.generated.js";
import { createWorkspaceContentSearch, type WorkspaceSearchHit } from "./content.js";

const nativeResult = (
  records: KernelComputeRecord[],
  status: KernelComputeResult["status"] = records.length ? "ready" : "empty",
  message: string | null = null,
): KernelComputeResult => ({
  kernelEpoch: "epoch",
  workspaceId: "workspace",
  jobId: "job",
  status,
  root: null,
  records,
  nextCursor: records.length,
  endCursor: records.length,
  scannedFiles: records.length,
  message,
});

const hit = (resourceId: string, preview: string, input: {
  line?: number;
  column?: number;
  revision?: string;
  before?: string[];
  after?: string[];
} = {}): KernelComputeRecord => ({
  kind: "hit",
  path: resourceId,
  revision: input.revision ?? `sha256-${resourceId}`,
  data: {
    line: input.line ?? 2,
    column: input.column ?? 1,
    preview,
    before: input.before ?? [],
    after: input.after ?? [],
  },
});

const searchWith = async (
  directory: KernelComputeService["directory"],
) => {
  const harness = await createDocumentAuthorityHarness();
  return {
    harness,
    search: createWorkspaceContentSearch({
      documents: harness.authority,
      compute: { directory },
      pathModule: path,
    }),
  };
};

describe("workspace content search over native compute", () => {
  it("admits only workspace-contained roots and forwards native search options", async () => {
    const directory = vi.fn(async (_root, _input, _options) => nativeResult([]));
    const { harness, search } = await searchWith(directory);
    try {
      const root = (await harness.authority.inspectWorkspace(harness.identity.workspaceId)).root;
      const scoped = await search.searchContent({
        workspaceId: harness.identity.workspaceId,
        query: "literal [value]",
        paths: ["src"],
        fixedStrings: true,
        ignoreCase: true,
        glob: ["**/*.ts", "!**/*.test.ts"],
        before: 2,
        after: 3,
      });
      expect(scoped).toEqual({ status: "empty", generation: undefined, scannedFiles: 0 });
      expect(directory).toHaveBeenCalledTimes(1);
      expect(directory.mock.calls[0]?.[0]).toBe(root);
      expect(directory.mock.calls[0]?.[1]).toMatchObject({
        operation: "search",
        lane: "foreground",
        query: "literal [value]",
        paths: ["src"],
        fixedStrings: true,
        ignoreCase: true,
        globs: ["**/*.ts", "!**/*.test.ts"],
        before: 2,
        after: 3,
      });

      const outside = await search.searchContent({
        workspaceId: harness.identity.workspaceId,
        query: "needle",
        paths: ["../outside"],
      });
      expect(outside.status).toBe("failure");
      expect(directory).toHaveBeenCalledTimes(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("decodes revision-bound hits and keeps ready, empty and failure distinct", async () => {
    let mode: "ready" | "empty" | "failed" | "throw" = "ready";
    const directory = vi.fn(async (_root, _input, options) => {
      if (mode === "throw") throw new Error("native search unavailable");
      const records = mode === "ready"
        ? [hit("note.txt", "todo item", { revision: "sha256-note", before: ["before"], after: ["after"] })]
        : [];
      await options?.onRecords?.(records);
      return nativeResult(records, mode === "failed" ? "failed" : mode === "ready" ? "ready" : "empty", mode === "failed" ? "native search failed" : null);
    });
    const { harness, search } = await searchWith(directory);
    try {
      const ready = await search.searchContent({ workspaceId: harness.identity.workspaceId, query: "todo" }, { generation: 3 });
      expect(ready).toMatchObject({
        status: "ready",
        generation: 3,
        hits: [{
          resource: { workspaceId: harness.identity.workspaceId, resourceId: "note.txt" },
          line: 2,
          preview: "todo item",
          revision: "sha256-note",
          before: ["before"],
          after: ["after"],
        }],
      });
      mode = "empty";
      await expect(search.searchContent({ workspaceId: harness.identity.workspaceId, query: "todo" }, { generation: 3 }))
        .resolves.toEqual({ status: "empty", generation: 3, scannedFiles: 0 });
      mode = "failed";
      await expect(search.searchContent({ workspaceId: harness.identity.workspaceId, query: "todo" }, { generation: 3 }))
        .resolves.toEqual({ status: "failure", generation: 3, message: "native search failed" });
      mode = "throw";
      const thrown = await search.searchContent({ workspaceId: harness.identity.workspaceId, query: "todo" }, { generation: 3 });
      expect(thrown).toMatchObject({ status: "failure", generation: 3 });
      if (thrown.status === "failure") expect(thrown.message).toMatch(/native search unavailable/);
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps partial native matches and marks them incomplete, but fails a partial search with no evidence", async () => {
    let withHit = true;
    const directory = vi.fn(async (_root, _input, options) => {
      const records = withHit ? [hit("note.txt", "todo item")] : [];
      await options?.onRecords?.(records);
      return nativeResult(records, "partial", "one candidate could not be read");
    });
    const { harness, search } = await searchWith(directory);
    try {
      const partial = await search.searchContent({ workspaceId: harness.identity.workspaceId, query: "todo" }, { generation: 5 });
      expect(partial).toMatchObject({ status: "ready", generation: 5, incomplete: true, hits: [{ preview: "todo item" }] });
      withHit = false;
      const failed = await search.searchContent({ workspaceId: harness.identity.workspaceId, query: "todo" }, { generation: 6 });
      expect(failed).toEqual({ status: "failure", generation: 6, message: "one candidate could not be read" });
    } finally {
      await harness.cleanup();
    }
  });

  it("forwards the global result cap and dirty-path exclusion to native admission", async () => {
    const directory = vi.fn(async (_root, input, options) => {
      expect(input.maxResults).toBe(2);
      expect(input.excludePaths).toEqual(["dirty.ts"]);
      const records = [hit("first.ts", "first"), hit("second.ts", "second")];
      await options?.onRecords?.(records);
      return nativeResult(records);
    });
    const { harness, search } = await searchWith(directory);
    try {
      const result = await search.searchContent({
        workspaceId: harness.identity.workspaceId,
        query: "match",
        maxResults: 2,
        excludeResourceIds: ["dirty.ts"],
      });
      expect(result).toMatchObject({ status: "ready", hits: [{ preview: "first" }, { preview: "second" }] });
    } finally {
      await harness.cleanup();
    }
  });

  it("streams native batches without collecting them when the caller owns backpressure", async () => {
    const directory = vi.fn(async (_root, _input, options) => {
      await options?.onRecords?.([hit("first.txt", "first")]);
      await options?.onRecords?.([hit("second.txt", "second")]);
      return nativeResult([], "ready");
    });
    const { harness, search } = await searchWith(directory);
    const batches: WorkspaceSearchHit[][] = [];
    try {
      const result = await search.searchContent({
        workspaceId: harness.identity.workspaceId,
        query: "match",
      }, {
        collect: false,
        generation: 6,
        onBatch: (hits) => { batches.push(hits); },
      });
      expect(result).toEqual({ status: "ready", generation: 6, hits: [], scannedFiles: 0 });
      expect(batches.flat().map((item) => item.preview)).toEqual(["first", "second"]);
    } finally {
      await harness.cleanup();
    }
  });

  it("propagates cancellation to the native job instead of converting it to empty", async () => {
    const controller = new AbortController();
    const directory = vi.fn(async (_root, _input, options) => {
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) { resolve(); return; }
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return nativeResult([], "cancelled");
    });
    const { harness, search } = await searchWith(directory);
    try {
      const pending = search.searchContent({ workspaceId: harness.identity.workspaceId, query: "todo" }, {
        generation: 4,
        signal: controller.signal,
      });
      controller.abort();
      await expect(pending).resolves.toEqual({ status: "cancelled", generation: 4 });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects malformed native hit identity instead of trusting a traversal-looking record", async () => {
    const directory = vi.fn(async (_root, _input, options) => {
      const records = [hit("../outside.txt", "bad")];
      await options?.onRecords?.(records);
      return nativeResult(records);
    });
    const { harness, search } = await searchWith(directory);
    try {
      const result = await search.searchContent({ workspaceId: harness.identity.workspaceId, query: "bad" });
      expect(result.status).toBe("failure");
    } finally {
      await harness.cleanup();
    }
  });
});
