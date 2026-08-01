import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HostEvent, HostEventData } from "@piarium/protocol";
import { ProviderAuthBridge } from "../src/provider-auth-bridge.js";

function createHarness() {
  const events: Array<{ data: unknown; event: string }> = [];
  const bridge = new ProviderAuthBridge(
    <E extends HostEvent>(event: E, data: HostEventData<E>) => events.push({ data, event }),
  );
  return { bridge, events };
}

describe("ProviderAuthBridge", () => {
  it("round-trips typed secret prompts without exposing AbortSignal", async () => {
    const { bridge, events } = createHarness();
    const result = bridge.prompt("anthropic", "session-1", {
      message: "API key",
      placeholder: "sk-ant-...",
      type: "secret",
    });
    const request = events.find((event) => event.event === "provider.auth.prompt");
    assert.ok(request);
    const payload = request.data as {
      prompt: { requestId: string; type: string };
      providerId: string;
      sessionId: string;
    };
    assert.equal(payload.prompt.type, "secret");
    assert.equal(payload.providerId, "anthropic");
    assert.equal(payload.sessionId, "session-1");
    assert.equal(JSON.stringify(payload).includes("signal"), false);

    assert.equal(
      bridge.respond({ requestId: payload.prompt.requestId, value: "test-key" }),
      true,
    );
    assert.equal(await result, "test-key");
    assert.equal(
      bridge.respond({ requestId: payload.prompt.requestId, value: "late-key" }),
      false,
    );
  });

  it("dismisses and rejects an aborted provider prompt", async () => {
    const { bridge, events } = createHarness();
    const controller = new AbortController();
    const result = bridge.prompt("openrouter", "session-2", {
      message: "Paste callback code",
      signal: controller.signal,
      type: "manual_code",
    });
    controller.abort();

    await assert.rejects(result, (error: unknown) => {
      assert.equal((error as { code?: string }).code, "auth_cancelled");
      return true;
    });
    assert.ok(events.some((event) => event.event === "provider.auth.dismiss"));
  });
});
