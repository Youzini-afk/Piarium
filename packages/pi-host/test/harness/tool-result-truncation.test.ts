import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolResultTruncationExtension } from "../../src/harness/tool-result-truncation.js";
import type { HostServicesBridge } from "../../src/harness/host-services-bridge.js";

function createFakeBridge(stored: Map<string, string>): Pick<HostServicesBridge, "request"> {
  let counter = 0;
  return {
    request: async (method: string, params: Record<string, unknown>) => {
      if (method !== "output.store") throw new Error(`unexpected method: ${method}`);
      const text = params.text as string;
      const handle = `out_${counter++}`;
      stored.set(handle, text);
      return { handle, total: Buffer.byteLength(text, "utf8") };
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
    const result = await getHandler()!(event) as { content: Array<{ type: string; text: string }>; details: { truncated: { handle: string; total: number; head: number; tail: number } } };
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
    assert.equal(stored.get(result.details.truncated.handle), longText);
  });

  it("uses 0.375 head ratio for bash", async () => {
    const stored = new Map<string, string>();
    const bridge = createFakeBridge(stored);
    const { pi, getHandler } = createFakePi();
    createToolResultTruncationExtension({ bridge: bridge as HostServicesBridge, visibleBytes: 80, sessionId: "s1" })(pi as never);

    // Text with newlines to test backtracking
    const longText = "line1\n" + "b".repeat(100) + "\nline3\n" + "c".repeat(100);
    const event = {
      type: "tool_result",
      toolName: "bash",
      content: [{ type: "text", text: longText }],
      details: undefined,
      isError: false,
    };
    const result = await getHandler()!(event) as { content: Array<{ type: string; text: string }>; details: { truncated: { head: number; tail: number } } };
    assert.ok(result);
    // head should be roughly 0.375 * 80 = 30 chars (before newline backtracking)
    // tail should be roughly 0.625 * 80 = 50 chars
    assert.ok(result.details.truncated.head < result.details.truncated.tail, "bash head should be smaller than tail");
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
});


