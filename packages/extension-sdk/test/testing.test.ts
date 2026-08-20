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

test("workspace.search and workspace.language capability helpers forward host calls", async () => {
  const {
    callWorkspaceLanguage,
    callWorkspaceSearch,
    PIARIUM_WORKSPACE_LANGUAGE_CAPABILITY,
    PIARIUM_WORKSPACE_SEARCH_CAPABILITY,
  } = await import("../src/index.js");
  assert.equal(PIARIUM_WORKSPACE_SEARCH_CAPABILITY, "workspace.search");
  assert.equal(PIARIUM_WORKSPACE_LANGUAGE_CAPABILITY, "workspace.language");
  const calls: Array<[string, string, unknown]> = [];
  const client = {
    call: async (capability: string, method: string, params: unknown) => {
      calls.push([capability, method, params]);
      return { status: "absent" };
    },
  };
  await callWorkspaceSearch(client, "searchContent", { workspaceId: "ws", query: "todo" });
  await callWorkspaceLanguage(client, "getStatus", { workspaceId: "ws", languageId: "typescript" });
  assert.deepEqual(calls, [
    ["workspace.search", "searchContent", { workspaceId: "ws", query: "todo" }],
    ["workspace.language", "getStatus", { workspaceId: "ws", languageId: "typescript" }],
  ]);
});

test("typed document and language clients plus workbench mounts are public SDK contracts", async () => {
  const {
    createWorkspaceDocumentsClient,
    createWorkspaceLanguageClient,
    defineEditorMount,
    defineLanguageProvider,
    defineShellMount,
    PIARIUM_WORKBENCH_CONTEXT_KEYS,
    PIARIUM_WORKBENCH_REPLACEMENT_TARGETS,
    PIARIUM_WORKBENCH_SLOTS,
  } = await import("../src/index.js");
  assert.equal(PIARIUM_WORKBENCH_CONTEXT_KEYS.editorIsOpen, "editorIsOpen");
  assert.equal(PIARIUM_WORKBENCH_SLOTS.primarySidebarViews, "workbench.primary-sidebar.views");
  assert.equal(PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.editor, "workbench.editor");
  const calls: Array<[string, string]> = [];
  const capabilities = {
    call: async (capability: string, method: string) => {
      calls.push([capability, method]);
      if (method === "write") return { status: "written", revision: "d1_1", byteLength: 3 };
      if (method === "registerProvider") return { status: "registered", providerId: "md" };
      return { status: "ok" };
    },
  };
  const written = await createWorkspaceDocumentsClient(capabilities).write({
    resource: { workspaceId: "ws", resourceId: "note.txt" },
    content: "one",
    encoding: "utf-8",
    bom: false,
    expectedRevision: null,
    operationId: "op-1",
  });
  assert.equal((written as { status?: string }).status, "written");
  await createWorkspaceLanguageClient(capabilities).registerProvider({
    command: "node",
    languageIds: ["markdown"],
    providerId: "md",
  });
  const provider = defineLanguageProvider({
    command: "node",
    languageIds: ["markdown"],
    providerId: "md",
  });
  await runHostExtensionConformance({ activation: provider.activate, extensionId: "dev.example.language" });
  assert.equal(typeof defineShellMount, "function");
  assert.equal(typeof defineEditorMount, "function");
  assert.deepEqual(calls.slice(0, 2), [
    ["workspace.documents", "write"],
    ["workspace.language", "registerProvider"],
  ]);
});

test("debug and test host helpers register through capabilities and unregister on dispose", async () => {
  const {
    createWorkspaceDebugClient,
    createWorkspaceTestClient,
    callWorkspaceTasks,
    defineDebugAdapter,
    defineTestProvider,
    PIARIUM_WORKBENCH_CONTEXT_KEYS,
    PIARIUM_WORKSPACE_DEBUG_CAPABILITY,
    PIARIUM_WORKSPACE_TASKS_CAPABILITY,
    PIARIUM_WORKSPACE_TEST_CAPABILITY,
  } = await import("../src/index.js");
  assert.equal(PIARIUM_WORKSPACE_DEBUG_CAPABILITY, "workspace.debug");
  assert.equal(PIARIUM_WORKSPACE_TEST_CAPABILITY, "workspace.test");
  assert.equal(PIARIUM_WORKSPACE_TASKS_CAPABILITY, "workspace.tasks");
  assert.equal(PIARIUM_WORKBENCH_CONTEXT_KEYS.debugIsPaused, "debugIsPaused");
  const calls: Array<[string, string]> = [];
  const capabilities = {
    call: async (capability: string, method: string) => {
      calls.push([capability, method]);
      return { status: "ok" };
    },
  };
  await createWorkspaceDebugClient(capabilities).registerAdapter({
    adapterId: "node",
    command: "node",
  });
  await createWorkspaceTestClient(capabilities).registerProvider({
    providerId: "node-test",
    command: "node",
  });
  await callWorkspaceTasks(capabilities, "list", { workspaceId: "ws" });
  const debugResult = await runHostExtensionConformance({
    activation: defineDebugAdapter({ adapterId: "node", command: "node" }).activate,
    extensionId: "dev.example.debug",
  });
  const testResult = await runHostExtensionConformance({
    activation: defineTestProvider({ providerId: "node-test", command: "node" }).activate,
    extensionId: "dev.example.test",
  });
  assert.ok(debugResult.registeredDisposers >= 1);
  assert.ok(testResult.registeredDisposers >= 1);
  assert.deepEqual(calls, [
    ["workspace.debug", "registerAdapter"],
    ["workspace.test", "registerProvider"],
    ["workspace.tasks", "list"],
  ]);
});

test("workbench conformance covers async mount abort, profile switch, and resource conflict", async () => {
  const {
    runIsolatedDocumentConflictConformance,
    runSurfaceMountConformance,
    runWorkbenchProfileConformance,
  } = await import("../src/testing.js");
  const mount = await runSurfaceMountConformance();
  assert.equal(mount.mounted, true);
  assert.equal(mount.disposed, true);
  assert.equal(mount.aborted, true);
  const profiles = runWorkbenchProfileConformance();
  assert.equal(profiles.beforeSwitch, "default");
  assert.equal(profiles.afterSwitch, "studio");
  assert.equal(profiles.desiredEnabledUnchanged, true);
  assert.equal(profiles.failedCandidateKeepsPrevious, true);
  assert.equal((await runIsolatedDocumentConflictConformance()).status, "conflict");
});
