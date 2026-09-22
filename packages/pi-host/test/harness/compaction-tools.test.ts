import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createCompactionQueryTools } from "../../src/harness/compaction-tools.js";

test("compaction records use a non-consuming thread list and expose fixed result reads", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const bridge = {
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "thread.list") {
        return { threads: [{ id: "thread-1" }], text: "one thread" };
      }
      return {
        report: { conclusion: "done" },
        text: "report text",
        transcriptRef: null,
      };
    },
  } as unknown as HostServicesBridge;
  const tools = createCompactionQueryTools(bridge);
  const records = tools.find((tool) => tool.name === "records");
  assert.ok(records);

  const list = await records.execute("list", { kind: "threads" }, undefined);
  assert.deepEqual(calls[0], { method: "thread.list", params: { full: true } });
  const listText = list.content[0]?.type === "text" ? list.content[0].text : "";
  assert.match(listText, /"source": "live"/);

  const read = await records.execute("read", {
    kind: "threads",
    id: "thread-1",
    resultRevision: 4,
    runId: "run-2",
    what: "report",
  }, undefined);
  assert.deepEqual(calls[1], {
    method: "thread.read",
    params: {
      resultRevision: 4,
      runId: "run-2",
      threadId: "thread-1",
      what: "report",
    },
  });
  const readText = read.content[0]?.type === "text" ? read.content[0].text : "";
  assert.match(readText, /"source": "live"/);
});
