import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import type {
  PiariumExtensionActualState,
  PiariumExtensionAssetPayload,
  PiariumExtensionCatalogEntry,
  PiariumExtensionCatalogSnapshot,
  PiariumExtensionManagedEntrypointPayload,
  PiariumExtensionManifest,
  PiariumExtensionHostStateSnapshot,
} from "@piarium/extension-contract";
import { SurfaceExtensionRuntime } from "@piarium/extension-surface";
import {
  evaluateManagedSurfaceModule,
  SurfaceExtensionLoader,
  type ManagedStyleHost,
  type IsolatedSurfaceRealmFactory,
} from "../src/index.js";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const hostId = "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a";
const realmId = "window-test";

const integrityFor = (value: string): string => `sha256-${createHash("sha256").update(value).digest("hex")}`;

const asset = (value: string, artifactIntegrity: string, path: string, contentType = "text/javascript; charset=utf-8"): PiariumExtensionAssetPayload => ({
  artifactIntegrity,
  bytesBase64: Buffer.from(value).toString("base64"),
  contentType,
  integrity: integrityFor(value),
  path,
});

const manifest = (version: string): PiariumExtensionManifest => ({
  schemaVersion: 1,
  id: "dev.example.managed",
  version,
  engines: { piarium: "*" },
  entrypoints: {
    surfaces: [{ id: "main", file: "surface.js", mode: "managed", supports: ["web"] }],
  },
});

const catalogEntry = (version: string, artifactIntegrity: string): PiariumExtensionCatalogEntry => ({
  actual: [],
  capabilityGrants: [],
  desired: { enabled: true, revision: 1, updatedAt: "2026-08-14T00:00:00.000Z" },
  installedAt: "2026-08-14T00:00:00.000Z",
  integrity: artifactIntegrity,
  manifest: manifest(version),
  resolvedVersion: version,
  selectedVersion: version,
  source: { display: "Test", kind: "local" },
  updatedAt: "2026-08-14T00:00:00.000Z",
});

const snapshot = (revision: number, entry: PiariumExtensionCatalogEntry): PiariumExtensionCatalogSnapshot => ({
  authoritative: true,
  diagnostics: [],
  extensions: [entry],
  hostId,
  loadedAt: "2026-08-14T00:00:00.000Z",
  revision,
  schemaVersion: 1,
  storageState: "ready",
});

const hostState = (
  catalog: PiariumExtensionCatalogSnapshot,
  revision = catalog.revision,
  providers: PiariumExtensionHostStateSnapshot['services']['providers'] = [],
): PiariumExtensionHostStateSnapshot => ({
  catalog,
  revision,
  services: { hostId, providers, revision, selections: {} },
  workbench: {
    authoritative: true,
    diagnostics: [],
    document: {
      activeProfileId: 'default', layouts: [], profileSelections: { users: {}, workspaces: {} },
      profiles: [{ id: 'default', label: 'Default' }], revision: 0, schemaVersion: 1,
      updatedAt: '1970-01-01T00:00:00.000Z',
    },
    hostId,
    storageState: 'missing',
  },
});

test("evaluates a self-contained CommonJS managed module without a module URL", async () => {
  const loaded = await evaluateManagedSurfaceModule(
    "module.exports={default:{activate(){return 'active'}}};",
    { entrypointId: "main", extensionId: "dev.example.managed", integrity: integrityFor("module") },
  );
  assert.equal(typeof (loaded.default as { activate?: unknown })?.activate, "function");
});

test("managed candidate activation, rollback, style ownership, and disable are refresh-free", async () => {
  const v1Integrity = integrityFor("artifact-v1");
  const failedIntegrity = integrityFor("artifact-failed");
  const v3Integrity = integrityFor("artifact-v3");
  let current = snapshot(1, catalogEntry("1.0.0", v1Integrity));
  const code = new Map([[v1Integrity, "v1"], [failedIntegrity, "fail"], [v3Integrity, "v3"]]);
  const reported: PiariumExtensionActualState[] = [];
  let selections = 0;
  let committedStyles = 0;
  const styleHost: ManagedStyleHost = {
    stage: () => {
      let committed = false;
      return {
        commit: () => {
          if (!committed) committedStyles += 1;
          committed = true;
        },
        dispose: () => {
          if (committed) committedStyles -= 1;
          committed = false;
        },
      };
    },
  };
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const loader = new SurfaceExtensionLoader({
    evaluateModule: (source) => ({
      default: {
        activate: (context) => {
          if (source === "fail") throw new Error("candidate module failed");
          context.contribute({
            contractVersion: 1,
            data: {},
            id: "dev.example.managed.page",
            kind: "page",
            supports: ["web"],
          }, { version: source });
        },
      },
    }),
    host: {
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => hostState(current),
      invokeService: async () => { throw new Error("unexpected service invocation"); },
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async (request): Promise<PiariumExtensionManagedEntrypointPayload> => {
        const source = code.get(request.integrity);
        if (!source) throw new Error("unknown artifact");
        return {
          artifactIntegrity: request.integrity,
          entrypointId: request.entrypointId,
          module: asset(source, request.integrity, "runtime/surface/main/module.cjs"),
          styles: [asset(".managed {}", request.integrity, "runtime/surface/main/module.css", "text/css; charset=utf-8")],
        };
      },
      reportActualState: async (_extensionId, state) => { reported.push(state); },
      selectCandidate: async (request) => {
        selections += 1;
        const entry = current.extensions[0] as PiariumExtensionCatalogEntry;
        assert.equal(entry.candidate?.integrity, request.candidateIntegrity);
        const candidate = entry.candidate;
        if (!candidate) throw new Error("candidate disappeared");
        const { candidate: _candidate, ...selectedEntry } = entry;
        void _candidate;
        current = snapshot(current.revision + 1, {
          ...selectedEntry,
          integrity: candidate.integrity,
          manifest: candidate.manifest,
          resolvedVersion: candidate.resolvedVersion,
          selectedVersion: candidate.resolvedVersion,
          source: candidate.source,
        });
        return current;
      },
      waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
    },
    realmId,
    styleHost,
    surface: "web",
    surfaceRuntime: runtime,
  });

  await loader.reconcile();
  assert.equal((runtime.getSnapshot().visibleContributions[0]?.implementation as { version: string }).version, "v1");
  assert.equal(committedStyles, 1);

  current = snapshot(2, {
    ...current.extensions[0] as PiariumExtensionCatalogEntry,
    candidate: {
      capabilitiesReviewed: true,
      capabilityDelta: { added: [], removed: [] },
      capabilityGrants: [],
      integrity: failedIntegrity,
      manifest: manifest("2.0.0"),
      preparedAt: "2026-08-14T00:01:00.000Z",
      resolvedVersion: "2.0.0",
      source: { display: "Test", kind: "local" },
    },
  });
  await loader.reconcile();
  assert.equal((runtime.getSnapshot().visibleContributions[0]?.implementation as { version: string }).version, "v1");
  assert.equal(selections, 0);
  assert.equal(committedStyles, 1);

  current = snapshot(3, {
    ...current.extensions[0] as PiariumExtensionCatalogEntry,
    candidate: {
      capabilitiesReviewed: true,
      capabilityDelta: { added: [], removed: [] },
      capabilityGrants: [],
      integrity: v3Integrity,
      manifest: manifest("3.0.0"),
      preparedAt: "2026-08-14T00:02:00.000Z",
      resolvedVersion: "3.0.0",
      source: { display: "Test", kind: "local" },
    },
  });
  await loader.reconcile();
  assert.equal((runtime.getSnapshot().visibleContributions[0]?.implementation as { version: string }).version, "v3");
  assert.equal(selections, 1);
  assert.equal(committedStyles, 1);

  current = snapshot(current.revision + 1, {
    ...current.extensions[0] as PiariumExtensionCatalogEntry,
    desired: { enabled: false, revision: 2, updatedAt: "2026-08-14T00:03:00.000Z" },
  });
  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 0);
  assert.equal(committedStyles, 0);
  assert.equal(reported.some((state) => state.status === "active"), true);
  assert.equal(reported.some((state) => state.status === "inactive"), true);
});

test("candidate code does not execute before added capabilities are reviewed", async () => {
  const selectedIntegrity = integrityFor("review-selected");
  const candidateIntegrity = integrityFor("review-candidate");
  const candidateManifest: PiariumExtensionManifest = {
    ...manifest("2.0.0"),
    capabilities: { surface: ["desktop.files"] },
  };
  const entry: PiariumExtensionCatalogEntry = {
    ...catalogEntry("1.0.0", selectedIntegrity),
    candidate: {
      capabilitiesReviewed: false,
      capabilityDelta: { added: [{ capability: "desktop.files", realm: "surface" }], removed: [] },
      capabilityGrants: [],
      integrity: candidateIntegrity,
      manifest: candidateManifest,
      preparedAt: "2026-08-14T00:01:00.000Z",
      resolvedVersion: "2.0.0",
      source: { display: "Test", kind: "local" },
    },
  };
  const current = snapshot(2, entry);
  const evaluated: string[] = [];
  let prepared = 0;
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const loader = new SurfaceExtensionLoader({
    evaluateModule: (source) => {
      evaluated.push(source);
      return { default: { activate: () => undefined } };
    },
    host: {
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => hostState(current),
      invokeService: async () => { throw new Error("unexpected service invocation"); },
      prepareCandidate: async (extensionId, integrity) => { prepared += 1; return { extensionId, integrity, providers: [] }; },
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async (request) => ({
        artifactIntegrity: request.integrity,
        entrypointId: request.entrypointId,
        module: asset(request.integrity === selectedIntegrity ? "selected" : "candidate", request.integrity, "runtime/surface/main/module.cjs"),
        styles: [],
      }),
      reportActualState: async () => undefined,
      selectCandidate: async () => { throw new Error("candidate must not be selected"); },
      waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
    },
    realmId,
    surface: "web",
    surfaceRuntime: runtime,
  });

  await loader.reconcile();
  assert.deepEqual(evaluated, ["selected"]);
  assert.equal(prepared, 0);
});

test("withdrawn Host services tear down dependent Surface owners", async () => {
  const artifactIntegrity = integrityFor("service-artifact");
  const serviceManifest: PiariumExtensionManifest = {
    ...manifest("1.0.0"),
    requires: { services: [{ id: "dev.example.host-service", version: 1 }] },
  };
  let current = snapshot(1, { ...catalogEntry("1.0.0", artifactIntegrity), manifest: serviceManifest });
  let stateRevision = 1;
  let providers = [{
    descriptor: { id: "dev.example.host-service", version: 1 },
    entrypointId: "host",
    extensionId: "dev.example.provider",
    extensionVersion: "1.0.0",
    generation: 1,
    providerId: "dev.example.provider:host:1:dev.example.host-service@1",
    status: "active" as const,
  }];
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const loader = new SurfaceExtensionLoader({
    evaluateModule: () => ({
      default: {
        activate: async (context) => {
          const service = context.useService<{ read(): Promise<string> }>("dev.example.host-service", 1);
          context.contribute({
            contractVersion: 1,
            data: {},
            id: "dev.example.managed.service-page",
            kind: "page",
            supports: ["web"],
          }, { value: await service?.read() });
        },
      },
    }),
    host: {
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => hostState(current, stateRevision, providers),
      invokeService: async () => "host-value",
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async (request) => ({
        artifactIntegrity: request.integrity,
        entrypointId: request.entrypointId,
        module: asset("service", request.integrity, "runtime/surface/main/module.cjs"),
        styles: [],
      }),
      reportActualState: async () => undefined,
      selectCandidate: async () => current,
      waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
    },
    realmId,
    surface: "web",
    surfaceRuntime: runtime,
  });
  await loader.reconcile();
  assert.deepEqual(runtime.getSnapshot().visibleContributions[0]?.implementation, { value: "host-value" });
  providers = [];
  stateRevision += 1;
  current = { ...current, revision: current.revision + 1 };
  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 0);
});

test("isolated Surface realms contribute transactionally and are physically disposed on disable", async () => {
  const artifactIntegrity = integrityFor("isolated-artifact");
  const isolatedManifest: PiariumExtensionManifest = {
    ...manifest("1.0.0"),
    entrypoints: {
      surfaces: [{ id: "main", file: "surface.js", isolation: "iframe", mode: "isolated", supports: ["web"] }],
    },
  };
  let current = snapshot(1, { ...catalogEntry("1.0.0", artifactIntegrity), manifest: isolatedManifest });
  let disposed = false;
  let receivedStyles: readonly string[] = [];
  const isolatedRealmFactory: IsolatedSurfaceRealmFactory = {
    create: (_source, styles, identity) => ({
      activate: async (context) => {
        context.contribute({
          contractVersion: 1,
          data: {},
          id: "dev.example.managed.isolated-page",
          kind: "page",
          supports: ["web"],
        }, { kind: "isolated-iframe", mount: () => () => undefined, postMessage: () => undefined, realmId: identity.realmId, viewId: "main" });
      },
      get disposed() { return disposed; },
      dispose: () => { disposed = true; },
    }),
  };
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const loader = new SurfaceExtensionLoader({
    host: {
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => hostState(current),
      invokeService: async () => { throw new Error("unexpected service invocation"); },
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async (request) => ({
        artifactIntegrity: request.integrity,
        entrypointId: request.entrypointId,
        module: asset("isolated", request.integrity, "runtime/surface/main/module.js"),
        styles: [asset(".isolated {}", request.integrity, "runtime/surface/main/module.css", "text/css; charset=utf-8")],
      }),
      reportActualState: async () => undefined,
      selectCandidate: async () => current,
      waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
    },
    isolatedRealmFactory: {
      create: (source, styles, identity) => {
        receivedStyles = styles;
        return isolatedRealmFactory.create(source, styles, identity);
      },
    },
    realmId,
    surface: "web",
    surfaceRuntime: runtime,
  });

  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 1);
  assert.deepEqual(receivedStyles, [".isolated {}"]);
  current = snapshot(2, {
    ...current.extensions[0] as PiariumExtensionCatalogEntry,
    desired: { enabled: false, revision: 2, updatedAt: "2026-08-14T00:05:00.000Z" },
  });
  await loader.reconcile();
  assert.equal(disposed, true);
  assert.equal(runtime.getSnapshot().visibleContributions.length, 0);
});

test("trusted-native Surface activation failure requires a Surface reload and is not retried", async () => {
  const artifactIntegrity = integrityFor("native-artifact");
  const nativeManifest: PiariumExtensionManifest = {
    ...manifest("1.0.0"),
    entrypoints: {
      surfaces: [{ id: "main", file: "surface.cjs", mode: "native", supports: ["web"] }],
    },
  };
  const current = snapshot(1, { ...catalogEntry("1.0.0", artifactIntegrity), manifest: nativeManifest });
  const reported: PiariumExtensionActualState[] = [];
  let evaluations = 0;
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const loader = new SurfaceExtensionLoader({
    evaluateModule: () => {
      evaluations += 1;
      throw new Error("native top-level failure");
    },
    host: {
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => hostState(current),
      invokeService: async () => { throw new Error("unexpected service invocation"); },
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async (request) => ({
        artifactIntegrity: request.integrity,
        entrypointId: request.entrypointId,
        module: asset("native", request.integrity, "runtime/surface/main/module.cjs"),
        styles: [],
      }),
      reportActualState: async (_extensionId, state) => { reported.push(state); },
      selectCandidate: async () => current,
      waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
    },
    realmId,
    surface: "web",
    surfaceRuntime: runtime,
  });

  await loader.reconcile();
  await loader.reconcile();
  assert.equal(evaluations, 1);
  assert.equal(runtime.getSnapshot().actual[0]?.status, "restart-required");
  assert.equal(reported.some((state) => state.status === "restart-required"), true);
});
