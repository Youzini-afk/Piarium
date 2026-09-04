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

  it("lets a workspace add dispatch prompts but not remove a user prompt", () => {
    const merged = mergeHarnessSettings(
      { dispatch: { concurrency: 12, askBefore: { edit: true } } },
      { dispatch: { concurrency: 12, askBefore: { edit: false, write: true } } },
    );
    assert.equal(merged.dispatch.askBefore.edit, true);
    assert.equal(merged.dispatch.askBefore.write, true);
  });

  it("keeps user-memory auto-accept user-owned while workspace memory remains overridable", () => {
    const merged = mergeHarnessSettings(
      { knowledge: { eventRetentionDays: 30, autoAcceptSuggestions: { workspace: true, user: false } } },
      { knowledge: { eventRetentionDays: 30, autoAcceptSuggestions: { workspace: false, user: true } } },
    );
    // A workspace must be able to turn off auto-accept that the user enabled globally.
    assert.equal(merged.knowledge.autoAcceptSuggestions.workspace, false);
    assert.equal(merged.knowledge.autoAcceptSuggestions.user, false);
  });

  it("keeps user autoAcceptSuggestions when the workspace does not set them", () => {
    const merged = mergeHarnessSettings(
      { knowledge: { eventRetentionDays: 30, autoAcceptSuggestions: { workspace: true, user: false } } },
      {},
    );
    assert.equal(merged.knowledge.autoAcceptSuggestions.workspace, true);
    assert.equal(merged.knowledge.autoAcceptSuggestions.user, false);
  });

  it("workspace tools override user tools", () => {
    const merged = mergeHarnessSettings(
      { tools: { bash: true, grep: false } },
      { tools: { grep: true } },
    );
    assert.equal(merged.tools.bash, true);
    assert.equal(merged.tools.grep, true);
  });

  it("does not let workspace settings redirect model slots", () => {
    const merged = mergeHarnessSettings(
      { models: { check: { providerId: "trusted", modelId: "user-model" } } },
      { models: { check: { providerId: "workspace", modelId: "redirected" } } },
    );
    assert.deepEqual(merged.models.check, { providerId: "trusted", modelId: "user-model" });
  });

  it("only accepts stricter workspace permission modes and ask/deny rules", () => {
    const tightened = mergeHarnessSettings(
      { permissions: { mode: "accept-edits", rules: [{ tool: "bash", decision: "allow" }] } },
      { permissions: {
        mode: "normal",
        rules: [
          { tool: "bash", decision: "allow" },
          { tool: "bash", match: { param: "command", pattern: "^deploy" }, decision: "deny" },
        ],
      } },
    );
    assert.equal(tightened.permissions?.mode, "normal");
    assert.deepEqual(tightened.permissions?.rules?.map((rule) => rule.decision), ["deny", "allow"]);

    const notLoosened = mergeHarnessSettings(
      { permissions: { mode: "normal", rules: [] } },
      { permissions: { mode: "bypass", rules: [] } },
    );
    assert.equal(notLoosened.permissions?.mode, "normal");
  });

  it("requires Smart mode to be explicitly enabled by the user", () => {
    assert.equal(mergeHarnessSettings(
      { permissions: { mode: "normal", rules: [] } },
      { permissions: { mode: "smart", rules: [] } },
    ).permissions?.mode, "normal");
    assert.equal(mergeHarnessSettings(
      { permissions: { mode: "smart", rules: [] } },
      {},
    ).permissions?.mode, "smart");
  });
});
