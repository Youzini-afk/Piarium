import { test } from "node:test";
import assert from "node:assert/strict";

test("application-client exports RuntimeAPIs type and error classes", async () => {
  const mod = await import("../src/index.js");
  assert.ok(mod.DocumentsError, "DocumentsError should be exported");
  assert.ok(mod.FilesystemError, "FilesystemError should be exported");
  assert.ok(mod.LanguageServicesError, "LanguageServicesError should be exported");
  assert.ok(mod.RunServicesError, "RunServicesError should be exported");
  assert.ok(mod.WorkspaceSearchError, "WorkspaceSearchError should be exported");
});

test("application-client exports DTO types via re-exports", async () => {
  const mod = await import("../src/index.js");
  // These are type-only exports, but the module should load without error
  // and expose the runtime values (error classes, etc.)
  assert.ok(typeof mod.DocumentsError === "function");
  assert.ok(typeof mod.FilesystemError === "function");
});

test("DocumentsError preserves reason and status", async () => {
  const { DocumentsError } = await import("../src/index.js");
  const error = new DocumentsError("test", { reason: "untrusted", status: 403 });
  assert.equal(error.reason, "untrusted");
  assert.equal(error.status, 403);
  assert.equal(error.name, "DocumentsError");
});

test("application-client exports transport functions", async () => {
  const mod = await import("../src/index.js");
  assert.ok(typeof mod.runtimeFetch === "function", "runtimeFetch should be exported");
  assert.ok(typeof mod.buildRuntimeAuthHeaders === "function", "buildRuntimeAuthHeaders should be exported");
  assert.ok(typeof mod.configureRuntimeUrlResolver === "function", "configureRuntimeUrlResolver should be exported");
  assert.ok(typeof mod.switchRuntimeEndpoint === "function", "switchRuntimeEndpoint should be exported");
  assert.ok(typeof mod.registerRelayTunnelProvider === "function", "registerRelayTunnelProvider should be exported");
  assert.ok(typeof mod.registerRelayTunnelLifecycle === "function", "registerRelayTunnelLifecycle should be exported");
});

test("relay activation fails explicitly when a surface did not register its lifecycle", async () => {
  const { activateRelayTunnel } = await import("../src/index.js");
  assert.throws(() => activateRelayTunnel({
    relayUrl: "wss://relay.example.test",
    serverId: "server-1",
    hostEncPubJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  }), /lifecycle is not registered/);
});
