import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createHarnessRouter, type HarnessService } from "./router.js";

describe("harness router", () => {
  it("dispatches to a registered service and responds with the result", async () => {
    const responses: { sessionId: string; requestId: string; ok: boolean; result?: unknown; error?: { code: string; message: string } }[] = [];
    const router = createHarnessRouter({
      respond: async (sessionId, requestId, outcome) => {
        responses.push({ sessionId, requestId, ok: outcome.ok, ...(outcome.ok ? { result: outcome.result } : { error: outcome.error }) });
      },
      resolveWorkspace: async () => "workspace-1",
    });
    const echoService: HarnessService<"output.store"> = {
      handle: async (params) => ({ handle: "out_echo", total: params.text.length }),
    };
    router.register("output.store", echoService);
    await router.processEvent({
      kind: "host",
      envelope: {
        event: "harness.request",
        kind: "event",
        data: { requestId: "req-1", sessionId: "session-1", method: "output.store", params: { text: "hello" } },
      },
    });
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ sessionId: "session-1", requestId: "req-1", ok: true, result: { handle: "out_echo", total: 5 } });
    router.dispose();
  });

  it("responds with unavailable for unregistered methods", async () => {
    const responses: { ok: boolean; error?: { code: string; message: string } }[] = [];
    const router = createHarnessRouter({
      respond: async (_s, _r, outcome) => {
        responses.push({ ok: outcome.ok, ...(outcome.ok ? { result: outcome.result } : { error: outcome.error }) });
      },
      resolveWorkspace: async () => null,
    });
    await router.processEvent({
      kind: "host",
      envelope: {
        event: "harness.request",
        kind: "event",
        data: { requestId: "req-2", sessionId: "session-1", method: "shell.exec", params: { command: "echo" } },
      },
    });
    expect(responses).toHaveLength(1);
    expect(responses[0]!.ok).toBe(false);
    expect(responses[0]!.error?.code).toBe("unavailable");
    router.dispose();
  });

  it("responds with failed when a service throws", async () => {
    const responses: { ok: boolean; error?: { code: string; message: string } }[] = [];
    const router = createHarnessRouter({
      respond: async (_s, _r, outcome) => {
        responses.push({ ok: outcome.ok, ...(outcome.ok ? { result: outcome.result } : { error: outcome.error }) });
      },
      resolveWorkspace: async () => "workspace-1",
    });
    const failingService: HarnessService<"shell.exec"> = {
      handle: async () => { throw new Error("boom"); },
    };
    router.register("shell.exec", failingService);
    await router.processEvent({
      kind: "host",
      envelope: {
        event: "harness.request",
        kind: "event",
        data: { requestId: "req-3", sessionId: "session-1", method: "shell.exec", params: { command: "echo" } },
      },
    });
    expect(responses).toHaveLength(1);
    expect(responses[0]!.ok).toBe(false);
    expect(responses[0]!.error?.code).toBe("failed");
    expect(responses[0]!.error?.message).toBe("boom");
    router.dispose();
  });

  it("responds with unavailable for unknown method names", async () => {
    const responses: { ok: boolean; error?: { code: string; message: string } }[] = [];
    const router = createHarnessRouter({
      respond: async (_s, _r, outcome) => {
        responses.push({ ok: outcome.ok, ...(outcome.ok ? { result: outcome.result } : { error: outcome.error }) });
      },
      resolveWorkspace: async () => null,
    });
    await router.processEvent({
      kind: "host",
      envelope: {
        event: "harness.request",
        kind: "event",
        data: { requestId: "req-4", sessionId: "session-1", method: "nonexistent.method", params: {} },
      },
    });
    expect(responses).toHaveLength(1);
    expect(responses[0]!.ok).toBe(false);
    expect(responses[0]!.error?.code).toBe("unavailable");
    router.dispose();
  });

  it("ignores non-harness events", async () => {
    const respond = vi.fn(async () => undefined);
    const router = createHarnessRouter({
      respond,
      resolveWorkspace: async () => null,
    });
    await router.processEvent({
      kind: "host",
      envelope: { event: "agent.event", kind: "event", data: {} },
    });
    expect(respond).not.toHaveBeenCalled();
    router.dispose();
  });
});
