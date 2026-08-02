import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type EventEnvelope,
  type HostEvent,
  type HostEventData,
  PIARIUM_PROTOCOL_VERSION,
} from "@piarium/protocol";
import { ExtensionUiBridge } from "../src/extension-ui-bridge.js";

function createHarness() {
  const events: EventEnvelope[] = [];
  let sequence = 0;
  const bridge = new ExtensionUiBridge(
    <E extends HostEvent>(event: E, data: HostEventData<E>) => {
      events.push({
        data,
        event,
        kind: "event",
        seq: sequence++,
        v: PIARIUM_PROTOCOL_VERSION,
      } as EventEnvelope);
    },
    () => "session-1",
  );
  return { bridge, events };
}

describe("ExtensionUiBridge", () => {
  it("round-trips interactive confirmation requests", async () => {
    const { bridge, events } = createHarness();
    const result = bridge.createContext().confirm("Proceed?", "Apply changes");
    const request = events.find(
      (event) => event.event === "extension.ui.request" && event.data.method === "confirm",
    );
    assert.ok(request && request.event === "extension.ui.request");
    assert.ok(request.data.id);

    assert.equal(bridge.respond({ requestId: request.data.id, value: true }), true);
    assert.equal(await result, true);
    assert.equal(bridge.respond({ requestId: request.data.id, value: false }), false);
  });

  it("dismisses timed out requests", async () => {
    const { bridge, events } = createHarness();
    const result = bridge.createContext().input("Value", "placeholder", { timeout: 5 });

    assert.equal(await result, undefined);
    assert.ok(events.some((event) => event.event === "extension.ui.dismiss"));
  });

  it("tracks editor text and emits fire-and-forget UI state", () => {
    const { bridge, events } = createHarness();
    const context = bridge.createContext();

    context.setEditorText("restored prompt");
    context.notify("done", "info");

    assert.equal(context.getEditorText(), "restored prompt");
    assert.deepEqual(
      events
        .filter((event) => event.event === "extension.ui.request")
        .map((event) => (event.event === "extension.ui.request" ? event.data.method : "")),
      ["setEditorText", "notify"],
    );
  });

  it("renders custom Pi components into a surface-owned read-only panel", async () => {
    const { bridge, events } = createHarness();
    let disposed = false;
    const result = bridge.createContext().custom(() => ({
      dispose: () => {
        disposed = true;
      },
      handleInput: () => {},
      invalidate: () => {},
      render: (width) => [`width ${width}`, "\u001b[31mstatus\u001b[0m"],
    }), {
      overlay: true,
      overlayOptions: { width: 78 },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const request = events.find(
      (event) => event.event === "extension.ui.request" && event.data.method === "custom",
    );
    assert.ok(request && request.event === "extension.ui.request");
    assert.ok(request.data.id);
    assert.deepEqual(request.data.payload, {
      lines: ["width 78", "status"],
      title: "Extension panel",
    });

    assert.equal(bridge.respond({ requestId: request.data.id }), true);
    assert.equal(await result, undefined);
    assert.equal(disposed, true);
  });
});
