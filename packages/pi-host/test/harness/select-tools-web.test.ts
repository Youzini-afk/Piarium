import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectHarnessTools, computeYieldedTools } from "../../src/harness/select-tools.js";
import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { DEFAULT_HARNESS_SETTINGS, type HarnessSettings } from "@piarium/protocol";

function createBridge(): HostServicesBridge {
  return new HostServicesBridge({
    emit: () => {},
    sessionId: "test",
    defaultTimeoutMs: 5000,
  });
}

const baseDeps = {
  bridge: createBridge(),
  sessionId: "test",
  cwd: "/tmp",
  workspaceMutationJournal: undefined,
  isOpenAIFamily: false,
};

describe("computeYieldedTools", () => {
  it("returns empty set when pi-web-access not loaded", () => {
    const yielded = computeYieldedTools([
      { name: "some-other-package", enabled: true, source: "npm:some-other-package" },
    ]);
    assert.equal(yielded.size, 0);
  });

  it("returns webfetch+websearch when pi-web-access loaded and enabled", () => {
    const yielded = computeYieldedTools([
      { name: "pi-web-access", enabled: true, source: "npm:pi-web-access" },
    ]);
    assert.equal(yielded.size, 2);
    assert.equal(yielded.has("webfetch"), true);
    assert.equal(yielded.has("websearch"), true);
  });

  it("returns empty set when pi-web-access loaded but disabled", () => {
    const yielded = computeYieldedTools([
      { name: "pi-web-access", enabled: false, source: "npm:pi-web-access" },
    ]);
    assert.equal(yielded.size, 0);
  });

  it("matches pi-web-access in source field", () => {
    const yielded = computeYieldedTools([
      { name: "@some-scope/pi-web-access", enabled: true, source: "npm:@some-scope/pi-web-access" },
    ]);
    assert.equal(yielded.size, 2);
  });
});

describe("selectHarnessTools web tool gating", () => {
  it("includes webfetch and websearch by default", () => {
    const tools = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, baseDeps);
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("webfetch"));
    assert.ok(names.includes("websearch"));
  });

  it("omits webfetch when in yieldedTools", () => {
    const tools = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, {
      ...baseDeps,
      yieldedTools: new Set(["webfetch", "websearch"]),
    });
    const names = tools.map((t) => t.name);
    assert.equal(names.includes("webfetch"), false);
    assert.equal(names.includes("websearch"), false);
  });

  it("omits webfetch when disabled in settings", () => {
    const settings: HarnessSettings = {
      ...DEFAULT_HARNESS_SETTINGS,
      tools: { webfetch: false },
    };
    const tools = selectHarnessTools(settings, baseDeps);
    const names = tools.map((t) => t.name);
    assert.equal(names.includes("webfetch"), false);
    assert.ok(names.includes("websearch"));
  });

  it("omits websearch when disabled in settings", () => {
    const settings: HarnessSettings = {
      ...DEFAULT_HARNESS_SETTINGS,
      tools: { websearch: false },
    };
    const tools = selectHarnessTools(settings, baseDeps);
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("webfetch"));
    assert.equal(names.includes("websearch"), false);
  });
});
