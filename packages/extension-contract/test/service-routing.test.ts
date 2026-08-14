import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultPiariumExtensionServiceRoutingDocument,
  resolvePiariumExtensionServiceRouting,
} from "../src/index.js";

const candidates = [
  { providerId: "alpha-generation-2", providerKey: "dev.alpha:host:memory@1" },
  { providerId: "beta-generation-4", providerKey: "dev.beta:host:memory@1" },
];

test("service routing resolves the most specific matching scope with a stable provider key", () => {
  const document = defaultPiariumExtensionServiceRoutingDocument();
  document.rules = [
    {
      allowFallback: false,
      providerKey: candidates[0]!.providerKey,
      scope: { userId: "youzi" },
      serviceId: "memory",
      version: 1,
    },
    {
      allowFallback: false,
      providerKey: candidates[1]!.providerKey,
      scope: { sessionId: "session-a", userId: "youzi" },
      serviceId: "memory",
      version: 1,
    },
  ];
  const resolution = resolvePiariumExtensionServiceRouting({
    candidates,
    context: { sessionId: "session-a", userId: "youzi" },
    document,
    serviceId: "memory",
    version: 1,
  });
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.providerId, "beta-generation-4");
});

test("service routing falls through only when the missing selection allows fallback", () => {
  const document = defaultPiariumExtensionServiceRoutingDocument();
  document.rules = [
    {
      allowFallback: true,
      providerKey: "dev.missing:host:memory@1",
      scope: { sessionId: "session-a" },
      serviceId: "memory",
      version: 1,
    },
    {
      allowFallback: false,
      providerKey: candidates[0]!.providerKey,
      scope: { userId: "youzi" },
      serviceId: "memory",
      version: 1,
    },
  ];
  const resolution = resolvePiariumExtensionServiceRouting({
    candidates,
    context: { sessionId: "session-a", userId: "youzi" },
    document,
    serviceId: "memory",
    version: 1,
  });
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.providerKey, candidates[0]!.providerKey);
  assert.equal(resolution.diagnostics[0]?.code, "service_selection_fallback");

  document.rules[0]!.allowFallback = false;
  const unavailable = resolvePiariumExtensionServiceRouting({
    candidates,
    context: { sessionId: "session-a", userId: "youzi" },
    document,
    serviceId: "memory",
    version: 1,
  });
  assert.equal(unavailable.status, "unavailable");
});

test("equally specific conflicting rules are explicit instead of load-order dependent", () => {
  const document = defaultPiariumExtensionServiceRoutingDocument();
  document.rules = [
    {
      allowFallback: false,
      providerKey: candidates[0]!.providerKey,
      scope: { sessionId: "session-a", userId: "youzi" },
      serviceId: "memory",
      version: 1,
    },
    {
      allowFallback: false,
      providerKey: candidates[1]!.providerKey,
      scope: { sessionId: "session-a", workspaceId: "/workspace" },
      serviceId: "memory",
      version: 1,
    },
  ];
  const resolution = resolvePiariumExtensionServiceRouting({
    candidates,
    context: { sessionId: "session-a", userId: "youzi", workspaceId: "/workspace" },
    document,
    serviceId: "memory",
    version: 1,
  });
  assert.equal(resolution.status, "ambiguous");
  assert.equal(resolution.diagnostics[0]?.code, "service_selection_scope_conflict");
});
