import assert from "node:assert/strict";
import test from "node:test";
import { SurfaceCapabilityRegistry } from "../src/index.js";

const owner = {
  desiredRevision: 1,
  entrypointId: "main",
  extensionId: "dev.example.extension",
  extensionVersion: "1.0.0",
  generation: 1,
  hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a",
  realmId: "window-test",
};

test("surface capability policy keeps local and project grants out of incompatible pages", async () => {
  const registry = new SurfaceCapabilityRegistry();
  registry.register({
    exposure: "local-only",
    id: "desktop.files",
    projectTrust: "required",
    supports: ["desktop", "web"],
  }, async (_method, params) => params);
  registry.register({
    exposure: "remote-safe",
    id: "ui.notifications",
    supports: ["web"],
  }, async () => "ok");

  const requested = ["desktop.files", "ui.notifications"];
  assert.deepEqual(registry.resolveGranted(requested, {
    access: "remote",
    projectTrusted: true,
    surface: "web",
  }), ["ui.notifications"]);
  assert.deepEqual(registry.resolveGranted(requested, {
    access: "local",
    projectTrusted: false,
    surface: "web",
  }), ["ui.notifications"]);
  assert.deepEqual(registry.resolveGranted(requested, {
    access: "local",
    projectTrusted: true,
    surface: "web",
  }), requested);

  await assert.rejects(() => registry.invoke(
    "desktop.files",
    "read",
    {},
    owner,
    requested,
    { access: "remote", projectTrusted: true, surface: "web" },
    new AbortController().signal,
  ), /unavailable/);
});
