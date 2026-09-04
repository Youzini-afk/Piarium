import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTodoTool } from "../../src/harness/todo-tool.js";

describe("todo confirmation UI", () => {
  it("asks once in pi-host and carries the confirmation to the Host", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const bridge = {
      request: async (_method: string, params: Record<string, unknown>) => {
        requests.push(params);
        return { text: "plan updated", askedConfirmation: true, confirmed: true };
      },
    };
    let prompts = 0;
    const context = {
      ui: { select: async () => { prompts += 1; return "Use plan"; } },
    };
    const tool = createTodoTool(bridge as never);
    const params = { items: [{ text: "Investigate", status: "open" }], confidence: 0.2 };
    await tool.execute("call-1", params as never, undefined, undefined, context as never);
    await tool.execute("call-2", params as never, undefined, undefined, context as never);
    assert.equal(prompts, 1);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.confirmed, true);
    assert.equal(requests[1]?.confirmed, true);
  });

  it("does not call the Host when the user cancels", async () => {
    let requests = 0;
    const tool = createTodoTool({
      request: async () => { requests += 1; return { text: "unexpected", askedConfirmation: false }; },
    } as never);
    const result = await tool.execute(
      "call-1",
      { items: [{ text: "Risky guess", status: "open" }], confidence: 0.1 } as never,
      undefined,
      undefined,
      { ui: { select: async () => "Cancel" } } as never,
    );
    assert.equal(requests, 0);
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /cancelled/);
  });
});
