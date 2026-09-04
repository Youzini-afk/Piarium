import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PiariumHarnessFleetAdapter } from "../../src/fleet/piarium-harness-adapter.js";

describe("Piarium harness Fleet adapter", () => {
  it("projects Host-owned threads and routes transcript/kill actions", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const bridge = {
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "thread.list") {
          return {
            text: "one thread",
            threads: [{
              id: "thread-1",
              lifecycle: "active",
              attention: "none",
              integration: "dirty",
              brief: "Run checks",
              createdAt: "2026-09-04T00:00:00.000Z",
              role: "check",
              updatedAt: "2026-09-04T00:00:01.000Z",
              activeRun: {
                id: "run-1",
                threadId: "thread-1",
                attempt: 1,
                runtimeId: "pi",
                sessionId: "child-1",
                workerState: "running",
                outcome: null,
                exitReason: null,
                tokens: { input: 10, output: 2, cacheRead: 4 },
                costUsd: null,
                steps: 1,
                lastToolCall: null,
                startedAt: "2026-09-04T00:00:00.000Z",
                lastActivityAt: "2026-09-04T00:00:01.000Z",
                endedAt: null,
              },
              waitingFor: null,
              diffStats: null,
            }],
          };
        }
        if (method === "thread.read") return { text: "durable transcript", report: null, transcriptRef: null };
        if (method === "thread.kill") return { text: "killed thread-1" };
        throw new Error(`Unexpected method ${method}`);
      },
    };
    const adapter = new PiariumHarnessFleetAdapter(bridge as never);
    adapter.startSession("parent-1");

    const status = await adapter.status("parent-1");
    assert.equal(status.provider.state, "active");
    assert.equal(status.entries[0]?.key, "thread-1");
    assert.equal(status.entries[0]?.kind, "delegated-agent");
    assert.equal(status.entries[0]?.providerId, "piarium-harness");
    assert.equal(status.entries[0]?.state, "running");
    assert.deepEqual(status.entries[0]?.tokens, { input: 10, output: 2, total: 12 });
    const logs = await adapter.action({ action: "logs", entryKey: "thread-1", sessionId: "parent-1" });
    assert.equal(logs.logs?.text, "durable transcript");
    await adapter.action({ action: "kill", entryKey: "thread-1", sessionId: "parent-1" });
    assert.deepEqual(requests.map((entry) => entry.method), ["thread.list", "thread.read", "thread.kill"]);
  });
});
