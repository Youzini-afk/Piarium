import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createWebSearchTool } from "../../src/harness/websearch-tool.js";
import type { HarnessRequestData } from "@piarium/protocol";

function createTestBridge(sessionId: string) {
  const emitted: HarnessRequestData[] = [];
  const bridge = new HostServicesBridge({
    emit: (_e, data) => { emitted.push(data); },
    sessionId,
    defaultTimeoutMs: 5000,
  });
  return { bridge, emitted };
}

describe("websearch tool", () => {
  it("formats search results", async () => {
    const { bridge, emitted } = createTestBridge("test");
    const tool = createWebSearchTool(bridge, "test");
    const resultPromise = tool.execute("tc1", { query: "hello world" } as never, undefined as never, undefined as never, undefined as never);

    await new Promise((r) => setImmediate(r));
    bridge.respond("test", emitted[0]!.requestId, {
      ok: true,
      result: {
        providerId: "test-provider",
        results: [
          { title: "Hello World", url: "https://example.com/1", snippet: "A greeting" },
          { title: "World Hello", url: "https://example.com/2", snippet: "Reversed" },
        ],
      },
    });

    const result = await resultPromise as { content: Array<{ type: string; text: string }> };
    const text = result.content[0]?.text ?? "";
    assert.ok(text.includes('2 results for "hello world" (test-provider)'));
    assert.ok(text.includes("- Hello World"));
    assert.ok(text.includes("https://example.com/1"));
    assert.ok(text.includes("A greeting"));
    bridge.dispose();
  });

  it("returns error when no provider configured", async () => {
    const { bridge, emitted } = createTestBridge("test");
    const tool = createWebSearchTool(bridge, "test");
    const resultPromise = tool.execute("tc2", { query: "test" } as never, undefined as never, undefined as never, undefined as never);

    await new Promise((r) => setImmediate(r));
    bridge.respond("test", emitted[0]!.requestId, {
      ok: true,
      result: { providerId: "none", results: [] },
    });

    const result = await resultPromise as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert.equal(result.isError, true);
    const text = result.content[0]?.text ?? "";
    assert.ok(text.includes("no search provider configured"));
    bridge.dispose();
  });

  it("passes domain filters to the service", async () => {
    const { bridge, emitted } = createTestBridge("test");
    const tool = createWebSearchTool(bridge, "test");
    const resultPromise = tool.execute("tc3", {
      query: "test",
      allowed_domains: ["example.com"],
      blocked_domains: ["spam.com"],
      recency: "week",
      limit: 5,
    } as never, undefined as never, undefined as never, undefined as never);

    await new Promise((r) => setImmediate(r));
    const requestData = emitted[0]!;
    assert.equal(requestData.method, "web.search");
    const params = requestData.params as { allowedDomains?: string[]; blockedDomains?: string[]; recency?: string; limit?: number };
    assert.deepEqual(params.allowedDomains, ["example.com"]);
    assert.deepEqual(params.blockedDomains, ["spam.com"]);
    assert.equal(params.recency, "week");
    assert.equal(params.limit, 5);

    bridge.respond("test", requestData.requestId, {
      ok: true,
      result: { providerId: "p", results: [] },
    });

    const result = await resultPromise as { isError?: boolean };
    assert.equal(result.isError, true); // 0 results → error
    bridge.dispose();
  });
});
