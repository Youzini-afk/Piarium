/**
 * Phase 3b e2e integration test — permission gate extension.
 *
 * Tests that the permission gate extension correctly blocks/allows
 * tool calls based on the policy.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHarnessServiceHost } from "../../../web/application-host/lib/harness/service-host.js";
import { createHarnessRouter } from "../../../web/application-host/lib/harness/router.js";
import { registerHarnessServices } from "../../../web/application-host/lib/harness/harness-services.js";

import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createBashTool } from "../../src/harness/bash-tool.js";
import { createGrepTool } from "../../src/harness/grep-tool.js";
import { createPermissionGateExtension, buildPermissionPolicy } from "../../src/harness/permission-gate-extension.js";
import { evaluateGate, defaultRules, type PermissionPolicy } from "@piarium/protocol";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const SESSION_ID = "p3b-e2e-session";
const WORKSPACE_ID = "p3b-e2e-workspace";

async function setupP3bE2E() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "p3b-e2e-"));

  const harnessServiceHost = createHarnessServiceHost({
    search: async () => ({ status: "empty" as const, generation: undefined }),
    resolveWorkspaceRoot: async () => workspaceRoot,
    discoveredShells: {
      hasBash: process.platform !== "win32",
      hasPowerShell: process.platform === "win32",
    },
  });
  harnessServiceHost.registerSession({ sessionId: SESSION_ID, workspaceId: WORKSPACE_ID, workspaceRoot });

  let bridge: HostServicesBridge;
  const router = createHarnessRouter({
    respond: async (sessionId, requestId, outcome) => {
      bridge.respond(sessionId, requestId, outcome);
    },
    resolveWorkspace: async () => WORKSPACE_ID,
  });
  registerHarnessServices(router, harnessServiceHost);

  bridge = new HostServicesBridge({
    emit: (_event, data) => {
      void router.processEvent({
        kind: "host",
        sessionId: data.sessionId,
        envelope: { kind: "event", event: "harness.request", data },
      });
    },
    sessionId: SESSION_ID,
    defaultTimeoutMs: 10000,
  });

  return { workspaceRoot, harnessServiceHost, router, bridge };
}

describe("Phase 3b permission gate", () => {
  it("normal mode: allows read-only tools (grep)", () => {
    const policy = buildPermissionPolicy("normal");
    const result = evaluateGate("grep", { pattern: "test" }, policy);
    assert.equal(result.decision, "allow");
  });

  it("normal mode: asks for edit tools", () => {
    const policy = buildPermissionPolicy("normal");
    const result = evaluateGate("edit", { path: "test.ts" }, policy);
    assert.equal(result.decision, "ask");
  });

  it("normal mode: asks for bash", () => {
    const policy = buildPermissionPolicy("normal");
    const result = evaluateGate("bash", { command: "echo hello" }, policy);
    assert.equal(result.decision, "ask");
  });

  it("normal mode: high-risk bash always asks", () => {
    const policy = buildPermissionPolicy("normal");
    const result = evaluateGate("bash", { command: "rm -rf /" }, policy);
    assert.equal(result.decision, "ask");
  });

  it("accept-edits mode: allows edit tools", () => {
    const policy = buildPermissionPolicy("accept-edits");
    const result = evaluateGate("edit", { path: "test.ts" }, policy);
    assert.equal(result.decision, "allow");
  });

  it("accept-edits mode: still asks for bash", () => {
    const policy = buildPermissionPolicy("accept-edits");
    const result = evaluateGate("bash", { command: "echo hello" }, policy);
    assert.equal(result.decision, "ask");
  });

  it("bypass mode: allows everything", () => {
    const policy = buildPermissionPolicy("bypass");
    const result1 = evaluateGate("bash", { command: "rm -rf /" }, policy);
    const result2 = evaluateGate("edit", { path: "test.ts" }, policy);
    assert.equal(result1.decision, "allow");
    assert.equal(result2.decision, "allow");
  });

  it("dispatch with askBefore: asks for specified roles", () => {
    const policy = buildPermissionPolicy("normal", { check: true, explore: false });
    const result1 = evaluateGate("dispatch", { role: "check", task: "test" }, policy);
    const result2 = evaluateGate("dispatch", { role: "explore", task: "test" }, policy);
    assert.equal(result1.decision, "ask");
    assert.equal(result2.decision, "allow");
  });

  it("Phase 3 tools (threads, send, read_thread) are read-only", () => {
    const policy = buildPermissionPolicy("normal");
    assert.equal(evaluateGate("threads", {}, policy).decision, "allow");
    assert.equal(evaluateGate("send", { threadId: "t1", message: "hi" }, policy).decision, "allow");
    assert.equal(evaluateGate("read_thread", { threadId: "t1" }, policy).decision, "allow");
  });

  it("Phase 3 tools (merge) is gated, dispatch/kill are mutation:none → allow", () => {
    const policy = buildPermissionPolicy("normal");
    // dispatch is mutation:none → allow (unless askBefore configured)
    assert.equal(evaluateGate("dispatch", { role: "check", task: "test" }, policy).decision, "allow");
    // merge is mutation:journaled → ask in normal mode
    assert.equal(evaluateGate("merge", { threadId: "t1" }, policy).decision, "ask");
    // kill is mutation:none → allow
    assert.equal(evaluateGate("kill", { threadId: "t1" }, policy).decision, "allow");
  });

  it("dispatch with askBefore can override mutation:none → ask", () => {
    const policy = buildPermissionPolicy("normal", { check: true });
    assert.equal(evaluateGate("dispatch", { role: "check", task: "test" }, policy).decision, "ask");
    // Other roles still allow
    assert.equal(evaluateGate("dispatch", { role: "explore", task: "test" }, policy).decision, "allow");
  });

  it("non-harness tools pass through (allow)", () => {
    const policy = buildPermissionPolicy("normal");
    assert.equal(evaluateGate("mcp_some_tool", {}, policy).decision, "allow");
    assert.equal(evaluateGate("unknown_custom_tool", {}, policy).decision, "allow");
  });

  it("permission gate extension factory creates a valid extension", () => {
    const policy = buildPermissionPolicy("normal");
    const factory = createPermissionGateExtension({ policy });
    assert.equal(typeof factory, "function");
  });

  it("e2e: grep tool works through bridge with normal policy (allow)", async () => {
    const { workspaceRoot, bridge, harnessServiceHost } = await setupP3bE2E();
    try {
      // grep is read-only, so it should work even in normal mode
      const grepTool = createGrepTool(bridge, SESSION_ID);
      const result = await grepTool.execute(
        "test-call",
        { pattern: "nonexistent" } as never,
        undefined,
        undefined,
        undefined as never,
      ) as { content: Array<{ type: string; text: string }> };
      const text = result.content.map((c) => c.text).join("\n");
      assert.match(text, /0 hits|empty/, "grep should return empty result");
    } finally {
      await harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });
});
