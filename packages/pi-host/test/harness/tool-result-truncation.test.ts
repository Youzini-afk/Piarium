import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolResultTruncationExtension } from "../../src/harness/tool-result-truncation.js";
import { createBashTool } from "../../src/harness/bash-tool.js";
import type { HostServicesBridge } from "../../src/harness/host-services-bridge.js";

function createFakeBridge(stored: Map<string, string>): Pick<HostServicesBridge, "request"> {
  let counter = 0;
  return {
    request: async (method: string, params: Record<string, unknown>) => {
      if (method !== "output.store") throw new Error(`unexpected method: ${method}`);
      const text = params.text as string;
      const handle = `out_${counter++}`;
      stored.set(handle, text);
      return {
        ref: { durability: "ephemeral", generation: "test-generation", handle },
        total: Buffer.byteLength(text, "utf8"),
      };
    },
  } as unknown as Pick<HostServicesBridge, "request">;
}

function createFakePi(): {
  pi: { on: (event: string, handler: (...args: unknown[]) => unknown) => void };
  getHandler: () => ((event: unknown) => unknown) | undefined;
} {
  let handler: ((event: unknown) => unknown) | undefined;
  return {
    pi: {
      on: (_event: string, h: (...args: unknown[]) => unknown) => { handler = h as (event: unknown) => unknown; },
    },
    getHandler: () => handler,
  };
}

describe("tool-result-truncation", () => {
  it("does not truncate text under visibleBytes", async () => {
    const stored = new Map<string, string>();
    const bridge = createFakeBridge(stored);
    const { pi, getHandler } = createFakePi();
    createToolResultTruncationExtension({ bridge: bridge as HostServicesBridge, visibleBytes: 100, sessionId: "s1" })(pi as never);

    const event = {
      type: "tool_result",
      toolName: "read",
      content: [{ type: "text", text: "short text" }],
      details: undefined,
      isError: false,
    };
    const result = await getHandler()!(event);
    assert.equal(result, undefined);
    assert.equal(stored.size, 0);
  });

  it("truncates text over visibleBytes and stores full text", async () => {
    const stored = new Map<string, string>();
    const bridge = createFakeBridge(stored);
    const { pi, getHandler } = createFakePi();
    createToolResultTruncationExtension({ bridge: bridge as HostServicesBridge, visibleBytes: 50, sessionId: "s1" })(pi as never);

    const longText = "a".repeat(200);
    const event = {
      type: "tool_result",
      toolName: "read",
      content: [{ type: "text", text: longText }],
      details: undefined,
      isError: false,
    };
    const result = await getHandler()!(event) as { content: Array<{ type: string; text: string }>; details: { truncated: { ref: { handle: string }; total: number; head: number; tail: number } } };
    assert.ok(result);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0]!.type, "text");
    const text = result.content[0]!.text;
    assert.match(text, /\u2026/);
    assert.match(text, /\[output: 200 bytes/);
    assert.ok(result.details.truncated);
    assert.equal(result.details.truncated.total, 200);
    // Full text stored
    assert.equal(stored.size, 1);
    assert.equal(stored.get(result.details.truncated.ref.handle), longText);
  });

  it("does not re-trim organized bash or get_output results", async () => {
    const stored = new Map<string, string>();
    const bridge = createFakeBridge(stored);
    const { pi, getHandler } = createFakePi();
    createToolResultTruncationExtension({ bridge: bridge as HostServicesBridge, visibleBytes: 20, sessionId: "s1" })(pi as never);
    const longText = "FAIL src/mid.test.ts\n" + "x".repeat(200);
    for (const toolName of ["bash", "get_output"]) {
      const result = await getHandler()!({
        type: "tool_result",
        toolName,
        input: toolName === "bash" ? { command: "vitest run" } : { handle: "sh_1" },
        content: [{ type: "text", text: longText }],
        details: { display: longText, organized: { kind: "vitest", omitted: false, partial: true } },
        isError: false,
      });
      assert.equal(result, undefined, `${toolName} should keep Host organization`);
    }
    assert.equal(stored.size, 0);
  });

  it("truncates a legacy shell result when Host organization is absent", async () => {
    const stored = new Map<string, string>();
    const bridge = createFakeBridge(stored);
    const { pi, getHandler } = createFakePi();
    createToolResultTruncationExtension({ bridge: bridge as HostServicesBridge, visibleBytes: 20, sessionId: "s1" })(pi as never);
    const result = await getHandler()!({
      type: "tool_result",
      toolName: "bash",
      input: { command: "cat big.txt" },
      content: [{ type: "text", text: "legacy output\n" + "x".repeat(200) }],
      details: undefined,
      isError: false,
    }) as { details: { truncated: { ref: { handle: string } } } };
    assert.ok(result.details.truncated.ref.handle.startsWith("out_"));
    assert.equal(stored.size, 1);
  });

  it("recognizes the display returned by the public bash tool", async () => {
    const stored = new Map<string, string>();
    const bridge = {
      request: async () => ({
        kind: "completed" as const,
        exitCode: 1,
        durationMs: 1,
        cwd: "/workspace",
        stdout: "FAIL src/a.test.ts\n" + "x".repeat(200),
        stderr: "",
        handle: "out_full",
        shown: null,
        display: "FAIL src/a.test.ts\n" + "x".repeat(200),
        organized: { kind: "vitest" as const, omitted: false, partial: false },
      }),
    } as unknown as HostServicesBridge;
    const bashResult = await createBashTool(bridge, "s1", "/workspace").execute(
      "call-1",
      { command: "bunx vitest run" },
      undefined,
      undefined,
      undefined as never,
    );
    const { pi, getHandler } = createFakePi();
    createToolResultTruncationExtension({ bridge: {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "output.store") {
          stored.set("unexpected", String(params.text));
          return { ref: { durability: "ephemeral", generation: "test", handle: "out_unexpected" }, total: 1 };
        }
        throw new Error(`unexpected method: ${method}`);
      },
    } as unknown as HostServicesBridge, visibleBytes: 20, sessionId: "s1" })(pi as never);
    const result = await getHandler()!({
      type: "tool_result",
      toolName: "bash",
      input: { command: "bunx vitest run" },
      content: bashResult.content,
      details: bashResult.details,
      isError: false,
    });
    assert.equal(result, undefined);
    assert.equal(stored.size, 0);
  });

  it("keeps explicit get_output paging from being re-trimmed", async () => {
    const stored = new Map<string, string>();
    const bridge = createFakeBridge(stored);
    const { pi, getHandler } = createFakePi();
    createToolResultTruncationExtension({ bridge: bridge as HostServicesBridge, visibleBytes: 20, sessionId: "s1" })(pi as never);
    const result = await getHandler()!({
      type: "tool_result",
      toolName: "get_output",
      input: { handle: "sh_1", offset: 0, length: 100 },
      content: [{ type: "text", text: "explicit page\n" + "x".repeat(200) }],
      details: undefined,
      isError: false,
    });
    assert.equal(result, undefined);
    assert.equal(stored.size, 0);
  });

  it("counts the visible Unicode head and tail in bytes without broken characters", async () => {
    const stored = new Map<string, string>();
    const bridge = createFakeBridge(stored);
    const { pi, getHandler } = createFakePi();
    createToolResultTruncationExtension({ bridge: bridge as HostServicesBridge, visibleBytes: 20, sessionId: "s1" })(pi as never);
    const fullText = "你🙂界".repeat(20);
    const result = await getHandler()!({
      type: "tool_result",
      toolName: "read",
      content: [{ type: "text", text: fullText }],
      details: undefined,
      isError: false,
    }) as { content: Array<{ text: string }>; details: { truncated: { head: number; tail: number } } };
    assert.doesNotMatch(result.content[0]!.text, /�/);
    assert.match(result.content[0]!.text, /界\n\[output:/, "tail must retain the final code point");
    assert.match(result.content[0]!.text, new RegExp(`first ${result.details.truncated.head} and last ${result.details.truncated.tail}`));
  });

  it("returns undefined when output.store fails", async () => {
    const bridge = {
      request: async () => { throw new Error("store unavailable"); },
    } as unknown as HostServicesBridge;
    const { pi, getHandler } = createFakePi();
    createToolResultTruncationExtension({ bridge, visibleBytes: 10, sessionId: "s1" })(pi as never);

    const event = {
      type: "tool_result",
      toolName: "read",
      content: [{ type: "text", text: "a".repeat(100) }],
      details: undefined,
      isError: false,
    };
    const result = await getHandler()!(event);
    assert.equal(result, undefined);
  });

  it("preserves existing details and adds truncated", async () => {
    const stored = new Map<string, string>();
    const bridge = createFakeBridge(stored);
    const { pi, getHandler } = createFakePi();
    createToolResultTruncationExtension({ bridge: bridge as HostServicesBridge, visibleBytes: 10, sessionId: "s1" })(pi as never);

    const event = {
      type: "tool_result",
      toolName: "read",
      content: [{ type: "text", text: "a".repeat(100) }],
      details: { customField: "value" },
      isError: false,
    };
    const result = await getHandler()!(event) as { details: { customField: string; truncated: unknown } };
    assert.ok(result.details);
    assert.equal(result.details.customField, "value");
    assert.ok(result.details.truncated);
  });

  it("includes the ephemeral generation in the truncation marker", async () => {
    const stored = new Map<string, string>();
    const bridge = createFakeBridge(stored);
    const { pi, getHandler } = createFakePi();
    createToolResultTruncationExtension({ bridge: bridge as HostServicesBridge, visibleBytes: 10, sessionId: "s1" })(pi as never);

    const event = {
      type: "tool_result",
      toolName: "read",
      content: [{ type: "text", text: "a".repeat(100) }],
      details: undefined,
      isError: false,
    };
    const result = await getHandler()!(event) as { content: Array<{ text: string }> };
    const text = result.content[0]!.text;
    // The truncation marker must include the ephemeral generation so consumers
    // know the output is session-scoped and may be unavailable after restart.
    assert.ok(text.includes("ephemeral"), `text should include 'ephemeral': ${text}`);
    assert.ok(text.includes("generation"), `text should include 'generation': ${text}`);
  });
});

