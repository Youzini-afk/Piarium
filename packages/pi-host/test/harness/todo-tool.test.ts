import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTodoTool } from "../../src/harness/todo-tool.js";

describe("todo confirmation UI", () => {
  it("does not prompt for low confidence when the Host does not require approval", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const tool = createTodoTool({
      request: async (_method: string, params: Record<string, unknown>) => {
        requests.push(params);
        return { text: "plan updated", askedConfirmation: false };
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
    assert.equal(result.details?.askedConfirmation, false);
  });

  it("asks only after the Host reports an explicit approval policy", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const tool = createTodoTool({
      request: async (_method: string, params: Record<string, unknown>) => {
        requests.push(params);
        if (params.confirmed === true) {
          return { text: "plan updated", askedConfirmation: true, confirmed: true };
        }
        return { text: "plan update requires user confirmation", askedConfirmation: true, confirmed: false };
      },
    } as never);
    let prompts = 0;
    const context = {
      sessionManager: { getBranch: () => [{ id: "entry-1" }] },
      ui: { select: async () => { prompts += 1; return "Use plan"; } },
    };
    await tool.execute("call-1", { items: [{ text: "Investigate", status: "open" }] } as never, undefined, undefined, context as never);
    await tool.execute("call-2", { items: [{ text: "Investigate", status: "open" }] } as never, undefined, undefined, context as never);
    assert.equal(prompts, 1);
    assert.equal(requests.length, 3);
    assert.equal(requests[0]?.confirmed, undefined);
    assert.equal(requests[1]?.confirmed, true);
    assert.equal(requests[2]?.confirmed, true);
    assert.deepEqual(requests[0]?.branchEntryIds, ["entry-1"]);
  });

  it("does not call the Host again when the user cancels an explicit approval", async () => {
    let requests = 0;
    const tool = createTodoTool({
      request: async () => {
        requests += 1;
        return { text: "plan update requires user confirmation", askedConfirmation: true, confirmed: false };
      },
    } as never);
    const result = await tool.execute(
      "call-1",
      { items: [{ text: "Risky guess", status: "open" }] } as never,
      undefined,
      undefined,
      { sessionManager: { getBranch: () => [] }, ui: { select: async () => "Cancel" } } as never,
    );
    assert.equal(requests, 1);
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /cancelled/);
  });
});
