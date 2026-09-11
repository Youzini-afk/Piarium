import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergePolicies, normalizeFrozenHarnessPermissions } from "../src/permission-gate.js";

describe("normalizeFrozenHarnessPermissions", () => {
  it("freezes missing or empty overlays to default normal, not live settings", () => {
    assert.deepEqual(normalizeFrozenHarnessPermissions(undefined), { mode: "normal", rules: [] });
    assert.deepEqual(normalizeFrozenHarnessPermissions({}), { mode: "normal", rules: [] });
    assert.deepEqual(normalizeFrozenHarnessPermissions(null), { mode: "normal", rules: [] });
  });

  it("keeps an explicit mode and lets live settings only tighten it", () => {
    const frozen = normalizeFrozenHarnessPermissions({ mode: "accept-edits" });
    assert.deepEqual(frozen, { mode: "accept-edits", rules: [] });
    assert.equal(mergePolicies(frozen, { mode: "bypass" }).mode, "accept-edits");
    assert.equal(mergePolicies(frozen, { mode: "normal" }).mode, "normal");
  });
});
