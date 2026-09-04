import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLspNavigationTools } from "../../src/harness/lsp-tools.js";

describe("LSP navigation tools", () => {
  it("registers four tools and forwards one-based positions to typed Host methods", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const bridge = {
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        return { status: "ready", text: "src/a.ts:2:3", value: [] };
      },
    };
    const tools = createLspNavigationTools(bridge as never);
    assert.deepEqual(tools.map((tool) => tool.name), ["symbols", "definition", "references", "hover"]);
    const definition = tools.find((tool) => tool.name === "definition")!;
    const result = await definition.execute(
      "call-1",
      { path: "src/a.ts", line: 2, character: 3 } as never,
      undefined,
      undefined,
      undefined as never,
    );
    assert.deepEqual(requests, [{ method: "lsp.definition", params: { path: "src/a.ts", line: 2, character: 3 } }]);
    assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "src/a.ts:2:3");
  });
});
