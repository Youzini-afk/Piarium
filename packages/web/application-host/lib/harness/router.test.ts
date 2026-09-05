import { describe, expect, it, vi } from "vitest";
import type {
  HarnessActorContext,
  HarnessActorIdentity,
  HarnessCapability,
} from "@piarium/protocol";
import { createHarnessRouter, type HarnessService } from "./router.js";

const ACTOR: HarnessActorIdentity = {
  authorityInstanceId: "authority-1",
  sessionId: "session-1",
  workerId: "worker-1",
  workerGeneration: 1,
};

const resolvedActor = (grantedCapabilities: readonly HarnessCapability[]): HarnessActorContext => ({
  ...ACTOR,
  workspaceId: "workspace-1",
  grantedCapabilities,
});

const harnessEvent = (method: string, params: unknown, data: Record<string, unknown> = {}) => ({
  actor: ACTOR,
  kind: "host",
  envelope: {
    event: "harness.request",
    kind: "event",
    data: { requestId: "req-1", method, params, ...data },
  },
});

describe("harness router", () => {
  it("dispatches with a Host-resolved actor and responds to its trusted session", async () => {
    const responses: Array<{ sessionId: string; requestId: string; ok: boolean; result?: unknown }> = [];
    const router = createHarnessRouter({
      respond: async (sessionId, requestId, outcome) => {
        responses.push({ sessionId, requestId, ok: outcome.ok, ...(outcome.ok ? { result: outcome.result } : {}) });
      },
      resolveActor: async () => resolvedActor(["read.output"]),
    });
    const echoService: HarnessService<"output.store"> = {
      handle: async (params, ctx) => {
        expect(ctx.actor).toMatchObject({ sessionId: "session-1", workspaceId: "workspace-1" });
        return { ref: { durability: "ephemeral", generation: "test", handle: "out_echo" }, total: params.text.length };
      },
    };
    router.register("output.store", echoService);
    await router.processEvent(harnessEvent("output.store", { text: "hello" }, {
      // Unknown wire fields never override the broker-owned actor.
      sessionId: "session-forged",
    }));
    expect(responses).toEqual([{
      sessionId: "session-1",
      requestId: "req-1",
      ok: true,
      result: { ref: { durability: "ephemeral", generation: "test", handle: "out_echo" }, total: 5 },
    }]);
    router.dispose();
  });

  it("responds with unavailable for a permitted but unregistered method", async () => {
    const responses: Array<{ ok: boolean; code?: string }> = [];
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => {
        responses.push({ ok: outcome.ok, ...(!outcome.ok ? { code: outcome.error.code } : {}) });
      },
      resolveActor: async () => resolvedActor(["process.shell"]),
    });
    await router.processEvent(harnessEvent("shell.exec", { command: "echo" }));
    expect(responses).toEqual([{ ok: false, code: "unavailable" }]);
    router.dispose();
  });

  it("rejects a method whose static capability was not granted", async () => {
    const responses: Array<{ ok: boolean; code?: string }> = [];
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => {
        responses.push({ ok: outcome.ok, ...(!outcome.ok ? { code: outcome.error.code } : {}) });
      },
      resolveActor: async () => resolvedActor(["read.output"]),
    });
    router.register("shell.exec", { handle: async () => ({ kind: "completed", exitCode: 0, durationMs: 0, cwd: ".", stdout: "", stderr: "", handle: null, shown: null }) });
    await router.processEvent(harnessEvent("shell.exec", { command: "echo" }));
    expect(responses).toEqual([{ ok: false, code: "forbidden" }]);
    router.dispose();
  });

  it("rejects an out-of-workspace path before dispatch", async () => {
    const handle = vi.fn(async () => ({ held: true as const, leaseIds: ["lease-1"] }));
    const responses: Array<{ ok: boolean; code?: string }> = [];
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => {
        responses.push({ ok: outcome.ok, ...(!outcome.ok ? { code: outcome.error.code } : {}) });
      },
      resolveActor: async () => resolvedActor(["write.document"]),
      authorizeWorkspacePath: async () => null,
    });
    router.register("fs.lock", { handle });
    await router.processEvent(harnessEvent("fs.lock", { action: "acquire", paths: ["../outside.txt"] }));
    expect(handle).not.toHaveBeenCalled();
    expect(responses).toEqual([{ ok: false, code: "forbidden" }]);
    router.dispose();
  });

  it("validates every child scope path before creating a thread", async () => {
    const handle = vi.fn(async () => ({ text: "created", threadId: "thread-1", queued: false }));
    const responses: Array<{ ok: boolean; code?: string }> = [];
    const authorize = vi.fn(async (_actor: HarnessActorContext, candidate: string) => (
      candidate === "src/new-file.ts"
        ? { authorityId: "host-1", workspaceId: "workspace-1", canonicalResourceId: candidate, inputPath: candidate, resourceId: candidate }
        : null
    ));
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => {
        responses.push({ ok: outcome.ok, ...(!outcome.ok ? { code: outcome.error.code } : {}) });
      },
      resolveActor: async () => resolvedActor(["control.thread"]),
      authorizeWorkspacePath: authorize,
    });
    router.register("thread.dispatch", { handle });
    await router.processEvent(harnessEvent("thread.dispatch", {
      role: "check",
      task: "inspect",
      scope: ["src/new-file.ts", "../outside"],
    }));
    expect(authorize).toHaveBeenCalledWith(expect.anything(), "src/new-file.ts", { allowMissing: true });
    expect(handle).not.toHaveBeenCalled();
    expect(responses).toEqual([{ ok: false, code: "forbidden" }]);
    router.dispose();
  });

  it("applies workspace path authorization to LSP navigation", async () => {
    const handle = vi.fn(async () => ({ status: "empty" as const, text: "No definition found" }));
    const responses: Array<{ ok: boolean; code?: string }> = [];
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => {
        responses.push({ ok: outcome.ok, ...(!outcome.ok ? { code: outcome.error.code } : {}) });
      },
      resolveActor: async () => resolvedActor(["read.lsp"]),
      authorizeWorkspacePath: async () => null,
    });
    router.register("lsp.definition", { handle });
    await router.processEvent(harnessEvent("lsp.definition", { path: "../other/a.ts", line: 1 }));
    expect(handle).not.toHaveBeenCalled();
    expect(responses).toEqual([{ ok: false, code: "forbidden" }]);
    router.dispose();
  });

  it("rejects non-one-based LSP positions before calling the service", async () => {
    const handle = vi.fn(async () => ({ status: "empty" as const, text: "No hover information" }));
    const responses: Array<{ ok: boolean; code?: string }> = [];
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => {
        responses.push({ ok: outcome.ok, ...(!outcome.ok ? { code: outcome.error.code } : {}) });
      },
      resolveActor: async () => resolvedActor(["read.lsp"]),
    });
    router.register("lsp.hover", { handle });
    await router.processEvent(harnessEvent("lsp.hover", { path: "src/a.ts", line: 0 }));
    expect(handle).not.toHaveBeenCalled();
    expect(responses).toEqual([{ ok: false, code: "invalid-params" }]);
    router.dispose();
  });

  it("rejects a non-boolean diagnostics full selector before calling the service", async () => {
    const handle = vi.fn(async () => ({ status: "ready" as const, diagnostics: [] }));
    const responses: Array<{ ok: boolean; code?: string }> = [];
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => {
        responses.push({ ok: outcome.ok, ...(!outcome.ok ? { code: outcome.error.code } : {}) });
      },
      resolveActor: async () => resolvedActor(["read.lsp"]),
      authorizeWorkspacePath: async (_actor, path) => ({ authorityId: "host", workspaceId: "workspace-1", canonicalResourceId: path, inputPath: path, resourceId: path }),
    });
    router.register("lsp.diagnosticsSnapshot", { handle });
    await router.processEvent(harnessEvent("lsp.diagnosticsSnapshot", { path: "src/a.ts", full: "yes" }));
    expect(handle).not.toHaveBeenCalled();
    expect(responses).toEqual([{ ok: false, code: "invalid-params" }]);
    router.dispose();
  });

  it("responds with failed when a service throws", async () => {
    const responses: Array<{ ok: boolean; code?: string; message?: string }> = [];
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => {
        responses.push(outcome.ok
          ? { ok: true }
          : { ok: false, code: outcome.error.code, message: outcome.error.message });
      },
      resolveActor: async () => resolvedActor(["process.shell"]),
    });
    router.register("shell.exec", { handle: async () => { throw new Error("boom"); } });
    await router.processEvent(harnessEvent("shell.exec", { command: "echo" }));
    expect(responses).toEqual([{ ok: false, code: "failed", message: "boom" }]);
    router.dispose();
  });

  it("commits deferred observation state only after the success response is delivered", async () => {
    const commit = vi.fn();
    const abort = vi.fn();
    const router = createHarnessRouter({
      respond: async () => undefined,
      resolveActor: async () => resolvedActor(["read.output"]),
    });
    router.register("output.store", {
      handle: async (_params, ctx) => {
        ctx.deferResponseDelivery?.(commit, abort);
        return { ref: { durability: "ephemeral", generation: "g", handle: "out_1" }, total: 1 };
      },
    });
    await router.processEvent(harnessEvent("output.store", { text: "x" }));
    expect(commit).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    router.dispose();
  });

  it("aborts deferred observation state when the success response cannot be delivered", async () => {
    const commit = vi.fn();
    const abort = vi.fn();
    let responses = 0;
    const router = createHarnessRouter({
      respond: async () => {
        responses += 1;
        if (responses === 1) throw new Error("delivery failed");
      },
      resolveActor: async () => resolvedActor(["read.output"]),
    });
    router.register("output.store", {
      handle: async (_params, ctx) => {
        ctx.deferResponseDelivery?.(commit, abort);
        return { ref: { durability: "ephemeral", generation: "g", handle: "out_1" }, total: 1 };
      },
    });
    await router.processEvent(harnessEvent("output.store", { text: "x" }));
    expect(abort).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    router.dispose();
  });

  it("responds with unavailable for unknown method names", async () => {
    const responses: Array<{ ok: boolean; code?: string }> = [];
    const router = createHarnessRouter({
      respond: async (_sessionId, _requestId, outcome) => {
        responses.push({ ok: outcome.ok, ...(!outcome.ok ? { code: outcome.error.code } : {}) });
      },
      resolveActor: async () => resolvedActor([]),
    });
    await router.processEvent(harnessEvent("nonexistent.method", {}));
    expect(responses).toEqual([{ ok: false, code: "unavailable" }]);
    router.dispose();
  });

  it("ignores non-harness events and harness events without a broker actor", async () => {
    const respond = vi.fn(async () => undefined);
    const router = createHarnessRouter({
      respond,
      resolveActor: async () => null,
    });
    await router.processEvent({
      actor: ACTOR,
      kind: "host",
      envelope: { event: "agent.event", kind: "event", data: {} },
    });
    await router.processEvent({
      kind: "host",
      envelope: { event: "harness.request", kind: "event", data: { requestId: "req-2", method: "output.read", params: {} } },
    });
    expect(respond).not.toHaveBeenCalled();
    router.dispose();
  });
});
