import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXECUTION_PRESETS } from "../src/harness-presets.js";
import { RESEARCH_CAPABILITY_DEFINITIONS } from "../src/research-capabilities.js";

describe("child thread work context", () => {
  it("keeps the context switch tool in every fixed child tool set", () => {
    for (const definition of [
      ...Object.values(EXECUTION_PRESETS),
      ...Object.values(RESEARCH_CAPABILITY_DEFINITIONS),
    ]) {
      const name = "id" in definition ? definition.id : definition.capability;
      assert.ok(definition.tools.includes("work_context"), `${name} cannot adjust its inherited work context`);
    }
  });
});
