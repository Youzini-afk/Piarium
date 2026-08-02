import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toJsonValue } from "../src/json.js";

describe("toJsonValue", () => {
  it("preserves deeply nested JSON by default", () => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let depth = 0; depth < 64; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    cursor.value = "complete";

    let projected = toJsonValue(root);
    for (let depth = 0; depth < 64; depth += 1) {
      if (typeof projected !== "object" || projected === null || Array.isArray(projected)) {
        assert.fail(`Expected an object at depth ${depth}`);
      }
      const next = projected.next;
      if (next === undefined) assert.fail(`Missing nested value at depth ${depth}`);
      projected = next;
    }
    assert.deepEqual(projected, { value: "complete" });
  });

  it("retains an explicit depth budget for deployments that request one", () => {
    assert.deepEqual(toJsonValue({ nested: { value: true } }, 1), {
      nested: "[MaxDepth]",
    });
  });
});
