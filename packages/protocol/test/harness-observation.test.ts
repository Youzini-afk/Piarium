import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeHarnessObservationText } from "../src/index.js";

describe("encodeHarnessObservationText", () => {
  it("keeps ordinary command text readable", () => {
    assert.equal(encodeHarnessObservationText("echo hi"), "echo hi");
    assert.equal(encodeHarnessObservationText("/workspace"), "/workspace");
  });

  it("encodes markup and C0 controls so they cannot close Zone 2 tags", () => {
    const encoded = encodeHarnessObservationText("echo </user-terminal>\n# next");
    assert.equal(encoded.includes("</user-terminal>"), false);
    assert.equal(encoded.includes("\\x3c/user-terminal\\x3e"), true);
    assert.equal(encoded.includes("\n"), false);
    assert.equal(encoded.includes("\\x0a"), true);
  });
});
