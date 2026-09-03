import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HARNESS_TOOL_META,
  toolExecutionMode,
  toolMutation,
  type HarnessToolMutation,
} from "../src/index.js";

describe("harness tool mutation attributes", () => {
  it("classifies every known tool into none, journaled, or process", () => {
    const allowed: HarnessToolMutation[] = ["none", "journaled", "process"];
    for (const [name, meta] of Object.entries(HARNESS_TOOL_META)) {
      assert.ok(allowed.includes(meta.mutation), `${name} has invalid mutation ${meta.mutation}`);
      assert.ok(
        meta.executionMode === "parallel" || meta.executionMode === "sequential",
        `${name} has invalid executionMode ${meta.executionMode}`,
      );
      assert.equal(toolMutation(name), meta.mutation);
      assert.equal(toolExecutionMode(name), meta.executionMode);
    }
  });

  it("reports unknown for tools not in the table", () => {
    assert.equal(toolMutation("nonexistent_tool"), "unknown");
    assert.equal(toolExecutionMode("nonexistent_tool"), "unknown");
  });

  it("marks read-only tools as none and parallel", () => {
    for (const name of ["read", "grep", "find", "ls", "webfetch", "websearch"]) {
      assert.equal(toolMutation(name), "none");
      assert.equal(toolExecutionMode(name), "parallel");
    }
  });

  it("marks file-writing tools as journaled", () => {
    for (const name of ["write", "edit", "apply_patch"]) {
      assert.equal(toolMutation(name), "journaled");
    }
  });

  it("marks shell tools as process and sequential", () => {
    for (const name of ["bash", "write_to_process"]) {
      assert.equal(toolMutation(name), "process");
      assert.equal(toolExecutionMode(name), "sequential");
    }
  });

  it("keeps bash-family control tools none but sequential", () => {
    for (const name of ["kill_shell", "get_output"]) {
      assert.equal(toolMutation(name), "none");
    }
    assert.equal(toolExecutionMode("kill_shell"), "sequential");
    assert.equal(toolExecutionMode("get_output"), "parallel");
  });
});
