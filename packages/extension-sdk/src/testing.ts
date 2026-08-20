import {
  SurfaceExtensionRuntime,
  type SurfaceActivation,
  type SurfaceOwnerIdentity,
} from "@piarium/extension-surface";
import type {
  JsonObject,
  JsonValue,
  PiariumExtensionAssetPayload,
  PiariumExtensionServiceProvision,
  PiariumExtensionStaticContribution,
  PiariumExtensionStorageOpenRequest,
  PiariumExtensionStorageSnapshot,
} from "@piarium/extension-contract";
import {
  defaultPiariumWorkbenchProfileDocument,
  inspectPiariumWorkbenchShell,
  PIARIUM_WORKBENCH_REPLACEMENT_TARGETS,
  resolvePiariumWorkbenchProfile,
} from "@piarium/extension-contract";
import type {
  PiariumBrokeredHostContext,
  PiariumBrokeredHostExtension,
  PiariumHostServiceHandler,
  PiariumIsolatedSurfaceExtension,
} from "./index.js";
import {
  PIARIUM_WORKSPACE_DOCUMENTS_CAPABILITY,
  PIARIUM_WORKSPACE_LANGUAGE_CAPABILITY,
  PIARIUM_WORKSPACE_DEBUG_CAPABILITY,
  PIARIUM_WORKSPACE_TEST_CAPABILITY,
  PIARIUM_WORKSPACE_TASKS_CAPABILITY,
  createWorkspaceDocumentsClient,
  defineSurfaceMount,
} from "./index.js";

export interface SurfaceConformanceResult {
  activeContributionIds: string[];
  activeServiceIds: string[];
  finalRevision: number;
}

export const runSurfaceExtensionConformance = async (options: {
  activation: SurfaceActivation;
  owner: SurfaceOwnerIdentity;
  runtime: SurfaceExtensionRuntime;
}): Promise<SurfaceConformanceResult> => {
  await options.runtime.activate({ owner: options.owner }, options.activation);
  const active = options.runtime.getSnapshot();
  const activeContributionIds = active.contributions
    .filter((item) => item.owner.extensionId === options.owner.extensionId)
    .map((item) => item.descriptor.id);
  const activeServiceIds = active.services
    .filter((item) => item.owner.extensionId === options.owner.extensionId)
    .map((item) => item.descriptor.id);
  await options.runtime.deactivate({
    ...options.owner,
    desiredRevision: options.owner.desiredRevision + 1,
    generation: options.owner.generation + 1,
  });
  const inactive = options.runtime.getSnapshot();
  if (inactive.contributions.some((item) => item.owner.extensionId === options.owner.extensionId)) {
    throw new Error("Surface extension leaked contributions after deactivation");
  }
  if (inactive.services.some((item) => item.owner.extensionId === options.owner.extensionId)) {
    throw new Error("Surface extension leaked services after deactivation");
  }
  return { activeContributionIds, activeServiceIds, finalRevision: inactive.revision };
};

export interface HostConformanceResult {
  finalStorage: PiariumExtensionStorageSnapshot;
  finalStorages: PiariumExtensionStorageSnapshot[];
  providedServiceIds: string[];
  registeredDisposers: number;
}

export interface IsolatedConformanceResult {
  contributionIds: string[];
  registeredDisposers: number;
}

const asRecord = (value: JsonValue | undefined): JsonObject | null => (
  value && typeof value === "object" && !Array.isArray(value) ? value : null
);

const createConformanceCapabilities = () => {
  const files = new Map<string, { content: string; revision: string }>();
  const providers = new Map<string, JsonObject>();
  const call = async (capability: string, method: string, params: JsonValue): Promise<JsonValue> => {
    if (capability === PIARIUM_WORKSPACE_DOCUMENTS_CAPABILITY) {
      const record = asRecord(params) ?? {};
      const resource = asRecord(record.resource) ?? record;
      const key = `${String(resource.workspaceId ?? "")}\0${String(resource.resourceId ?? "")}`;
      if (method === "read") {
        const file = files.get(key);
        if (!file) return { status: "missing", resource };
        return {
          status: "ready",
          resource,
          revision: file.revision,
          content: file.content,
          encoding: "utf-8",
          bom: false,
          byteLength: file.content.length,
        };
      }
      if (method === "write") {
        const current = files.get(key);
        if (record.expectedRevision !== undefined && record.expectedRevision !== null && current?.revision !== record.expectedRevision) {
          return {
            status: "conflict",
            current: current
              ? { status: "ready", resource, revision: current.revision, encoding: "utf-8", bom: false, byteLength: current.content.length }
              : { status: "missing", resource },
          };
        }
        const revision = `c${files.size + 1}`;
        const content = typeof record.content === "string" ? record.content : "";
        files.set(key, { content, revision });
        return { status: "written", revision, byteLength: content.length };
      }
    }
    if (capability === PIARIUM_WORKSPACE_LANGUAGE_CAPABILITY) {
      const record = asRecord(params) ?? {};
      if (method === "registerProvider") {
        const providerId = String(record.providerId ?? "");
        providers.set(providerId, record);
        return { status: "registered", providerId };
      }
      if (method === "getStatus") return { status: providers.size > 0 ? "ready" : "absent" };
      if (method === "disposeWorkspace") {
        providers.clear();
        return { status: "disposed" };
      }
    }
    if (capability === PIARIUM_WORKSPACE_TASKS_CAPABILITY) {
      if (method === "list") return { status: "empty", configurations: [] };
      if (method === "run") return { status: "running" };
      if (method === "disposeWorkspace") return { status: "disposed" };
    }
    if (capability === PIARIUM_WORKSPACE_DEBUG_CAPABILITY) {
      const record = asRecord(params) ?? {};
      if (method === "registerAdapter") return { status: "registered", adapterId: String(record.adapterId ?? "") };
      if (method === "unregisterAdapter") return { status: "unregistered", adapterId: String(record.adapterId ?? "") };
      if (method === "getStatus") return { status: "absent" };
    }
    if (capability === PIARIUM_WORKSPACE_TEST_CAPABILITY) {
      const record = asRecord(params) ?? {};
      if (method === "registerProvider") return { status: "registered", providerId: String(record.providerId ?? "") };
      if (method === "unregisterProvider") return { status: "unregistered", providerId: String(record.providerId ?? "") };
      if (method === "discover") return { status: "empty", tests: [] };
    }
    throw new Error(`Conformance capability is not provided: ${capability}.${method}`);
  };
  return { call, files, providers };
};

export const runIsolatedExtensionConformance = async (options: {
  activation: PiariumIsolatedSurfaceExtension["activate"];
  grantedCapabilities?: readonly string[];
}): Promise<IsolatedConformanceResult> => {
  const controller = new AbortController();
  const contributions = new Map<string, PiariumExtensionStaticContribution>();
  const disposers: Array<() => void | Promise<void>> = [];
  const grantedCapabilities = new Set(options.grantedCapabilities ?? []);
  const capabilities = createConformanceCapabilities();
  const emptyIntegrity = `sha256-${"0".repeat(64)}`;
  const returned = await options.activation({
    assets: {
      read: async (path): Promise<PiariumExtensionAssetPayload> => ({
        artifactIntegrity: emptyIntegrity,
        bytesBase64: "",
        contentType: "application/octet-stream",
        integrity: emptyIntegrity,
        path,
      }),
    },
    capabilities: {
      call: async (capability, method, params) => {
        if (!grantedCapabilities.has(capability)) {
          throw new Error(`Conformance capability is not provided: ${capability}.${method}`);
        }
        return capabilities.call(capability, method, params);
      },
      has: (capability) => grantedCapabilities.has(capability),
    },
    contribute: (descriptor) => {
      if (contributions.has(descriptor.id)) throw new Error(`Isolated contribution provided more than once: ${descriptor.id}`);
      contributions.set(descriptor.id, descriptor);
    },
    effect: (disposer) => { disposers.push(disposer); },
    services: {
      use: (id, version) => new Proxy({}, {
        get: (_target, property) => property === "then" || typeof property !== "string"
          ? undefined
          : () => { throw new Error(`Conformance dependency is not provided: ${id}@${version}.${property}`); },
      }) as never,
    },
    signal: controller.signal,
  });
  if (typeof returned === "function") disposers.push(returned);
  const contributionIds = [...contributions.keys()].sort();
  const registeredDisposers = disposers.length;
  controller.abort("Isolated extension conformance deactivation");
  const cleanupErrors: string[] = [];
  while (disposers.length > 0) {
    try { await disposers.pop()?.(); }
    catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
  }
  contributions.clear();
  if (cleanupErrors.length > 0) throw new Error(`Isolated extension cleanup failed: ${cleanupErrors.join("; ")}`);
  return { contributionIds, registeredDisposers };
};

export const runHostExtensionConformance = async (options: {
  activation: PiariumBrokeredHostExtension["activate"];
  extensionId: string;
  initialData?: JsonObject;
  storageSchemaVersion?: number;
}): Promise<HostConformanceResult> => {
  const controller = new AbortController();
  const disposers: Array<() => void | Promise<void>> = [];
  const services = new Map<string, PiariumHostServiceHandler>();
  const storageKey = (request: Pick<PiariumExtensionStorageOpenRequest, "key" | "scope">): string => (
    `${request.scope}\0${request.key}`
  );
  const createStorage = (request: PiariumExtensionStorageOpenRequest): PiariumExtensionStorageSnapshot => ({
    address: { extensionId: options.extensionId, key: request.key, scope: request.scope },
    authoritative: true,
    diagnostics: [],
    document: {
      data: structuredClone(options.initialData ?? {}),
      revision: 0,
      schemaVersion: request.schemaVersion ?? options.storageSchemaVersion ?? 1,
      updatedAt: new Date(0).toISOString(),
    },
    exists: options.initialData !== undefined,
    storageState: options.initialData === undefined ? "missing" : "ready",
  });
  const storages = new Map<string, PiariumExtensionStorageSnapshot>();
  storages.set(storageKey({ key: "state", scope: "application" }), createStorage({
    key: "state",
    schemaVersion: options.storageSchemaVersion ?? 1,
    scope: "application",
  }));
  const storageClient = (request: PiariumExtensionStorageOpenRequest) => {
    const key = storageKey(request);
    if (!storages.has(key)) storages.set(key, createStorage(request));
    return {
      get snapshot() { return structuredClone(storages.get(key) as PiariumExtensionStorageSnapshot); },
      refresh: async () => structuredClone(storages.get(key) as PiariumExtensionStorageSnapshot),
      update: async (data: JsonObject, expectedRevision?: number) => {
        const current = storages.get(key) as PiariumExtensionStorageSnapshot;
        const revision = expectedRevision ?? current.document.revision;
        if (revision !== current.document.revision) {
          throw new Error(`Conformance storage revision conflict: expected ${revision}, current ${current.document.revision}`);
        }
        const next: PiariumExtensionStorageSnapshot = {
          ...current,
          document: {
            ...current.document,
            data: structuredClone(data),
            revision: current.document.revision + 1,
            schemaVersion: request.schemaVersion ?? current.document.schemaVersion,
            updatedAt: new Date().toISOString(),
          },
          exists: true,
          storageState: "ready",
        };
        storages.set(key, next);
        return structuredClone(next);
      },
    };
  };
  const defaultStorage = storageClient({
    key: "state",
    schemaVersion: options.storageSchemaVersion ?? 1,
    scope: "application",
  });
  const capabilities = createConformanceCapabilities();
  const context: PiariumBrokeredHostContext = {
    capabilities: {
      call: (capability, method, params) => capabilities.call(capability, method, params),
    },
    effect: (disposer) => { disposers.push(disposer); },
    services: {
      provide: (descriptor: PiariumExtensionServiceProvision, handler: PiariumHostServiceHandler) => {
        const key = `${descriptor.id}@${descriptor.version}`;
        if (services.has(key)) throw new Error(`Host service provided more than once: ${key}`);
        services.set(key, handler);
      },
      use: (id, version) => ({
        call: async (method: string) => {
          throw new Error(`Conformance dependency is not provided: ${id}@${version}.${method}`);
        },
      }),
    },
    signal: controller.signal,
    storage: {
      get snapshot() { return defaultStorage.snapshot; },
      open: async (request) => storageClient(request),
      refresh: () => defaultStorage.refresh(),
      update: (data, expectedRevision) => defaultStorage.update(data, expectedRevision),
    },
  };
  const returned = await options.activation(context);
  if (typeof returned === "function") disposers.push(returned);
  const providedServiceIds = [...services.keys()].sort();
  const registeredDisposers = disposers.length;
  controller.abort("Host extension conformance deactivation");
  const cleanupErrors: string[] = [];
  while (disposers.length > 0) {
    try { await disposers.pop()?.(); }
    catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
  }
  services.clear();
  if (cleanupErrors.length > 0) throw new Error(`Host extension cleanup failed: ${cleanupErrors.join("; ")}`);
  return {
    finalStorage: defaultStorage.snapshot,
    finalStorages: [...storages.values()].map((snapshot) => structuredClone(snapshot)),
    providedServiceIds,
    registeredDisposers,
  };
};

export interface SurfaceMountConformanceResult {
  aborted: boolean;
  disposed: boolean;
  mounted: boolean;
}

export const runSurfaceMountConformance = async (): Promise<SurfaceMountConformanceResult> => {
  const controller = new AbortController();
  const container = { textContent: "" } as HTMLElement;
  let disposed = false;
  const implementation = defineSurfaceMount(async (element, context) => {
    await Promise.resolve();
    if (context.signal.aborted) return;
    element.textContent = "ready";
    return () => {
      disposed = true;
      element.textContent = "";
    };
  });
  const cleanup = await implementation.mount(container, {
    contributionId: "dev.example.mount.shell",
    owner: {
      desiredRevision: 1,
      entrypointId: "main",
      extensionId: "dev.example.mount",
      extensionVersion: "1.0.0",
      generation: 1,
      hostId: "72694a4f-093a-4f79-8763-3ca9f06b7078",
      realmId: "mount-conformance",
    },
    props: {},
    reportError: (error) => { throw error; },
    signal: controller.signal,
  });
  const mounted = container.textContent === "ready";
  controller.abort("runtime-switch");
  if (typeof cleanup === "function") await cleanup();
  return { aborted: controller.signal.aborted, disposed, mounted };
};

export interface WorkbenchProfileConformanceResult {
  afterSwitch: string;
  beforeSwitch: string;
  desiredEnabledUnchanged: boolean;
  failedCandidateKeepsPrevious: boolean;
}

export const runWorkbenchProfileConformance = (): WorkbenchProfileConformanceResult => {
  const document = defaultPiariumWorkbenchProfileDocument();
  document.profiles.push({ id: "studio", label: "Studio" });
  document.layouts.push({
    profileId: "studio",
    references: [],
    replacementSelections: { [PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell]: "dev.example.studio.shell" },
    scope: "distribution",
    scopeId: "studio",
    surface: "web",
  });
  const extensions = [{
    actual: [],
    capabilityGrants: [],
    desired: { enabled: true, revision: 1, updatedAt: "2026-08-20T00:00:00.000Z" },
    installedAt: "2026-08-20T00:00:00.000Z",
    manifest: {
      engines: { piarium: "*" },
      id: "dev.example.studio",
      schemaVersion: 1 as const,
      version: "1.0.0",
      contributions: [{
        contractVersion: 1,
        data: {},
        id: "dev.example.studio.shell",
        kind: "shell" as const,
        replacement: { target: PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell },
        supports: ["web" as const],
      }],
    },
    resolvedVersion: "1.0.0",
    selectedVersion: "1.0.0",
    source: { display: "Studio", kind: "local" as const },
    updatedAt: "2026-08-20T00:00:00.000Z",
  }];
  const before = resolvePiariumWorkbenchProfile(document, extensions, { surface: "web", userId: "default" });
  document.profileSelections.users.default = "studio";
  const after = resolvePiariumWorkbenchProfile(document, extensions, { surface: "web", userId: "default" });
  const failed = inspectPiariumWorkbenchShell(
    after.layout.replacementSelections,
    [{ ...extensions[0]!, desired: { ...extensions[0]!.desired, enabled: false } }],
    "web",
  );
  return {
    beforeSwitch: before.profileId,
    afterSwitch: after.profileId,
    desiredEnabledUnchanged: extensions[0]?.desired.enabled === true,
    failedCandidateKeepsPrevious: failed.status === "disabled",
  };
};

export const runIsolatedDocumentConflictConformance = async (): Promise<{ status: string }> => {
  let status = "missing";
  await runIsolatedExtensionConformance({
    grantedCapabilities: [PIARIUM_WORKSPACE_DOCUMENTS_CAPABILITY],
    activation: async (context) => {
      const documents = createWorkspaceDocumentsClient(context.capabilities);
      const resource = { workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", resourceId: "note.txt" };
      await documents.write({ resource, content: "one", encoding: "utf-8", bom: false, expectedRevision: null, operationId: "op-1" });
      const conflict = await documents.write({
        resource,
        content: "two",
        encoding: "utf-8",
        bom: false,
        expectedRevision: "stale",
        operationId: "op-2",
      }) as { status?: string };
      status = conflict.status ?? "missing";
    },
  });
  return { status };
};
