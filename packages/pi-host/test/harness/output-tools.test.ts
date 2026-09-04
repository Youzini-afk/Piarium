import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createGetOutputTool,
  createWriteToProcessTool,
  createKillShellTool,
  createDiagnosticsTool,
} from "../../src/harness/output-tools.js";
import type { HostServicesBridge } from "../../src/harness/host-services-bridge.js";

function createFakeBridge(handler: (method: string, params: Record<string, unknown>) => unknown): Pick<HostServicesBridge, "request"> {
  return {
    request: async (method: string, params: Record<string, unknown>) => handler(method, params),
  } as unknown as Pick<HostServicesBridge, "request">;
}

async function executeTool(tool: ReturnType<typeof createGetOutputTool>, params: Record<string, unknown>): Promise<string> {
  const result = await tool.execute("call-1", params as never, undefined, undefined, undefined as never);
  return (result.content[0] as { type: "text"; text: string }).text;
}

describe("get_output tool", () => {
  it("reads stored output via output.read for out_ handles", async () => {
    const bridge = createFakeBridge((method) => {
      if (method === "output.read") return { text: "stored content", offset: 0, length: 14, nextOffset: 14, total: 14, eof: true };
      throw new Error(`unexpected: ${method}`);
    });
    const tool = createGetOutputTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { handle: "out_abc" });
    assert.match(text, /stored content/);
    assert.match(text, /14\/14 bytes/);
  });

  it("reads background shell via shell.read for sh_ IDs", async () => {
    const bridge = createFakeBridge((method) => {
      if (method === "shell.read") return { text: "shell output", offset: 0, length: 12, nextOffset: 12, total: 100, eof: false, running: true };
      throw new Error(`unexpected: ${method}`);
    });
    const tool = createGetOutputTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { handle: "sh_1" });
    assert.match(text, /shell output/);
    assert.match(text, /still running/);
    assert.match(text, /12\/100 bytes/);
  });

  it("handles errors gracefully", async () => {
    const bridge = createFakeBridge(() => { throw new Error("not found"); });
    const tool = createGetOutputTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { handle: "out_missing" });
    assert.match(text, /get_output failed/);
  });
});

describe("write_to_process tool", () => {
  it("writes to shell via shell.write", async () => {
    const bridge = createFakeBridge((method, params) => {
      if (method === "shell.write") return { accepted: true };
      throw new Error(`unexpected: ${method}`);
    });
    const tool = createWriteToProcessTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { shellId: "sh_1", text: "y\n" });
    assert.match(text, /wrote/);
  });

  it("reports when shell not found", async () => {
    const bridge = createFakeBridge(() => { return { accepted: false }; });
    const tool = createWriteToProcessTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { shellId: "sh_missing", text: "y\n" });
    assert.match(text, /not found or not writable/);
  });
});

describe("kill_shell tool", () => {
  it("kills shell via shell.kill", async () => {
    const bridge = createFakeBridge((method) => {
      if (method === "shell.kill") return { killed: true };
      throw new Error(`unexpected: ${method}`);
    });
    const tool = createKillShellTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { shellId: "sh_1" });
    assert.match(text, /killed sh_1/);
  });

  it("reports when shell not found", async () => {
    const bridge = createFakeBridge(() => { return { killed: false }; });
    const tool = createKillShellTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { shellId: "sh_missing" });
    assert.match(text, /not found or already exited/);
  });
});

describe("diagnostics tool", () => {
  it("formats clean result", async () => {
    const bridge = createFakeBridge((method) => {
      if (method === "lsp.diagnosticsSnapshot") return { status: "ready", diagnostics: [] };
      throw new Error(`unexpected: ${method}`);
    });
    const tool = createDiagnosticsTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { path: "/src/test.ts" });
    assert.match(text, /clean/);
    assert.match(text, /0 diagnostics/);
  });

  it("formats diagnostics with errors", async () => {
    const bridge = createFakeBridge((method) => {
      if (method === "lsp.diagnosticsSnapshot") return {
        status: "ready",
        diagnostics: [
          { line: 5, character: 1, severity: "error", code: "TS2304", message: "Cannot find name 'foo'", source: "tsc" },
          { line: 10, character: 3, severity: "warning", message: "Unused variable", source: "tsc" },
        ],
      };
      throw new Error(`unexpected: ${method}`);
    });
    const tool = createDiagnosticsTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { path: "/src/test.ts" });
    assert.match(text, /2 diagnostic/);
    assert.match(text, /error.*TS2304.*Cannot find name/);
    assert.match(text, /warning.*Unused variable/);
  });

  it("formats unavailable result", async () => {
    const bridge = createFakeBridge((method) => {
      if (method === "lsp.diagnosticsSnapshot") return { status: "unavailable", diagnostics: [] };
      throw new Error(`unexpected: ${method}`);
    });
    const tool = createDiagnosticsTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { path: "/src/test.ts" });
    assert.match(text, /unavailable/);
  });
});
