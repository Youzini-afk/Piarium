import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBashTool } from "../../src/harness/bash-tool.js";
import type { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import type { ShellExecResult } from "@piarium/protocol";

function createFakeBridge(result: ShellExecResult): Pick<HostServicesBridge, "request"> {
  return {
    request: async () => result,
  } as unknown as Pick<HostServicesBridge, "request">;
}

async function executeBash(bridge: HostServicesBridge, command: string): Promise<string> {
  const tool = createBashTool(bridge, "s1");
  const result = await tool.execute("call-1", { command }, undefined, undefined, undefined as never);
  return (result.content[0] as { type: "text"; text: string }).text;
}

describe("bash tool", () => {
  it("formats completed result with exit code", async () => {
    const bridge = createFakeBridge({
      kind: "completed",
      exitCode: 0,
      durationMs: 100,
      cwd: "/workspace",
      stdout: "hello world",
      stderr: "",
      handle: null,
      shown: null,
    }) as HostServicesBridge;
    const text = await executeBash(bridge, "echo hello world");
    assert.match(text, /hello world/);
    assert.match(text, /\[exit 0\]/);
  });

  it("formats completed result with handle for large output", async () => {
    const bridge = createFakeBridge({
      kind: "completed",
      exitCode: 0,
      durationMs: 100,
      cwd: "/workspace",
      stdout: "large output",
      stderr: "",
      handle: "out_abc123",
      shown: { head: 100, tail: 100, total: 50000 },
    }) as HostServicesBridge;
    const text = await executeBash(bridge, "cat big.txt");
    assert.match(text, /get_output\("out_abc123"\)/);
  });

  it("formats background result with id", async () => {
    const bridge = createFakeBridge({
      kind: "background",
      id: "sh_1",
      waitedMs: 60000,
      cwd: "/workspace",
      outputSoFar: "partial output",
    }) as HostServicesBridge;
    const text = await executeBash(bridge, "sleep 100");
    assert.match(text, /still running/);
    assert.match(text, /partial output/);
    assert.match(text, /get_output\("sh_1"\)/);
  });

  it("formats spawn-failed result", async () => {
    const bridge = createFakeBridge({
      kind: "spawn-failed",
      reason: "no-shell",
      interpreter: "bash",
      hint: "Install bash",
    }) as HostServicesBridge;
    const text = await executeBash(bridge, "echo test");
    assert.match(text, /spawn failed/);
    assert.match(text, /no-shell/);
  });

  it("formats stderr in completed result", async () => {
    const bridge = createFakeBridge({
      kind: "completed",
      exitCode: 1,
      durationMs: 100,
      cwd: "/workspace",
      stdout: "",
      stderr: "command not found",
      handle: null,
      shown: null,
    }) as HostServicesBridge;
    const text = await executeBash(bridge, "nonexistent");
    assert.match(text, /\[stderr\]/);
    assert.match(text, /command not found/);
    assert.match(text, /\[exit 1\]/);
  });
});
