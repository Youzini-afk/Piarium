import assert from "node:assert/strict";
import test from "node:test";
import { SurfaceExtensionRuntime } from "@piarium/extension-surface";
import {
  defineSurfaceMount,
  resolveHostExtensionModule,
  resolveIsolatedExtensionModule,
  resolveSurfaceExtensionModule,
  type PiariumExtensionMigrationInput,
} from "../src/index.js";
import {
  runHostExtensionConformance,
  runIsolatedExtensionConformance,
  runSurfaceExtensionConformance,
} from "../src/testing.js";

test("the author conformance harness proves contribution and service teardown", async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const result = await runSurfaceExtensionConformance({
    activation: (context) => {
      context.contribute({
        contractVersion: 1,
        data: {},
        id: "dev.example.conformance.page",
        kind: "page",
        supports: ["web"],
      }, {});
      context.provide({ id: "dev.example.conformance.service", version: 1 }, {});
    },
    owner: {
      desiredRevision: 1,
      entrypointId: "main",
      extensionId: "dev.example.conformance",
      extensionVersion: "1.0.0",
      generation: 1,
      hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a",
      realmId: "conformance",
    },
    runtime,
  });
  assert.deepEqual(result.activeContributionIds, ["dev.example.conformance.page"]);
  assert.deepEqual(result.activeServiceIds, ["dev.example.conformance.service"]);
  assert.equal(runtime.getSnapshot().contributions.length, 0);
});

test("the author conformance harness exercises Host storage, services, and cleanup", async () => {
  let disposed = false;
  const result = await runHostExtensionConformance({
    extensionId: "dev.example.host-conformance",
    activation: async (context) => {
      context.services.provide({ id: "dev.example.host-service", version: 1 }, { read: () => "ok" });
      await context.storage.update({ ready: true });
      const workspace = await context.storage.open({ key: "preferences", schemaVersion: 2, scope: "workspace" });
      await workspace.update({ layout: "wide" });
      context.effect(() => { disposed = true; });
    },
  });
  assert.deepEqual(result.providedServiceIds, ["dev.example.host-service@1"]);
  assert.deepEqual(result.finalStorage.document.data, { ready: true });
  assert.deepEqual(
    result.finalStorages.find((snapshot) => snapshot.address.scope === "workspace")?.document.data,
    { layout: "wide" },
  );
  assert.equal(result.registeredDisposers, 1);
  assert.equal(disposed, true);
});

test("the author conformance harness exercises isolated contributions and cleanup", async () => {
  let disposed = false;
  const result = await runIsolatedExtensionConformance({
    activation: (context) => {
      context.contribute({
        contractVersion: 1,
        data: {},
        id: "dev.example.isolated.page",
        kind: "page",
        supports: ["web"],
      });
      context.effect(() => { disposed = true; });
    },
  });
  assert.deepEqual(result.contributionIds, ["dev.example.isolated.page"]);
  assert.equal(result.registeredDisposers, 1);
  assert.equal(disposed, true);
});

test("module resolvers preserve extension-object method ownership", async () => {
  const host = resolveHostExtensionModule({
    value: "host-owned",
    activate() {
      assert.equal((this as { value: string }).value, "host-owned");
    },
    migrate(input: PiariumExtensionMigrationInput) {
      assert.equal((this as { value: string }).value, "host-owned");
      return input.data;
    },
  } as never);
  await runHostExtensionConformance({ activation: host.activate, extensionId: "dev.example.bound-host" });
  assert.deepEqual(await host.migrate?.({ data: { ok: true }, fromSchemaVersion: 1, toSchemaVersion: 2 }), { ok: true });

  const isolated = resolveIsolatedExtensionModule({
    value: "isolated-owned",
    activate() {
      assert.equal((this as { value: string }).value, "isolated-owned");
    },
  } as never);
  await runIsolatedExtensionConformance({ activation: isolated.activate });

  const surface = resolveSurfaceExtensionModule({
    value: "surface-owned",
    activate() {
      assert.equal((this as { value: string }).value, "surface-owned");
    },
  } as never);
  await surface.activate({} as never);
});

test("defineSurfaceMount exposes the framework-neutral DOM lifecycle contract", async () => {
  const controller = new AbortController();
  const container = { textContent: "" } as HTMLElement;
  let disposed = 0;
  const implementation = defineSurfaceMount<{ label: string }>(async (element, context) => {
    assert.equal(context.contributionId, "dev.example.mount.panel");
    assert.equal(context.owner.extensionId, "dev.example.mount");
    assert.equal(context.signal, controller.signal);
    element.textContent = context.props.label;
    return () => {
      disposed += 1;
      element.textContent = "";
    };
  });

  const cleanup = await implementation.mount(container, {
    contributionId: "dev.example.mount.panel",
    owner: {
      desiredRevision: 1,
      entrypointId: "main",
      extensionId: "dev.example.mount",
      extensionVersion: "1.0.0",
      generation: 1,
      hostId: "72694a4f-093a-4f79-8763-3ca9f06b7078",
      realmId: "mount-test",
    },
    props: { label: "framework neutral" },
    reportError: (error) => { throw error; },
    signal: controller.signal,
  });
  assert.equal(container.textContent, "framework neutral");
  assert.equal(typeof cleanup, "function");
  if (typeof cleanup === "function") await cleanup();
  assert.equal(disposed, 1);
  assert.equal(container.textContent, "");
});

test("workspace.documents capability helper forwards resource-scoped calls", async () => {
  const { callWorkspaceDocuments, PIARIUM_WORKSPACE_DOCUMENTS_CAPABILITY } = await import("../src/index.js");
  assert.equal(PIARIUM_WORKSPACE_DOCUMENTS_CAPABILITY, "workspace.documents");
  const calls: Array<[string, string, unknown]> = [];
  const result = await callWorkspaceDocuments({
    call: async (capability, method, params) => {
      calls.push([capability, method, params]);
      return { status: "missing", resource: params };
    },
  }, "read", { workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", resourceId: "note.txt" });
  assert.deepEqual(calls, [[
    "workspace.documents",
    "read",
    { workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", resourceId: "note.txt" },
  ]]);
  assert.equal((result as { status?: string }).status, "missing");
});
