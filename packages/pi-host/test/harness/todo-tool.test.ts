import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTodoTool } from "../../src/harness/todo-tool.js";

describe("todo tool", () => {
  it("treats low confidence as informational without a second confirmation", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const tool = createTodoTool({
      request: async (_method: string, params: Record<string, unknown>) => {
        requests.push(params);
        return { text: "plan updated" };
      },
    } as never);
    let prompts = 0;
    const result = await tool.execute(
      "call-1",
      { items: [{ text: "Investigate", status: "open" }], confidence: 0.2 } as never,
      undefined,
      undefined,
      {
        sessionManager: { getBranch: () => [{ id: "entry-1" }] },
        ui: { select: async () => { prompts += 1; return "Use plan"; } },
      } as never,
    );
    assert.equal(prompts, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.confirmed, undefined);
    assert.deepEqual(result.details, {});
  });

});
