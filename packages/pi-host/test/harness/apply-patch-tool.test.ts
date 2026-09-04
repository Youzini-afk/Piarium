import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplyPatchTool } from "../../src/harness/apply-patch-tool.js";
import type { HostServicesBridge } from "../../src/harness/host-services-bridge.js";

function createFakeBridge(lockBatches?: string[][]): Pick<HostServicesBridge, "request"> {
  return {
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === "fs.lock" && params.action === "acquire") {
        const paths = params.paths as string[];
        lockBatches?.push(paths);
        return { held: true, leaseIds: paths.map((_, index) => `lease-${index}`) };
      }
      if (method === "fs.lock" && params.action === "release") return { held: false, released: true };
      if (method === "lsp.diagnostics") return { status: "ready", diagnostics: [] };
      throw new Error(`unexpected method: ${method}`);
    },
  } as unknown as Pick<HostServicesBridge, "request">;
}

async function executePatch(tool: ReturnType<typeof createApplyPatchTool>, patch: string): Promise<string> {
  const result = await tool.execute("call-1", { patch } as never, undefined, undefined, undefined as never);
  return (result.content[0] as { type: "text"; text: string }).text;
}

describe("apply_patch (Codex syntax)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "apply-patch-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies a simple update patch", async () => {
    writeFileSync(join(tmpDir, "test.txt"), "line1\nline2\nline3\n");
    const bridge = createFakeBridge();
    const tool = createApplyPatchTool(bridge as HostServicesBridge, "s1", tmpDir);

    const patch = `*** Begin Patch
*** Update File: test.txt
@@ line1
-line2
+line2 modified
*** End Patch`;
    const text = await executePatch(tool, patch);
    assert.match(text, /applied successfully/);
    const content = readFileSync(join(tmpDir, "test.txt"), "utf8");
    assert.equal(content, "line1\nline2 modified\nline3\n");
  });

  it("adds a new file", async () => {
    const bridge = createFakeBridge();
    const tool = createApplyPatchTool(bridge as HostServicesBridge, "s1", tmpDir);

    const patch = `*** Begin Patch
*** Add File: new.txt
hello world
line2
*** End Patch`;
    const text = await executePatch(tool, patch);
    assert.match(text, /applied successfully/);
    const content = readFileSync(join(tmpDir, "new.txt"), "utf8");
    assert.equal(content, "hello world\nline2");
  });

  it("deletes a file", async () => {
    writeFileSync(join(tmpDir, "delete-me.txt"), "content");
    const bridge = createFakeBridge();
    const tool = createApplyPatchTool(bridge as HostServicesBridge, "s1", tmpDir);

    const patch = `*** Begin Patch
*** Delete File: delete-me.txt
*** End Patch`;
    const text = await executePatch(tool, patch);
    assert.match(text, /applied successfully/);
    assert.equal(existsSync(join(tmpDir, "delete-me.txt")), false);
  });

  it("handles multiple files in one patch", async () => {
    writeFileSync(join(tmpDir, "a.txt"), "aaa\n");
    writeFileSync(join(tmpDir, "b.txt"), "bbb\n");
    const lockBatches: string[][] = [];
    const bridge = createFakeBridge(lockBatches);
    const tool = createApplyPatchTool(bridge as HostServicesBridge, "s1", tmpDir);

    const patch = `*** Begin Patch
*** Update File: a.txt
@@
-aaa
+AAA
*** Add File: c.txt
ccc
*** Update File: b.txt
@@
-bbb
+BBB
*** End Patch`;
    const text = await executePatch(tool, patch);
    assert.match(text, /applied successfully/);
    assert.equal(readFileSync(join(tmpDir, "a.txt"), "utf8"), "AAA\n");
    assert.equal(readFileSync(join(tmpDir, "b.txt"), "utf8"), "BBB\n");
    assert.equal(readFileSync(join(tmpDir, "c.txt"), "utf8"), "ccc");
    assert.equal(lockBatches.length, 1, "a multi-file patch must acquire one ordered Host lease batch");
    assert.equal(lockBatches[0]!.length, 3);
  });

  it("reports error on missing *** Begin Patch", async () => {
    const bridge = createFakeBridge();
    const tool = createApplyPatchTool(bridge as HostServicesBridge, "s1", tmpDir);
    const text = await executePatch(tool, "just some text");
    assert.match(text, /parse error/);
    assert.match(text, /Begin Patch/);
  });

  it("reports error when context not found", async () => {
    writeFileSync(join(tmpDir, "test.txt"), "line1\nline2\nline3\n");
    const bridge = createFakeBridge();
    const tool = createApplyPatchTool(bridge as HostServicesBridge, "s1", tmpDir);

    const patch = `*** Begin Patch
*** Update File: test.txt
@@ nonexistent_context
-line2
+modified
*** End Patch`;
    const text = await executePatch(tool, patch);
    assert.match(text, /Context not found/);
  });
});
