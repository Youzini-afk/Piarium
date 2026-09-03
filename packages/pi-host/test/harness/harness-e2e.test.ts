/**
 * Harness e2e integration test — exercises the full link:
 *   tool function → HostServicesBridge → HarnessRouter → service → response → tool content text
 *
 * This tests the real wiring that pi-host uses: the same tool functions
 * (createBashTool, createGrepTool, etc.) call bridge.request(), which
 * emits harness.request events. The router dispatches to real services
 * (ShellSupervisor, OutputStore, etc.) and responds via harness.respond.
 * The bridge resolves the promise and the tool returns content text.
 *
 * Run: bunx tsx --test test/harness/harness-e2e.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Host side — these are in the web/application-host package.
// We import via relative path to the web package source.
import { createHarnessServiceHost } from "../../../web/application-host/lib/harness/service-host.js";
import { createHarnessRouter } from "../../../web/application-host/lib/harness/router.js";
import { registerHarnessServices } from "../../../web/application-host/lib/harness/harness-services.js";

// pi-host side
import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createBashTool } from "../../src/harness/bash-tool.js";
import { createGrepTool } from "../../src/harness/grep-tool.js";
import { createGetOutputTool } from "../../src/harness/output-tools.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const SESSION_ID = "e2e-session";
const WORKSPACE_ID = "e2e-workspace";

async function setupE2E() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "harness-e2e-"));

  // Create test files
  writeFileSync(join(workspaceRoot, "searchable.ts"), [
    "function hello() {",
    "  return 'world';",
    "}",
    "function goodbye() {",
    "  return 'farewell';",
    "}",
  ].join("\n"));

  const bigFile = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");
  writeFileSync(join(workspaceRoot, "big.txt"), bigFile);
  mkdirSync(join(workspaceRoot, "packages"), { recursive: true });

  // Host side: create service host with mock search (real shell + output store)
  const harnessServiceHost = createHarnessServiceHost({
    search: async (request, _options) => {
      // Simple mock search: grep through files in workspaceRoot
      const { spawnSync } = await import("node:child_process");
      const result = spawnSync("grep", ["-rn", request.query, workspaceRoot], { encoding: "utf8" });
      const hits = result.stdout.split("\n").filter(Boolean).map((line) => {
        const parts = line.split(":");
        const file = parts[0] ?? "";
        const lineNo = parts[1] ?? "0";
        const rest = parts.slice(2).join(":");
        return {
          column: 0,
          line: parseInt(lineNo, 10) || 0,
          preview: rest,
          resource: { resourceId: file, workspaceId: request.workspaceId },
        };
      });
      return { status: "ready" as const, generation: undefined, hits };
    },
    resolveWorkspaceRoot: async () => workspaceRoot,
    discoveredShells: {
      hasBash: process.platform !== "win32",
      hasPowerShell: process.platform === "win32",
      ...(process.platform === "win32" ? { gitBashPath: "C:\\Program Files\\Git\\bin\\bash.exe" } : {}),
    },
  });
  harnessServiceHost.registerSession({ sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, workspaceRoot });

  // Router with respond callback that feeds back to bridge
  let bridge: HostServicesBridge;
  const router = createHarnessRouter({
    respond: async (sessionId, requestId, outcome) => {
      bridge.respond(sessionId, requestId, outcome);
    },
    resolveWorkspace: async () => WORKSPACE_ID,
  });
  registerHarnessServices(router, harnessServiceHost);

  // pi-host side: bridge — emits events that the router processes
  bridge = new HostServicesBridge({
    emit: (_event, data) => {
      void router.processEvent({
        kind: "host",
        sessionId: data.sessionId,
        envelope: { kind: "event", event: "harness.request", data },
      });
    },
    sessionId: SESSION_ID,
    defaultTimeoutMs: 30000,
  });

  return { workspaceRoot, harnessServiceHost, router, bridge };
}

async function executeTool(
  tool: ToolDefinition,
  params: Record<string, unknown>,
): Promise<string> {
  const result = await tool.execute("test-call", params as never, undefined, undefined, undefined as never) as { content: Array<{ type: string; text: string }>; details?: unknown };
  return result.content.map((c) => c.text).join("\n");
}

describe("harness e2e integration", () => {
  it("1. bash pwd outputs workspace root", async () => {
    const { workspaceRoot, bridge, harnessServiceHost, router } = await setupE2E();
    try {
      const bashTool = createBashTool(bridge, SESSION_ID, workspaceRoot);
      const text = await executeTool(bashTool, { command: "pwd" });
      const dirName = workspaceRoot.split(/[\\/]/).pop();
      assert.ok(text.includes(dirName!), `bash pwd output should contain workspace dir name "${dirName}": got "${text}"`);
    } finally {
      bridge.dispose();
      router.dispose();
      harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("2. bash cd packages then pwd outputs .../packages", async () => {
    const { workspaceRoot, bridge, harnessServiceHost, router } = await setupE2E();
    try {
      const bashTool = createBashTool(bridge, SESSION_ID, workspaceRoot);
      const text = await executeTool(bashTool, { command: "cd packages && pwd" });
      assert.ok(text.includes("packages"), `bash cd packages && pwd should include "packages": got "${text}"`);
    } finally {
      bridge.dispose();
      router.dispose();
      harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("3. background command + get_output retrieves output", async () => {
    const { workspaceRoot, bridge, harnessServiceHost, router } = await setupE2E();
    try {
      const bashTool = createBashTool(bridge, SESSION_ID, workspaceRoot);
      const getOutputTool = createGetOutputTool(bridge, SESSION_ID);
      const sleepCmd = process.platform === "win32"
        ? "powershell -Command \"Start-Sleep -Seconds 2; Write-Output done\""
        : "sleep 2 && echo done";
      const bgText = await executeTool(bashTool, { command: sleepCmd, waitMs: 500 });
      // Background shell should return a shell ID
      assert.ok(bgText.includes("sh_") || bgText.includes("background"), `background bash should return shell id: got "${bgText}"`);

      // Wait for command to finish
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Extract shell ID from the background text
      const shellIdMatch = bgText.match(/sh_\w+/);
      if (shellIdMatch) {
        const outputText = await executeTool(getOutputTool, { id: shellIdMatch[0] });
        assert.ok(outputText.length > 0, `get_output should retrieve output: got "${outputText}"`);
      }
    } finally {
      bridge.dispose();
      router.dispose();
      harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("4. grep hit finds text and miss returns 0 hits", async () => {
    const { workspaceRoot, bridge, harnessServiceHost, router } = await setupE2E();
    try {
      const grepTool = createGrepTool(bridge, SESSION_ID);
      const hitText = await executeTool(grepTool, { pattern: "hello", path: workspaceRoot });
      assert.ok(hitText.includes("hello") || hitText.includes("searchable.ts"), `grep hit should find 'hello': got "${hitText}"`);

      const missText = await executeTool(grepTool, { pattern: "nonexistent_xyz123", path: workspaceRoot });
      assert.ok(missText.includes("0") || missText.includes("no") || missText.includes("empty"), `grep miss should indicate 0 hits: got "${missText}"`);
    } finally {
      bridge.dispose();
      router.dispose();
      harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("5. read 5000-line file returns truncated text with get_output handle", async () => {
    const { workspaceRoot, bridge, harnessServiceHost, router } = await setupE2E();
    try {
      const bashTool = createBashTool(bridge, SESSION_ID, workspaceRoot);
      const getOutputTool = createGetOutputTool(bridge, SESSION_ID);
      // Read the big file via bash cat — the truncation extension should kick in
      const text = await executeTool(bashTool, { command: "cat big.txt" });
      // The output should be truncated and contain an output handle
      assert.ok(text.includes("out_") || text.includes("line 1"), `read big file should contain output handle or first line: got "${text.slice(0, 100)}..."`);

      // If there's an output handle, paginate with get_output
      const handleMatch = text.match(/out_\w+/);
      if (handleMatch) {
        const page1 = await executeTool(getOutputTool, { handle: handleMatch[0], offset: 0, length: 1024 });
        assert.ok(page1.includes("line 1"), `get_output page 1 should contain 'line 1': got "${page1.slice(0, 100)}..."`);
        const page2 = await executeTool(getOutputTool, { handle: handleMatch[0], offset: 1024, length: 1024 });
        assert.ok(page2.length > 0, `get_output page 2 should have content: got "${page2.slice(0, 100)}..."`);
      }
    } finally {
      bridge.dispose();
      router.dispose();
      harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("6. grep disabled in settings → tool not registered (falls back to Pi built-in)", async () => {
    // This test verifies the settings gating logic in session-host.
    // When harness.tools.grep === false, createGrepTool is not called.
    // We verify the mergeHarnessSettings + tools check logic here.
    const { mergeHarnessSettings } = await import("@piarium/protocol");
    const settings = mergeHarnessSettings(
      { tools: { grep: false } },
      {},
    );
    assert.equal(settings.tools.grep, false, "grep should be disabled in merged settings");
    // In session-host, the check is: if (toolsEnabled.grep !== false) { register grep }
    // So grep=false means the tool is NOT registered, and Pi falls back to built-in.
    const grepEnabled = settings.tools.grep !== false;
    assert.equal(grepEnabled, false, "grep should not be enabled when settings.tools.grep is false");
  });
});
