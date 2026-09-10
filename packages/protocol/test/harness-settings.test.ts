import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_HARNESS_SETTINGS,
  mergeHarnessSettings,
  resolveHarnessMemoryMode,
  resolveHarnessReviewSettings,
  HarnessSettingsValidationError,
  HarnessInferenceSettingsValidationError,
  parseHarnessEmbeddingSettings,
  parseHarnessRerankSettings,
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

  it("keeps embedding and rerank bindings user-owned and ignores chat model slots", () => {
    const merged = mergeHarnessSettings({
      models: { explore: { providerId: "openai", modelId: "gpt-4o" } },
      embedding: { protocol: "openai-compatible", providerId: "openai", modelId: "text-embedding-3-small", dimensions: 1024 },
      rerank: { protocol: "http-rerank", providerId: "cohere", modelId: "rerank-v3.5" },
    }, {
      embedding: { protocol: "openai-compatible", providerId: "workspace", modelId: "redirected" },
      rerank: { protocol: "http-rerank", providerId: "workspace", modelId: "redirected" },
    });
    assert.deepEqual(merged.embedding, {
      protocol: "openai-compatible",
      providerId: "openai",
      modelId: "text-embedding-3-small",
      dimensions: 1024,
    });
    assert.deepEqual(merged.rerank, {
      protocol: "http-rerank",
      providerId: "cohere",
      modelId: "rerank-v3.5",
    });
    assert.equal(merged.models.explore?.modelId, "gpt-4o");
    assert.equal(mergeHarnessSettings({
      models: { explore: { providerId: "openai", modelId: "gpt-4o" } },
    }, {}).embedding, undefined);
    assert.equal(mergeHarnessSettings({}, {
      embedding: { protocol: "openai-compatible", providerId: "workspace", modelId: "redirected" },
      rerank: { protocol: "http-rerank", providerId: "workspace", modelId: "redirected" },
    }).embedding, undefined);
    assert.equal(mergeHarnessSettings({}, {
      embedding: { protocol: "openai-compatible", providerId: "workspace", modelId: "redirected" },
      rerank: { protocol: "http-rerank", providerId: "workspace", modelId: "redirected" },
    }).rerank, undefined);
  });

  it("distinguishes missing inference settings from malformed bindings", () => {
    assert.equal(parseHarnessEmbeddingSettings(undefined), undefined);
    assert.equal(parseHarnessRerankSettings(undefined), undefined);
    for (const value of [null, false, {}, { protocol: "other", providerId: "p", modelId: "m" }]) {
      assert.throws(() => parseHarnessEmbeddingSettings(value), HarnessInferenceSettingsValidationError);
    }
    assert.throws(() => parseHarnessEmbeddingSettings({
      protocol: "openai-compatible", providerId: "p", modelId: "m", dimensions: 0,
    }), /dimensions/);
    assert.throws(() => parseHarnessEmbeddingSettings({
      protocol: "openai-compatible", providerId: "p", modelId: "m", maxTokens: 1.5,
    }), /maxTokens/);
    assert.throws(() => parseHarnessRerankSettings({
      protocol: "http-rerank", providerId: "p", modelId: "m", endpoint: "https://project.invalid",
    }), /provider-relative/);
    assert.throws(() => parseHarnessRerankSettings({
      protocol: "http-rerank", providerId: "p", modelId: "m", maxDocumentTokens: -1,
    }), /maxDocumentTokens/);
    assert.equal(mergeHarnessSettings({
      embedding: { protocol: "openai-compatible", providerId: "p", modelId: "m", dimensions: 0 },
    } as never, {}).embedding, undefined, "a malformed optional binding must not prevent ordinary session settings from resolving");
  });

  it("does not let workspace settings redirect model slots", () => {
    const merged = mergeHarnessSettings(
      { models: { check: { providerId: "trusted", modelId: "user-model" } } },
      { models: { check: { providerId: "workspace", modelId: "redirected" } } },
    );
    assert.deepEqual(merged.models.check, { providerId: "trusted", modelId: "user-model" });
  });

  it("defaults memory takeover and migrates the legacy shadow boolean", () => {
    assert.equal(mergeHarnessSettings({}, {}).memory.mode, "takeover");
    assert.equal(resolveHarnessMemoryMode({ shadowMode: false }), "off");
    assert.equal(resolveHarnessMemoryMode({ shadowMode: true }), "assist");
    assert.equal(resolveHarnessMemoryMode({ mode: "takeover", shadowMode: false }), "takeover");
  });

  it("keeps automatic review user-owned and defaults to enabled non-blocking", () => {
    assert.deepEqual(mergeHarnessSettings({}, {}).review, { enabled: true, gate: false });
    assert.deepEqual(mergeHarnessSettings(
      { review: { enabled: false, gate: true } },
      { review: { enabled: true, gate: false } },
    ).review, { enabled: false, gate: true });
    assert.deepEqual(mergeHarnessSettings(
      { review: { enabled: false } },
      {},
    ).review, { enabled: false, gate: false });
  });

  it("rejects malformed review settings", () => {
    assert.throws(() => resolveHarnessReviewSettings({ enabled: "yes" }), HarnessSettingsValidationError);
    assert.throws(() => resolveHarnessReviewSettings(false), /must be an object/);
  });

  it("does not let a workspace change the user-owned memory mode", () => {
    assert.equal(mergeHarnessSettings(
      { memory: { shadowMode: false } },
      { memory: { mode: "takeover" } },
    ).memory.mode, "off");
    assert.equal(mergeHarnessSettings(
      { memory: { mode: "assist" } },
      { memory: { mode: "off" } },
    ).memory.mode, "assist");
  });

  it("rejects unknown and malformed user memory modes", () => {
    assert.throws(() => resolveHarnessMemoryMode({ mode: "automatic" }), HarnessSettingsValidationError);
    assert.throws(() => resolveHarnessMemoryMode({ shadowMode: "yes" }), /must be a boolean/);
    assert.throws(() => resolveHarnessMemoryMode(false), /must be an object/);
  });

  it("keeps web search provider and credential selection user-owned", () => {
    const merged = mergeHarnessSettings({
      web: {
        search: { provider: "brave", credentialRef: "brave-search" },
        render: false,
      },
    }, {
      web: {
        search: { provider: "searxng", endpoint: "http://workspace.invalid" },
        render: true,
      },
    });
    assert.deepEqual(merged.web?.search, { provider: "brave", credentialRef: "brave-search" });
    assert.equal(merged.web?.render, true);
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
