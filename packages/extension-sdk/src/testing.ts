import {
  SurfaceExtensionRuntime,
  type SurfaceActivation,
  type SurfaceOwnerIdentity,
} from "@piarium/extension-surface";
import type {
  JsonObject,
  PiariumExtensionAssetPayload,
  PiariumExtensionServiceProvision,
  PiariumExtensionStaticContribution,
  PiariumExtensionStorageOpenRequest,
  PiariumExtensionStorageSnapshot,
} from "@piarium/extension-contract";
import type {
  PiariumBrokeredHostContext,
  PiariumBrokeredHostExtension,
  PiariumHostServiceHandler,
  PiariumIsolatedSurfaceExtension,
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

export const runIsolatedExtensionConformance = async (options: {
  activation: PiariumIsolatedSurfaceExtension["activate"];
  grantedCapabilities?: readonly string[];
}): Promise<IsolatedConformanceResult> => {
  const controller = new AbortController();
  const contributions = new Map<string, PiariumExtensionStaticContribution>();
  const disposers: Array<() => void | Promise<void>> = [];
  const grantedCapabilities = new Set(options.grantedCapabilities ?? []);
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
      call: async (capability, method) => {
        throw new Error(`Conformance capability is not provided: ${capability}.${method}`);
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
  const context: PiariumBrokeredHostContext = {
    capabilities: {
      call: async (capability, method) => {
        throw new Error(`Conformance capability is not provided: ${capability}.${method}`);
      },
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
