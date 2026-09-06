import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import type { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createSurfaceAwareFindTool, parseNativeFindResultPaths } from "../../src/harness/find-tool.js";
import { createSurfaceAwareLsTool } from "../../src/harness/ls-tool.js";

const context = undefined as never;

describe("surface-aware native find and ls", () => {
  it("lists a nested dirty-only virtual directory and finds its file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "piarium-find-ls-virtual-"));
    const bridge = {
      request: async (_method: string, params: { path: string; pattern?: string }) => ({
        status: "ready" as const,
        entries: [
          { path: ".", kind: "directory" as const },
          ...(params.pattern === "*.md"
            ? []
            : [{ path: "new.ts", kind: "file" as const, revision: "surface-draft:fixed" }]),
        ],
      }),
    } as unknown as HostServicesBridge;
    try {
      const ls = createSurfaceAwareLsTool(bridge, root);
      const find = createSurfaceAwareFindTool(bridge, root);
      const listed = await ls.execute("ls", { path: "src" }, undefined, undefined, context);
      assert.equal((listed.content[0] as { text: string }).text, "new.ts");
      const found = await find.execute("find", { path: "src", pattern: "*.ts" }, undefined, undefined, context);
      assert.equal((found.content[0] as { text: string }).text, "new.ts");
      const noMatch = await find.execute("find", { path: "src", pattern: "*.md" }, undefined, undefined, context);
      assert.equal((noMatch.content[0] as { text: string }).text, "No files found matching pattern");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("delegates an unrelated disk directory to native ls", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "piarium-find-ls-disk-"));
    await writeFile(path.join(root, "disk.txt"), "disk\n", "utf8");
    const bridge = {
      request: async () => ({ status: "disk" as const }),
    } as unknown as HostServicesBridge;
    try {
      const result = await createSurfaceAwareLsTool(bridge, root).execute("ls", {}, undefined, undefined, context);
      assert.equal((result.content[0] as { text: string }).text, "disk.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps native directories and bracketed filenames while merging fixed paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "piarium-find-ls-merge-"));
    await writeFile(path.join(root, "[disk].ts"), "disk\n", "utf8");
    const bridge = {
      request: async () => ({
        status: "ready" as const,
        entries: [
          { path: ".", kind: "directory" as const },
          { path: "[fixed].ts", kind: "file" as const, revision: "surface-draft:fixed" },
          { path: "virtual", kind: "directory" as const },
        ],
      }),
    } as unknown as HostServicesBridge;
    try {
      const result = await createSurfaceAwareFindTool(bridge, root).execute(
        "find-merge",
        { pattern: "*", limit: 10 },
        undefined,
        undefined,
        context,
      );
      const text = (result.content[0] as { text: string }).text;
      assert.match(text, /\[disk\]\.ts/);
      assert.match(text, /\[fixed\]\.ts/);
      assert.match(text, /virtual\//);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains Pi's byte truncation details after merging a large overlay", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "piarium-find-ls-truncate-"));
    const entries = [
      { path: ".", kind: "directory" as const },
      ...Array.from({ length: 800 }, (_, index) => ({
        path: `long-fixed-name-${String(index).padStart(4, "0")}-${"x".repeat(80)}.ts`,
        kind: "file" as const,
        revision: "surface-draft:fixed",
      })),
    ];
    const bridge = {
      request: async () => ({ status: "ready" as const, entries }),
    } as unknown as HostServicesBridge;
    try {
      const result = await createSurfaceAwareFindTool(bridge, root).execute(
        "find-truncate",
        { pattern: "*.ts", limit: 1000 },
        undefined,
        undefined,
        context,
      );
      const details = result.details as { truncation?: { truncated?: boolean } } | undefined;
      assert.equal(details?.truncation?.truncated, true);
      assert.match((result.content[0] as { text: string }).text, /limit reached/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses a combined native notice block without dropping bracketed filenames", () => {
    const parsed = parseNativeFindResultPaths({
      content: [{ type: "text", text: "[name].ts\n\n[50KB limit reached]" }],
      details: { resultLimitReached: 10, truncation: { truncated: true } },
    });
    assert.deepEqual(parsed, [{ path: "[name].ts", kind: "file" }]);
  });

  it("passes the abort signal to the path overlay request", async () => {
    let observedSignal: AbortSignal | undefined;
    const bridge = {
      request: async (_method: string, _params: unknown, options?: { signal?: AbortSignal }) => {
        observedSignal = options?.signal;
        throw new Error("aborted");
      },
    } as unknown as HostServicesBridge;
    const controller = new AbortController();
    await assert.rejects(
      createSurfaceAwareFindTool(bridge, "/tmp").execute("find", { pattern: "*.ts" }, controller.signal, undefined, context),
      /aborted/,
    );
    assert.equal(observedSignal, controller.signal);
  });
});
