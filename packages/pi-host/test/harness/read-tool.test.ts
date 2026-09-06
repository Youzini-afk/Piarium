import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import type { HarnessRequestData } from "@piarium/protocol";
import type { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createSurfaceAwareReadTool } from "../../src/harness/read-tool.js";

const context = undefined as never;

describe("surface-aware native read", () => {
  it("reads the fixed surface bytes and preserves native offset/limit handling", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-read-tool-"));
    const file = join(root, "draft.ts");
    await writeFile(file, "current disk\n", "utf8");
    const emitted: HarnessRequestData[] = [];
    const bridge = {
      request: async (_method: "document.readSource", _params: { path: string }, options?: { signal?: AbortSignal }) => {
        assert.equal(options?.signal, undefined);
        return {
          base64: Buffer.from("fixed one\nfixed two\n", "utf8").toString("base64"),
          revision: "surface-draft:fixed",
          source: "surface-draft" as const,
        };
      },
    } as unknown as HostServicesBridge;
    const tool = createSurfaceAwareReadTool(bridge, root);
    try {
      const result = await tool.execute(
        "call-1",
        { path: file, offset: 2, limit: 1 },
        undefined,
        undefined,
        context,
      );
      assert.deepEqual(result.content, [{
        type: "text",
        text: "fixed two\n\n[1 more lines in file. Use offset=3 to continue.]",
      }]);
      assert.deepEqual(result.details, {
        revision: "surface-draft:fixed",
        source: "surface-draft",
      });
      assert.equal(emitted.length, 0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reads a dirty-only file whose disk path does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-read-dirty-only-"));
    const bridge = {
      request: async () => ({
        base64: Buffer.from("unsaved new file\n", "utf8").toString("base64"),
        revision: "surface-draft:new",
        source: "surface-draft" as const,
      }),
    } as unknown as HostServicesBridge;
    const tool = createSurfaceAwareReadTool(bridge, root);
    try {
      const result = await tool.execute("call-new", { path: "new.ts" }, undefined, undefined, context);
      assert.equal(result.content[0]?.type, "text");
      assert.equal((result.content[0] as { text: string }).text, "unsaved new file\n");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("passes the execution abort signal to the Host source lookup", async () => {
    let observedSignal: AbortSignal | undefined;
    const bridge = {
      request: async (_method: string, _params: unknown, options?: { signal?: AbortSignal }) => {
        observedSignal = options?.signal;
        throw new Error("aborted");
      },
    } as unknown as HostServicesBridge;
    const tool = createSurfaceAwareReadTool(bridge, "/tmp");
    const controller = new AbortController();
    await assert.rejects(
      tool.execute("call-2", { path: "draft.ts" }, controller.signal, undefined, context),
      /aborted/,
    );
    assert.equal(observedSignal, controller.signal);
  });

  it("delegates disk reads to the native definition", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-read-disk-"));
    const file = join(root, "disk.txt");
    await writeFile(file, "one\ntwo\nthree\n", "utf8");
    const bridge = {
      request: async () => ({ source: "disk" as const }),
    } as unknown as HostServicesBridge;
    const tool = createSurfaceAwareReadTool(bridge, root);
    try {
      const result = await tool.execute(
        "call-3",
        { path: file, offset: 2, limit: 1 },
        undefined,
        undefined,
        context,
      );
      assert.deepEqual(result.content, [{
        type: "text",
        text: "two\n\n[2 more lines in file. Use offset=3 to continue.]",
      }]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not fall back to disk when the fixed surface source is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-read-unavailable-"));
    await writeFile(join(root, "draft.ts"), "must not leak\n", "utf8");
    const bridge = {
      request: async () => { throw new Error("fixed snapshot expired"); },
    } as unknown as HostServicesBridge;
    const tool = createSurfaceAwareReadTool(bridge, root);
    try {
      await assert.rejects(
        tool.execute("call-unavailable", { path: "draft.ts" }, undefined, undefined, context),
        /fixed snapshot expired/,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("preserves native image attachments for disk reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-read-image-"));
    const file = join(root, "pixel.png");
    await writeFile(file, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nS0AAAAASUVORK5CYII=",
      "base64",
    ));
    const bridge = {
      request: async () => ({ source: "disk" as const }),
    } as unknown as HostServicesBridge;
    const tool = createSurfaceAwareReadTool(bridge, root, { autoResizeImages: false });
    try {
      const result = await tool.execute("call-image", { path: file }, undefined, undefined, context);
      assert.ok(result.content.some((part) => part.type === "image" && part.mimeType === "image/png"));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
