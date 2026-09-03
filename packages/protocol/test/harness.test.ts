import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HOST_EVENTS,
  isHarnessMethod,
  isHostEvent,
  type HarnessMethod,
} from "../src/index.js";

describe("harness protocol", () => {
  it("includes harness.request in HOST_EVENTS", () => {
    assert.ok(HOST_EVENTS.includes("harness.request" as never));
    assert.ok(isHostEvent("harness.request"));
  });

  it("isHarnessMethod recognizes all defined methods", () => {
    const expected: HarnessMethod[] = [
      "shell.exec", "shell.read", "shell.write", "shell.kill",
      "output.store", "output.read",
      "search.content",
      "lsp.diagnostics", "lsp.diagnosticsSnapshot",
      "fs.lock",
      "web.fetch", "web.read", "web.search",
    ];
    for (const method of expected) {
      assert.ok(isHarnessMethod(method), `${method} should be a harness method`);
    }
  });

  it("isHarnessMethod rejects unknown methods", () => {
    assert.ok(!isHarnessMethod("unknown.method"));
    assert.ok(!isHarnessMethod(""));
    assert.ok(!isHarnessMethod(123 as unknown as string));
    assert.ok(!isHarnessMethod(null as unknown as string));
  });
});
