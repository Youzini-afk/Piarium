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
const ACTOR = { authorityInstanceId: "test-authority", sessionId: SESSION_ID, workerId: "test-worker", workerGeneration: 1 } as const;
const CAPABILITIES = ["context.session", "process.shell", "read.lsp", "read.output", "read.search", "read.web", "write.document"] as const;

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
      // Simple mock search: read files and search for the pattern
      const { readdirSync, readFileSync, statSync } = await import("node:fs");
      const hits: Array<{ column: number; line: number; preview: string; resource: { resourceId: string; workspaceId: string } }> = [];
      const searchDir = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const fullPath = join(dir, entry);
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            if (entry === ".piarium-data" || entry === ".git") continue;
            searchDir(fullPath);
          } else {
            const content = readFileSync(fullPath, "utf8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              const lineText = lines[i] ?? "";
              if (lineText.includes(request.query)) {
                hits.push({
                  column: 0,
                  line: i + 1,
                  preview: lineText,
                  resource: { resourceId: fullPath, workspaceId: request.workspaceId },
                });
              }
            }
          }
        }
      };
      searchDir(workspaceRoot);
      if (hits.length === 0) {
        return { status: "empty" as const, generation: undefined };
      }
      return { status: "ready" as const, generation: undefined, hits };
    },
    resolveWorkspaceRoot: async () => workspaceRoot,
    discoveredShells: {
      hasBash: process.platform !== "win32",
      hasPowerShell: process.platform === "win32",
      ...(process.platform === "win32" ? { gitBashPath: "C:\\Program Files\\Git\\bin\\bash.exe" } : {}),
    },
  });
  harnessServiceHost.registerSession({ actor: ACTOR, grantedCapabilities: CAPABILITIES, workspaceId: WORKSPACE_ID, workspaceRoot });

  // Router with respond callback that feeds back to bridge
  let bridge: HostServicesBridge;
  const router = createHarnessRouter({
    respond: async (sessionId, requestId, outcome) => {
      bridge.respond(sessionId, requestId, outcome);
    },
    resolveActor: (identity) => harnessServiceHost.resolveActor(identity),
    authorizeWorkspacePath: async (actor, inputPath) => ({
      authorityId: "test-host",
      workspaceId: actor.workspaceId!,
      canonicalResourceId: inputPath,
      inputPath,
      resourceId: inputPath,
    }),
  });
  registerHarnessServices(router, harnessServiceHost);

  // pi-host side: bridge — emits events that the router processes
  bridge = new HostServicesBridge({
    emit: (_event, data) => {
      void router.processEvent({
        actor: ACTOR,
        kind: "host",
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
      await harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("2. bash cd packages then pwd outputs .../packages (two independent calls)", async () => {
    const { workspaceRoot, bridge, harnessServiceHost, router } = await setupE2E();
    try {
      const bashTool = createBashTool(bridge, SESSION_ID, workspaceRoot);
      // First call: cd packages
      await executeTool(bashTool, { command: "cd packages" });
      // Second call: pwd — output should contain the packages path
      const text = await executeTool(bashTool, { command: "pwd" });
      // The output includes the path plus [exit N] suffix; extract the path line
      const pwdLine = text.split("\n").find((l) => l.includes("packages"));
      assert.ok(pwdLine, `pwd output should contain a line with "packages": got "${text}"`);
      assert.ok(pwdLine!.trim().endsWith("packages"), `pwd path should end with "packages": got "${pwdLine!.trim()}"`);
    } finally {
      bridge.dispose();
      router.dispose();
      await harnessServiceHost.dispose();
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
      // Background shell must return a shell ID
      const shellIdMatch = bgText.match(/sh_\w+/);
      assert.ok(shellIdMatch, `background bash should return sh_ id: got "${bgText}"`);
      const shellId = shellIdMatch![0];

      // Wait for command to finish
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // get_output must retrieve non-empty output
      const outputText = await executeTool(getOutputTool, { id: shellId });
      assert.ok(outputText.length > 0, `get_output should retrieve non-empty output: got "${outputText}"`);
    } finally {
      bridge.dispose();
      router.dispose();
      await harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("4. grep hit finds text and miss returns 0 hits", async () => {
    const { workspaceRoot, bridge, harnessServiceHost, router } = await setupE2E();
    try {
      const grepTool = createGrepTool(bridge, SESSION_ID);
      const hitText = await executeTool(grepTool, { pattern: "hello", path: workspaceRoot });
      assert.ok(hitText.includes("hello"), `grep hit should find 'hello': got "${hitText}"`);

      const missText = await executeTool(grepTool, { pattern: "nonexistent_xyz123", path: workspaceRoot });
      assert.ok(missText.includes("0 hits (searched"), `grep miss should say "0 hits (searched": got "${missText}"`);
    } finally {
      bridge.dispose();
      router.dispose();
      await harnessServiceHost.dispose();
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
      // The output must contain an out_ handle (truncation kicks in at 32KB)
      const handleMatch = text.match(/out_\w+/);
      assert.ok(handleMatch, `read big file should contain out_ handle: got "${text.slice(0, 120)}..."`);
      const handle = handleMatch![0];
      // Page 1 must contain "line 1"
      const page1 = await executeTool(getOutputTool, { handle, offset: 0, length: 1024 });
      assert.ok(page1.includes("line 1"), `get_output page 1 should contain 'line 1': got "${page1.slice(0, 120)}..."`);
      // Page 2 must be non-empty
      const page2 = await executeTool(getOutputTool, { handle, offset: 1024, length: 1024 });
      assert.ok(page2.length > 0, `get_output page 2 should have content: got "${page2.slice(0, 120)}..."`);
    } finally {
      bridge.dispose();
      router.dispose();
      await harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("6. grep disabled in settings → selectHarnessTools omits grep; default includes it", async () => {
    const { mergeHarnessSettings, DEFAULT_HARNESS_SETTINGS } = await import("@piarium/protocol");
    const { selectHarnessTools } = await import("../../src/harness/select-tools.js");

    // Build a minimal fake bridge + deps for selectHarnessTools
    const fakeBridge = {
      request: async () => { throw new Error("not used"); },
      respond: () => undefined,
      dispose: () => undefined,
    } as unknown as import("../../src/harness/host-services-bridge.js").HostServicesBridge;
    const deps = {
      bridge: fakeBridge,
      sessionId: "test",
      cwd: "/tmp",
      workspaceMutationJournal: undefined,
      isOpenAIFamily: false,
    };

    // grep disabled → no grep tool
    const grepOffSettings = mergeHarnessSettings({ tools: { grep: false } }, {});
    const grepOffTools = selectHarnessTools(grepOffSettings, deps);
    assert.ok(!grepOffTools.some((t) => t.name === "grep"), "grep=false should omit grep tool");

    // default settings → grep present
    const defaultTools = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, deps);
    assert.ok(defaultTools.some((t) => t.name === "grep"), "default settings should include grep tool");
  });
});
