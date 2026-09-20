import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import {
  createSettingsActionTool,
  createSettingsReadTool,
  createSettingsSearchTool,
  createSettingsUpdateTool,
} from "../../src/harness/settings-tools.js";
import { selectHarnessTools } from "../../src/harness/select-tools.js";
import {
  classifyPermissionAction,
  classifyPermissionToolSource,
} from "../../src/harness/permission-target.js";
import { DEFAULT_HARNESS_SETTINGS, type HarnessRequestData } from "@piarium/protocol";

const SESSION = "session-1";
const isError = (result: unknown) => (result as { isError?: boolean }).isError;

function scriptedBridge(handlers: Record<string, (params: never) => unknown>) {
  const requests: HarnessRequestData[] = [];
  const bridge = new HostServicesBridge({
    emit: (_event, data) => {
      const request = data as HarnessRequestData;
      requests.push(request);
      queueMicrotask(() => {
        const handler = handlers[request.method];
        if (!handler) {
          bridge.respond(SESSION, request.requestId, {
            ok: false,
            error: { code: "unavailable", message: `no handler for ${request.method}` },
          });
          return;
        }
        try {
          bridge.respond(SESSION, request.requestId, { ok: true, result: handler(request.params as never) });
        } catch (error) {
          bridge.respond(SESSION, request.requestId, {
            ok: false,
            error: { code: "failed", message: error instanceof Error ? error.message : String(error) },
          });
        }
      });
    },
    sessionId: SESSION,
    defaultTimeoutMs: 5_000,
  });
  return { bridge, requests };
}

const searchItem = (over: Record<string, unknown> = {}) => ({
  id: "appearance.theme",
  category: "appearance",
  owner: "app",
  titleKey: "settings.theme",
  paths: ["themeVariant"],
  writable: true,
  page: "general",
  ...over,
});

describe("settings tools", () => {
  it("classifies SDK settings tools as harness reads and guarded control", () => {
    const sdkTool = (name: string) => ({
      name,
      sourceInfo: { path: "<sdk>", source: "sdk", scope: "temporary", origin: "top-level" },
    });
    const readSource = classifyPermissionToolSource(sdkTool("settings_read"), "settings_read");
    const updateSource = classifyPermissionToolSource(sdkTool("settings_update"), "settings_update");
    assert.equal(readSource.kind, "harness");
    assert.equal(updateSource.kind, "harness");
    assert.equal(classifyPermissionAction("settings_read", readSource), "read");
    assert.equal(classifyPermissionAction("settings_update", updateSource), "control");
  });

  it("are only registered when the host advertises the settings service", () => {
    const without = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, { sessionId: SESSION } as never);
    assert.equal(without.some((tool) => tool.name.startsWith("settings_")), false);
    const withService = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, {
      sessionId: SESSION,
      settingsAvailable: true,
    } as never);
    const names = withService.map((tool) => tool.name);
    assert.ok(names.includes("settings_search"));
    assert.ok(names.includes("settings_read"));
    assert.ok(names.includes("settings_update"));
    assert.ok(names.includes("settings_action"));
  });

  it("respect the harness tools gate", () => {
    const gated = selectHarnessTools(
      { ...DEFAULT_HARNESS_SETTINGS, tools: { settings_update: false } },
      { sessionId: SESSION, settingsAvailable: true } as never,
    );
    const names = gated.map((tool) => tool.name);
    assert.ok(names.includes("settings_search"));
    assert.equal(names.includes("settings_update"), false);
  });

  it("search forwards query/category/owner and renders catalog rows", async () => {
    const { bridge, requests } = scriptedBridge({
      "settings.search": (params: { query: string; category?: string }) => {
        assert.equal(params.query, "theme");
        assert.equal(params.category, "appearance");
        return {
          items: [searchItem(), searchItem({ id: "appearance.locale", owner: "client", writable: false })],
          total: 2,
          categories: [{ category: "appearance", count: 2 }],
        };
      },
    });
    const tool = createSettingsSearchTool(bridge);
    const result = await tool.execute("call-1", { query: "theme", category: "appearance" } as never, undefined, undefined, undefined as never);
    const text = JSON.stringify(result.content);
    assert.match(text, /appearance\.theme/);
    assert.match(text, /appearance\.locale \[client \(read-only\)\]/);
    assert.equal(requests[0]!.method, "settings.search");
    bridge.dispose();
  });

  it("read returns saved vs effective values with revision for CAS", async () => {
    const { bridge } = scriptedBridge({
      "settings.read": (params: { id: string; detail?: boolean }) => {
        assert.equal(params.id, "appearance.theme");
        assert.equal(params.detail, true);
        return {
          state: "ok",
          entry: searchItem(),
          fields: [{ path: "themeVariant", kind: "enum", saved: "dark", isSet: true }],
          effective: { value: "dark", source: "user" },
          revision: "rev-7",
          options: [{ value: "dark" }, { value: "light" }],
        };
      },
    });
    const tool = createSettingsReadTool(bridge);
    const result = await tool.execute("call-2", { id: "appearance.theme", detail: true } as never, undefined, undefined, undefined as never);
    const text = JSON.stringify(result.content);
    assert.match(text, /dark/);
    assert.match(text, /rev-7/);
    assert.ok(!isError(result));
    bridge.dispose();
  });

  it("read surfaces unavailable/action states without pretending to be values", async () => {
    const { bridge } = scriptedBridge({
      "settings.read": () => ({
        state: "action",
        entry: searchItem({ id: "providers.connect", owner: "action", writable: false }),
        action: { domain: "provider", verbs: ["connect"], note: "runs the real connect flow" },
      }),
    });
    const tool = createSettingsReadTool(bridge);
    const result = await tool.execute("call-3", { id: "providers.connect" } as never, undefined, undefined, undefined as never);
    const text = JSON.stringify(result.content);
    assert.match(text, /connect flow|action/);
    assert.ok(!isError(result));
    bridge.dispose();
  });

  it("update forwards set/reset/scope/expectedRevision and reports per-field results", async () => {
    const { bridge, requests } = scriptedBridge({
      "settings.update": (params: {
        id: string;
        set?: Record<string, unknown>;
        reset?: string[];
        scope?: string;
        expectedRevision?: string;
      }) => {
        assert.equal(params.id, "appearance.theme");
        assert.deepEqual(params.set, { themeVariant: "dark" });
        assert.equal(params.expectedRevision, "rev-7");
        return {
          status: "applied",
          entry: searchItem(),
          scope: "host",
          fields: [{ path: "themeVariant", status: "applied" }],
          revision: "rev-8",
          appliedAt: "immediate",
          effective: { themeVariant: "dark" },
        };
      },
    });
    const tool = createSettingsUpdateTool(bridge);
    const result = await tool.execute("call-4", {
      id: "appearance.theme",
      set: { themeVariant: "dark" },
      expectedRevision: "rev-7",
    } as never, undefined, undefined, undefined as never);
    const text = JSON.stringify(result.content);
    assert.match(text, /applied/);
    assert.match(text, /rev-8/);
    const request = requests[0]!;
    assert.equal(request.method, "settings.update");
    assert.ok(!isError(result));
    bridge.dispose();
  });

  it("update surfaces conflicts and per-field failures as agent-readable failures", async () => {
    const { bridge } = scriptedBridge({
      "settings.update": () => ({
        status: "failed",
        entry: searchItem(),
        scope: "host",
        fields: [{ path: "themeVariant", status: "failed", error: "revision conflict — re-read and retry (current rev-9)" }],
        revision: "rev-9",
        appliedAt: "immediate",
      }),
    });
    const tool = createSettingsUpdateTool(bridge);
    const result = await tool.execute("call-5", {
      id: "appearance.theme",
      set: { themeVariant: "dark" },
      expectedRevision: "rev-7",
    } as never, undefined, undefined, undefined as never);
    const text = JSON.stringify(result.content);
    assert.match(text, /revision conflict/);
    bridge.dispose();
  });

  it("action forwards the verb to the owner and reports operation handles", async () => {
    const { bridge, requests } = scriptedBridge({
      "settings.action": (params: { id: string; verb: string; args?: Record<string, unknown> }) => {
        assert.equal(params.id, "providers.connect");
        assert.equal(params.verb, "login");
        assert.equal(params.args?.providerId, "openai");
        return {
          entry: searchItem({ id: "providers.connect", owner: "action" }),
          verb: "login",
          status: "pending",
          detail: "browser flow opened",
          operation: { id: "op-42", state: "running", cancelVerb: "cancel-login" },
        };
      },
    });
    const tool = createSettingsActionTool(bridge);
    const result = await tool.execute("call-a1", {
      id: "providers.connect",
      verb: "login",
      args: { providerId: "openai" },
    } as never, undefined, undefined, undefined as never);
    const text = JSON.stringify(result.content);
    assert.match(text, /pending/);
    assert.match(text, /op-42/);
    assert.match(text, /cancel-login/);
    assert.equal(requests[0]!.method, "settings.action");
    assert.ok(!isError(result));
    bridge.dispose();
  });

  it("action marks denied/unavailable outcomes without claiming success", async () => {
    const { bridge } = scriptedBridge({
      "settings.action": () => ({
        entry: searchItem({ id: "providers.connect", owner: "action" }),
        verb: "obliterate",
        status: "denied",
        detail: "verb is not advertised for this entry",
      }),
    });
    const tool = createSettingsActionTool(bridge);
    const result = await tool.execute("call-a2", {
      id: "providers.connect",
      verb: "obliterate",
    } as never, undefined, undefined, undefined as never);
    assert.equal(isError(result), true);
    assert.match(JSON.stringify(result.content), /denied/);
    bridge.dispose();
  });

  it("update forwards compound items and surface selection", async () => {
    const { bridge, requests } = scriptedBridge({
      "settings.update": (params: {
        items?: { id: string; set?: Record<string, unknown>; surface?: string }[];
      }) => {
        assert.equal(params.items?.length, 2);
        assert.equal(params.items?.[1]?.surface, "surf-9");
        return {
          status: "partial",
          entry: searchItem(),
          scope: "host",
          fields: [],
          appliedAt: "immediate",
          items: [
            { id: "appearance.theme", status: "applied" },
            { id: "chat.persist-drafts", status: "unavailable", error: "surface offline" },
          ],
          surface: { id: "surf-9", kind: "web", results: [{ path: "enabled", status: "applied" }] },
        };
      },
    });
    const tool = createSettingsUpdateTool(bridge);
    const result = await tool.execute("call-a3", {
      items: [
        { id: "appearance.theme", set: { themeVariant: "dark" } },
        { id: "chat.persist-drafts", set: { enabled: false }, surface: "surf-9" },
      ],
    } as never, undefined, undefined, undefined as never);
    const text = JSON.stringify(result.content);
    assert.match(text, /appearance\.theme/);
    assert.match(text, /surf-9/);
    assert.equal(requests[0]!.method, "settings.update");
    bridge.dispose();
  });

  it("propagates host errors as tool failures with the code in details", async () => {
    const { bridge } = scriptedBridge({});
    const tool = createSettingsSearchTool(bridge);
    const result = await tool.execute("call-6", { query: "x" } as never, undefined, undefined, undefined as never);
    assert.equal(isError(result), true);
    assert.match(JSON.stringify(result.content), /unavailable/);
    bridge.dispose();
  });
});
