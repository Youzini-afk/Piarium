import type { SurfaceActivationContext } from "@piarium/extension-surface";
import type {
  JsonObject,
  JsonValue,
  PiariumExtensionAssetPayload,
  PiariumExtensionServiceProvision,
  PiariumExtensionServiceRoutingContext,
  PiariumExtensionStaticContribution,
  PiariumExtensionStorageSnapshot,
} from "@piarium/extension-contract";

export interface PiariumSurfaceAsset {
  bytes: Uint8Array;
  contentType: string;
  integrity: string;
  path: string;
}

export interface PiariumSurfaceAssets {
  read(path: string): Promise<PiariumSurfaceAsset>;
  url(path: string): Promise<string>;
}

export interface PiariumSurfaceStyles {
  use(path: string): Promise<void>;
}

export interface PiariumManagedSurfaceContext extends SurfaceActivationContext {
  readonly assets: PiariumSurfaceAssets;
  readonly styles: PiariumSurfaceStyles;
}

export type PiariumManagedSurfaceActivation = (
  context: PiariumManagedSurfaceContext,
) => void | Promise<void>;

export interface PiariumManagedSurfaceExtension {
  activate: PiariumManagedSurfaceActivation;
}

export type PiariumManagedSurfaceModule = {
  activate?: PiariumManagedSurfaceActivation;
  default?: PiariumManagedSurfaceActivation | PiariumManagedSurfaceExtension;
};

export const defineSurfaceExtension = (
  extension: PiariumManagedSurfaceActivation | PiariumManagedSurfaceExtension,
): PiariumManagedSurfaceExtension => (
  typeof extension === "function" ? { activate: extension } : extension
);

export const resolveSurfaceExtensionModule = (
  module: PiariumManagedSurfaceModule,
): PiariumManagedSurfaceExtension => {
  const candidate = module.default ?? module;
  if (typeof candidate === "function") return { activate: candidate };
  if (candidate && typeof candidate === "object" && typeof candidate.activate === "function") {
    return { activate: candidate.activate.bind(candidate) };
  }
  throw new Error("Managed Piarium Surface module must export activate or a default extension definition");
};

export interface PiariumIsolatedCapabilityClient {
  call(capability: string, method: string, params: JsonValue): Promise<JsonValue>;
  has(capability: string): boolean;
}

export interface PiariumIsolatedServiceClient {
  use<TImplementation = unknown>(id: string, version: number, providerId?: string): TImplementation;
}

export interface PiariumIsolatedSurfaceContext {
  readonly assets: {
    read(path: string): Promise<PiariumExtensionAssetPayload>;
  };
  readonly capabilities: PiariumIsolatedCapabilityClient;
  contribute(descriptor: PiariumExtensionStaticContribution, options?: { viewId?: string }): void;
  effect(disposer: () => void | Promise<void>): void;
  readonly services: PiariumIsolatedServiceClient;
  readonly signal: AbortSignal;
}

export type PiariumIsolatedSurfaceActivation = (
  context: PiariumIsolatedSurfaceContext,
) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;

export interface PiariumIsolatedSurfaceExtension {
  activate: PiariumIsolatedSurfaceActivation;
}

export type PiariumIsolatedSurfaceModule = {
  activate?: PiariumIsolatedSurfaceActivation;
  default?: PiariumIsolatedSurfaceActivation | PiariumIsolatedSurfaceExtension;
};

export const defineIsolatedExtension = (
  extension: PiariumIsolatedSurfaceActivation | PiariumIsolatedSurfaceExtension,
): PiariumIsolatedSurfaceExtension => typeof extension === "function" ? { activate: extension } : extension;

export const resolveIsolatedExtensionModule = (
  module: PiariumIsolatedSurfaceModule,
): PiariumIsolatedSurfaceExtension => {
  const candidate = module.default ?? module;
  if (typeof candidate === "function") return { activate: candidate };
  if (candidate && typeof candidate === "object" && typeof candidate.activate === "function") {
    return { activate: candidate.activate.bind(candidate) };
  }
  throw new Error("Isolated Piarium Surface module must export activate or a default extension definition");
};

export interface PiariumHostCapabilityClient {
  call(capability: string, method: string, params: JsonValue): Promise<JsonValue>;
}

export interface PiariumHostServiceClient {
  call(method: string, ...args: JsonValue[]): Promise<JsonValue>;
}

export interface PiariumHostServiceUseOptions {
  providerId?: string;
  routing?: PiariumExtensionServiceRoutingContext;
}

export type PiariumHostServiceHandler = Record<string, (...args: JsonValue[]) => JsonValue | Promise<JsonValue>>;

export interface PiariumHostStorageClient {
  readonly snapshot: PiariumExtensionStorageSnapshot;
  update(data: JsonObject, expectedRevision?: number): Promise<PiariumExtensionStorageSnapshot>;
}

export interface PiariumBrokeredHostContext {
  readonly capabilities: PiariumHostCapabilityClient;
  effect(disposer: () => void | Promise<void>): void;
  readonly services: {
    provide(descriptor: PiariumExtensionServiceProvision, handler: PiariumHostServiceHandler): void;
    use(id: string, version: number, provider?: string | PiariumHostServiceUseOptions): PiariumHostServiceClient;
  };
  readonly signal: AbortSignal;
  readonly storage: PiariumHostStorageClient;
}

export interface PiariumExtensionMigrationInput {
  data: JsonObject;
  fromSchemaVersion: number;
  toSchemaVersion: number;
}

export interface PiariumBrokeredHostExtension {
  activate(context: PiariumBrokeredHostContext): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
  migrate?(input: PiariumExtensionMigrationInput): JsonObject | Promise<JsonObject>;
}

export type PiariumBrokeredHostModule = {
  activate?: PiariumBrokeredHostExtension["activate"];
  default?: PiariumBrokeredHostExtension | PiariumBrokeredHostExtension["activate"];
  migrate?: PiariumBrokeredHostExtension["migrate"];
};

export const defineHostExtension = (
  extension: PiariumBrokeredHostExtension | PiariumBrokeredHostExtension["activate"],
): PiariumBrokeredHostExtension => typeof extension === "function" ? { activate: extension } : extension;

export const resolveHostExtensionModule = (
  module: PiariumBrokeredHostModule,
): PiariumBrokeredHostExtension => {
  const candidate = module.default ?? module;
  if (typeof candidate === "function") return { activate: candidate, ...(module.migrate ? { migrate: module.migrate } : {}) };
  if (candidate && typeof candidate === "object" && typeof candidate.activate === "function") {
    const migrate = candidate.migrate?.bind(candidate) ?? module.migrate;
    return {
      activate: candidate.activate.bind(candidate),
      ...(migrate ? { migrate } : {}),
    };
  }
  throw new Error("Brokered Piarium Host module must export activate or a default extension definition");
};
