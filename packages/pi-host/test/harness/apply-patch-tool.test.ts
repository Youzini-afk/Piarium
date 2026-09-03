import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApplyPatchTool } from "../../src/harness/apply-patch-tool.js";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostServicesBridge } from "../../src/harness/host-services-bridge.js";

function createFakeBridge(diagnostics: unknown[]): Pick<HostServicesBridge, "request"> {
  return {
    request: async (method: string) => {
      if (method === "lsp.diagnostics") return { status: "ready", diagnostics };
      if (method === "fs.lock") return { held: true };
      throw new Error(`unexpected method: ${method}`);
    },
  } as unknown as Pick<HostServicesBridge, "request">;
}

async function executeApplyPatch(
  bridge: HostServicesBridge,
  cwd: string,
  path: string,
  patch: string,
): Promise<{ text: string; details: unknown }> {
  const tool = createApplyPatchTool(bridge, "s1", cwd);
  const result = await tool.execute("call-1", { path, patch }, undefined, undefined, undefined as never);
  return {
    text: (result.content[0] as { type: "text"; text: string }).text,
    details: result.details,
  };
}

describe("apply_patch tool", () => {
  it("applies a simple patch", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "patch-test-"));
    try {
      const filePath = join(tmpDir, "test.txt");
      writeFileSync(filePath, "line1\nline2\nline3\n", "utf8");

      const bridge = createFakeBridge([]) as HostServicesBridge;
      const patch = `--- a/test.txt\n+++ b/test.txt\n@@ -1,3 +1,3 @@\n line1\n-line2\n+line2 modified\n line3\n`;
      const { text, details } = await executeApplyPatch(bridge, tmpDir, "test.txt", patch);

      assert.match(text, /patch applied/);
      assert.equal((details as { applied: boolean }).applied, true);
      const newContent = readFileSync(filePath, "utf8");
      assert.equal(newContent, "line1\nline2 modified\nline3\n");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns error for missing headers", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "patch-test-"));
    try {
      const bridge = createFakeBridge([]) as HostServicesBridge;
      const { text, details } = await executeApplyPatch(bridge, tmpDir, "test.txt", "@@ -1,1 +1,1 @@\n line1\n");
      assert.match(text, /patch parse error/);
      assert.match(text, /--- or \+\+\+ header/);
      assert.equal((details as { applied: boolean }).applied, false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns error for context mismatch", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "patch-test-"));
    try {
      const filePath = join(tmpDir, "test.txt");
      writeFileSync(filePath, "line1\nline2\nline3\n", "utf8");

      const bridge = createFakeBridge([]) as HostServicesBridge;
      const patch = `--- a/test.txt\n+++ b/test.txt\n@@ -1,3 +1,3 @@\n line1\n-wrong line\n+line2 modified\n line3\n`;
      const { text, details } = await executeApplyPatch(bridge, tmpDir, "test.txt", patch);

      assert.match(text, /patch apply error/);
      assert.match(text, /Context mismatch/);
      assert.equal((details as { applied: boolean }).applied, false);
      // File should be unchanged
      const content = readFileSync(filePath, "utf8");
      assert.equal(content, "line1\nline2\nline3\n");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns error for file not found", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "patch-test-"));
    try {
      const bridge = createFakeBridge([]) as HostServicesBridge;
      const patch = `--- a/missing.txt\n+++ b/missing.txt\n@@ -1,1 +1,1 @@\n-line1\n+line1 modified\n`;
      const { text } = await executeApplyPatch(bridge, tmpDir, "missing.txt", patch);
      assert.match(text, /file not found/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("applies multiple hunks", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "patch-test-"));
    try {
      const filePath = join(tmpDir, "test.txt");
      writeFileSync(filePath, "line1\nline2\nline3\nline4\nline5\n", "utf8");

      const bridge = createFakeBridge([]) as HostServicesBridge;
      const patch = `--- a/test.txt\n+++ b/test.txt\n@@ -1,2 +1,2 @@\n-line1\n+line1a\n line2\n@@ -4,2 +4,2 @@\n line4\n-line5\n+line5a\n`;
      const { text, details } = await executeApplyPatch(bridge, tmpDir, "test.txt", patch);

      assert.match(text, /patch applied/);
      assert.equal((details as { applied: boolean; hunks: number }).hunks, 2);
      const newContent = readFileSync(filePath, "utf8");
      assert.equal(newContent, "line1a\nline2\nline3\nline4\nline5a\n");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("includes diagnostics in output when present", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "patch-test-"));
    try {
      const filePath = join(tmpDir, "test.ts");
      writeFileSync(filePath, "const x = 1\n", "utf8");

      const bridge = createFakeBridge([
        { line: 1, character: 1, severity: "error", message: "Type error", source: "tsc" },
      ]) as HostServicesBridge;
      const patch = `--- a/test.ts\n+++ b/test.ts\n@@ -1,1 +1,1 @@\n-const x = 1\n+const x = 2\n`;
      const { text } = await executeApplyPatch(bridge, tmpDir, "test.ts", patch);

      assert.match(text, /Diagnostics/);
      assert.match(text, /Type error/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
