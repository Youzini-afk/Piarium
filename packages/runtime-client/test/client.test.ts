import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRuntimeErrorResponse,
  createRuntimeEvent,
  createRuntimeSuccessResponse,
  decodeRuntimeEnvelope,
  encodeRuntimeEnvelope,
} from "@piarium/protocol";
import { PiRuntimeClient, PiRuntimeRequestError } from "../src/index.js";
import type { RuntimeTransport, RuntimeTransportHandlers } from "../src/index.js";

class MemoryTransport implements RuntimeTransport {
  handlers: RuntimeTransportHandlers | undefined;
  sent: string[] = [];

  start(handlers: RuntimeTransportHandlers): void {
    this.handlers = handlers;
  }

  send(frame: string): void {
    this.sent.push(frame);
  }

  close(): void {}

  receive(frame: string): void {
    this.handlers?.message(frame);
  }

  disconnect(error?: Error): void {
    this.handlers?.close(error);
  }
}

describe("PiRuntimeClient", () => {
  it("correlates responses without depending on response order", async () => {
    const transport = new MemoryTransport();
    let nextId = 0;
    const client = new PiRuntimeClient({
      createId: () => `request-${++nextId}`,
      transport,
    });
    await client.connect();

    const first = client.request("session.list", { cwd: "C:/one" });
    const second = client.request("session.list", { cwd: "C:/two" });
    assert.equal(transport.sent.length, 2);
    transport.receive(
      encodeRuntimeEnvelope(createRuntimeSuccessResponse<"session.list">("request-2", [])),
    );
    transport.receive(
      encodeRuntimeEnvelope(createRuntimeSuccessResponse<"session.list">("request-1", [])),
    );

    assert.deepEqual(await second, []);
    assert.deepEqual(await first, []);
    assert.equal(decodeRuntimeEnvelope(transport.sent[0] ?? "").kind, "request");
    await client.close();
  });

  it("surfaces typed request failures", async () => {
    const transport = new MemoryTransport();
    const client = new PiRuntimeClient({ createId: () => "failed", transport });
    await client.connect();
    const request = client.request("session.list", {});
    transport.receive(
      encodeRuntimeEnvelope(
        createRuntimeErrorResponse("failed", {
          code: "denied",
          message: "Request denied",
          retryable: false,
        }),
      ),
    );

    await assert.rejects(request, (error: unknown) => {
      assert.ok(error instanceof PiRuntimeRequestError);
      assert.equal(error.code, "denied");
      return true;
    });
    await client.close();
  });

  it("tracks event sequences independently for every worker", async () => {
    const transport = new MemoryTransport();
    const gaps: Array<{ expected: number; received: number }> = [];
    const events: number[] = [];
    const client = new PiRuntimeClient({
      onSequenceGap: ({ expected, received }) => gaps.push({ expected, received }),
      transport,
    });
    client.subscribe((event) => events.push(event.seq));
    await client.connect();

    const sourceA = { role: "session" as const, sessionId: "a", workerId: "worker-a" };
    const sourceB = { role: "catalog" as const, workerId: "worker-b" };
    transport.receive(
      encodeRuntimeEnvelope(createRuntimeEvent(sourceA, 5, "session.closed", { sessionId: "a" })),
    );
    transport.receive(
      encodeRuntimeEnvelope(createRuntimeEvent(sourceB, 9, "session.closed", { sessionId: "b" })),
    );
    transport.receive(
      encodeRuntimeEnvelope(createRuntimeEvent(sourceA, 7, "session.closed", { sessionId: "a" })),
    );

    assert.deepEqual(events, [5, 9, 7]);
    assert.deepEqual(gaps, [{ expected: 6, received: 7 }]);
    await client.close();
  });

  it("rejects pending requests when the transport disconnects", async () => {
    const transport = new MemoryTransport();
    const client = new PiRuntimeClient({ createId: () => "pending", transport });
    await client.connect();
    const request = client.request("session.list", {});
    transport.disconnect(new Error("offline"));

    await assert.rejects(request, /offline/);
  });

  it("supports interactive requests without a client-side timeout", async () => {
    const transport = new MemoryTransport();
    const client = new PiRuntimeClient({ createId: () => "interactive", transport });
    await client.connect();
    const request = client.request("provider.login", {
      cwd: "C:/workspace",
      providerId: "example",
      type: "oauth",
    }, null);
    transport.receive(
      encodeRuntimeEnvelope(
        createRuntimeSuccessResponse<"provider.login">("interactive", { authenticated: true }),
      ),
    );

    assert.deepEqual(await request, { authenticated: true });
    await client.close();
  });
});
