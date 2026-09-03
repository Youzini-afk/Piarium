import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_HARNESS_SETTINGS,
  mergeHarnessSettings,
  type HarnessSettings,
} from "../src/index.js";

describe("harness settings", () => {
  it("returns defaults when both user and workspace are empty", () => {
    const merged = mergeHarnessSettings({}, {});
    assert.deepEqual(merged, DEFAULT_HARNESS_SETTINGS);
  });

  it("workspace overrides user for top-level keys", () => {
    const merged = mergeHarnessSettings(
      { shell: "powershell" },
      { shell: "wsl" },
    );
    assert.equal(merged.shell, "wsl");
  });

  it("deep-merges nested objects (depth 1)", () => {
    const merged = mergeHarnessSettings(
      { output: { visibleBytes: 16384 } },
      { bash: { waitMs: 120000 } },
    );
    assert.equal(merged.output.visibleBytes, 16384);
    assert.equal(merged.bash.waitMs, 120000);
    // Non-overridden defaults preserved
    assert.equal(merged.dispatch.concurrency, 12);
  });

  it("deep-merges dispatch.askBefore", () => {
    const merged = mergeHarnessSettings(
      { dispatch: { concurrency: 12, askBefore: { edit: true } } },
      { dispatch: { concurrency: 12, askBefore: { write: true } } },
    );
    assert.equal(merged.dispatch.askBefore.edit, true);
    assert.equal(merged.dispatch.askBefore.write, true);
  });

  it("deep-merges knowledge.autoAcceptSuggestions", () => {
    const merged = mergeHarnessSettings(
      { knowledge: { eventRetentionDays: 30, autoAcceptSuggestions: { workspace: true, user: false } } },
      { knowledge: { eventRetentionDays: 30, autoAcceptSuggestions: { workspace: false, user: true } } },
    );
    assert.equal(merged.knowledge.autoAcceptSuggestions.workspace, true);
    assert.equal(merged.knowledge.autoAcceptSuggestions.user, true);
  });

  it("workspace tools override user tools", () => {
    const merged = mergeHarnessSettings(
      { tools: { bash: true, grep: false } },
      { tools: { grep: true } },
    );
    assert.equal(merged.tools.bash, true);
    assert.equal(merged.tools.grep, true);
  });
});
