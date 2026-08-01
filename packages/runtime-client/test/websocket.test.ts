import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  WebSocketRuntimeTransport,
  type RuntimeWebSocket,
} from "../src/index.js";

class DelayedBlob extends Blob {
  readonly #delayMs: number;

  constructor(value: string, delayMs: number) {
    super([value]);
    this.#delayMs = delayMs;
  }

  override async text(): Promise<string> {
    await delay(this.#delayMs);
    return super.text();
  }
}

class MemorySocket implements RuntimeWebSocket {
  readonly readyState = 1;
  onclose: RuntimeWebSocket["onclose"] = null;
  onerror: RuntimeWebSocket["onerror"] = null;
  onmessage: RuntimeWebSocket["onmessage"] = null;
  onopen: RuntimeWebSocket["onopen"] = null;

  close(): void {}
  send(): void {}
}

test("WebSocket transport preserves asynchronous Blob frame order", async () => {
  const socket = new MemorySocket();
  const frames: string[] = [];
  const transport = new WebSocketRuntimeTransport({
    url: "ws://runtime.test",
    webSocketFactory: () => socket,
  });
  const started = transport.start({
    close: () => {},
    message: (frame) => frames.push(frame),
  });
  socket.onopen?.();
  await started;

  socket.onmessage?.({ data: new DelayedBlob("first", 20) });
  socket.onmessage?.({ data: new DelayedBlob("second", 0) });
  await delay(40);

  assert.deepEqual(frames, ["first", "second"]);
  transport.close();
});
