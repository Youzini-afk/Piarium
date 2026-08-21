import type {
  SurfaceActivationContext,
  SurfaceOwnerIdentity,
} from "@piarium/extension-surface";
import type {
  JsonObject,
  JsonValue,
  PiariumExtensionAssetPayload,
  PiariumExtensionServiceProvision,
  PiariumExtensionServiceRoutingContext,
  PiariumExtensionStaticContribution,
  PiariumExtensionStorageOpenRequest,
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

export type PiariumSurfaceMountDisposer = () => void | Promise<void>;

/**
 * Per-mount state supplied by a Piarium Surface host. The signal belongs to this
 * mounted view, so it is aborted for prop changes as well as owner teardown.
 */
export interface PiariumSurfaceMountContext<TProps extends object = Record<string, unknown>> {
  readonly contributionId: string;
  readonly owner: Readonly<SurfaceOwnerIdentity>;
  readonly props: Readonly<TProps>;
  reportError(error: unknown): void;
  readonly signal: AbortSignal;
}

export interface PiariumEditorDocumentSnapshot {
  baseRevision: string | null;
  content: string;
  dirty: boolean;
  documentVersion: number;
  errorMessage?: string;
  saving: boolean;
  status: "binary" | "conflict" | "deleted" | "error" | "missing" | "ready" | "unsupported-encoding";
}

export type PiariumEditorDocumentUpdateResult =
  | { status: "updated"; snapshot: PiariumEditorDocumentSnapshot }
  | { status: "conflict"; snapshot: PiariumEditorDocumentSnapshot };

export interface PiariumEditorDocumentController {
  getSnapshot(): PiariumEditorDocumentSnapshot;
  replaceContent(content: string, expectedDocumentVersion: number): Promise<PiariumEditorDocumentUpdateResult>;
  save(expectedDocumentVersion: number): Promise<PiariumEditorDocumentUpdateResult>;
  subscribe(listener: () => void): () => void;
}

export interface PiariumEditorMountProps {
  document: PiariumEditorDocumentController;
  providerId: string;
  resource: { resourceId: string; workspaceId: string };
  viewId: string;
}

export interface PiariumIsolatedEditorMountMessage {
  contributionId: string;
  props: {
    providerId: string;
    resource: { resourceId: string; workspaceId: string };
    viewId: string;
  };
  type: "workbench.mount";
}

/** Framework-neutral runtime implementation for a DOM-backed contribution. */
export interface PiariumSurfaceMountImplementation<TProps extends object = Record<string, unknown>> {
  mount(
    container: HTMLElement,
    context: PiariumSurfaceMountContext<TProps>,
  ): void | PiariumSurfaceMountDisposer | Promise<void | PiariumSurfaceMountDisposer>;
}

export type PiariumSurfaceMount<TProps extends object = Record<string, unknown>> =
  PiariumSurfaceMountImplementation<TProps>["mount"];

export const defineSurfaceMount = <TProps extends object = Record<string, unknown>>(
  implementation: PiariumSurfaceMount<TProps> | PiariumSurfaceMountImplementation<TProps>,
): PiariumSurfaceMountImplementation<TProps> => typeof implementation === "function"
  ? { mount: implementation }
  : implementation;

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

export interface PiariumHostStorageDocumentClient {
  readonly snapshot: PiariumExtensionStorageSnapshot;
  refresh(): Promise<PiariumExtensionStorageSnapshot>;
  update(data: JsonObject, expectedRevision?: number): Promise<PiariumExtensionStorageSnapshot>;
}

export interface PiariumHostStorageClient extends PiariumHostStorageDocumentClient {
  open(request: PiariumExtensionStorageOpenRequest): Promise<PiariumHostStorageDocumentClient>;
}

export interface PiariumHostAssets {
  /** Resolve a forward-slash package-relative file to its immutable local path. */
  path(logicalPath: string): string;
}

export interface PiariumBrokeredHostContext {
  readonly assets: PiariumHostAssets;
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

export const PIARIUM_WORKSPACE_DOCUMENTS_CAPABILITY = "workspace.documents";
export const PIARIUM_WORKSPACE_SEARCH_CAPABILITY = "workspace.search";
export const PIARIUM_WORKSPACE_LANGUAGE_CAPABILITY = "workspace.language";
export const PIARIUM_WORKSPACE_TASKS_CAPABILITY = "workspace.tasks";
export const PIARIUM_WORKSPACE_DEBUG_CAPABILITY = "workspace.debug";
export const PIARIUM_WORKSPACE_TEST_CAPABILITY = "workspace.test";

export {
  PIARIUM_WORKBENCH_CONTEXT_KEYS,
  PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID,
  PIARIUM_WORKBENCH_IDE_PROFILE_ID,
  PIARIUM_WORKBENCH_REPLACEMENT_TARGETS,
  PIARIUM_WORKBENCH_SLOTS,
} from "@piarium/extension-contract";

export const defineShellMount = defineSurfaceMount;
export const defineViewMount = defineSurfaceMount;
export const defineEditorMount = (
  implementation:
    | PiariumSurfaceMount<PiariumEditorMountProps>
    | PiariumSurfaceMountImplementation<PiariumEditorMountProps>,
): PiariumSurfaceMountImplementation<PiariumEditorMountProps> => defineSurfaceMount(implementation);

export const callWorkspaceDocuments = (
  capabilities: PiariumIsolatedCapabilityClient | PiariumHostCapabilityClient,
  method: string,
  params: JsonValue,
): Promise<JsonValue> => capabilities.call(PIARIUM_WORKSPACE_DOCUMENTS_CAPABILITY, method, params);

export const callWorkspaceSearch = (
  capabilities: PiariumIsolatedCapabilityClient | PiariumHostCapabilityClient,
  method: string,
  params: JsonValue,
): Promise<JsonValue> => capabilities.call(PIARIUM_WORKSPACE_SEARCH_CAPABILITY, method, params);

export const callWorkspaceLanguage = (
  capabilities: PiariumIsolatedCapabilityClient | PiariumHostCapabilityClient,
  method: string,
  params: JsonValue,
): Promise<JsonValue> => capabilities.call(PIARIUM_WORKSPACE_LANGUAGE_CAPABILITY, method, params);

export interface PiariumWorkspaceDocumentsClient {
  delete(request: JsonObject): Promise<JsonValue>;
  move(request: JsonObject): Promise<JsonValue>;
  read(resource: JsonObject): Promise<JsonValue>;
  resolveWorkspace(input: JsonObject): Promise<JsonValue>;
  write(request: JsonObject): Promise<JsonValue>;
}

export const createWorkspaceDocumentsClient = (
  capabilities: PiariumIsolatedCapabilityClient | PiariumHostCapabilityClient,
): PiariumWorkspaceDocumentsClient => ({
  resolveWorkspace: (input) => callWorkspaceDocuments(capabilities, "resolveWorkspace", input),
  read: (resource) => callWorkspaceDocuments(capabilities, "read", resource),
  write: (request) => callWorkspaceDocuments(capabilities, "write", request),
  move: (request) => callWorkspaceDocuments(capabilities, "move", request),
  delete: (request) => callWorkspaceDocuments(capabilities, "delete", request),
});

export type PiariumLanguageProviderDescriptor = {
  args?: readonly string[];
  command: string;
  languageIds: readonly string[];
  providerId: string;
  source?: string;
  workspaceId?: string;
};

export type PiariumHostDescriptorFactory<TDescriptor> = (
  context: PiariumBrokeredHostContext,
) => TDescriptor | Promise<TDescriptor>;

export interface PiariumWorkspaceLanguageClient {
  disposeWorkspace(workspaceId: string): Promise<JsonValue>;
  getStatus(workspaceId: string, languageId?: string): Promise<JsonValue>;
  registerProvider(descriptor: PiariumLanguageProviderDescriptor): Promise<JsonValue>;
  unregisterProvider(providerId: string): Promise<JsonValue>;
}

const languageProviderParams = (descriptor: PiariumLanguageProviderDescriptor): JsonObject => {
  const params: JsonObject = {
    command: descriptor.command,
    languageIds: [...descriptor.languageIds],
    providerId: descriptor.providerId,
  };
  if (descriptor.args) params.args = [...descriptor.args];
  if (descriptor.source) params.source = descriptor.source;
  if (descriptor.workspaceId) params.workspaceId = descriptor.workspaceId;
  return params;
};

export const createWorkspaceLanguageClient = (
  capabilities: PiariumIsolatedCapabilityClient | PiariumHostCapabilityClient,
): PiariumWorkspaceLanguageClient => ({
  registerProvider: (descriptor) => callWorkspaceLanguage(capabilities, "registerProvider", languageProviderParams(descriptor)),
  unregisterProvider: (providerId) => callWorkspaceLanguage(capabilities, "unregisterProvider", { providerId }),
  getStatus: (workspaceId, languageId) => callWorkspaceLanguage(capabilities, "getStatus", {
    workspaceId,
    ...(languageId ? { languageId } : {}),
  }),
  disposeWorkspace: (workspaceId) => callWorkspaceLanguage(capabilities, "disposeWorkspace", { workspaceId }),
});

export const defineLanguageProvider = (
  input: PiariumLanguageProviderDescriptor | PiariumHostDescriptorFactory<PiariumLanguageProviderDescriptor>,
): PiariumBrokeredHostExtension => defineHostExtension(async (context) => {
  const descriptor = typeof input === "function" ? await input(context) : input;
  const client = createWorkspaceLanguageClient(context.capabilities);
  await client.registerProvider({
    ...descriptor,
    source: descriptor.source ?? "extension",
  });
  context.effect(async () => { await client.unregisterProvider(descriptor.providerId); });
});

export const callWorkspaceDebug = (
  capabilities: PiariumIsolatedCapabilityClient | PiariumHostCapabilityClient,
  method: string,
  params: JsonValue,
): Promise<JsonValue> => capabilities.call(PIARIUM_WORKSPACE_DEBUG_CAPABILITY, method, params);

export const callWorkspaceTest = (
  capabilities: PiariumIsolatedCapabilityClient | PiariumHostCapabilityClient,
  method: string,
  params: JsonValue,
): Promise<JsonValue> => capabilities.call(PIARIUM_WORKSPACE_TEST_CAPABILITY, method, params);

export const callWorkspaceTasks = (
  capabilities: PiariumIsolatedCapabilityClient | PiariumHostCapabilityClient,
  method: string,
  params: JsonValue,
): Promise<JsonValue> => capabilities.call(PIARIUM_WORKSPACE_TASKS_CAPABILITY, method, params);

export type PiariumDebugAdapterDescriptor = {
  adapterId: string;
  args?: readonly string[];
  command: string;
  languageIds?: readonly string[];
  source?: string;
  workspaceId?: string;
};

export type PiariumTestProviderDescriptor = {
  args?: readonly string[];
  command?: string;
  kind?: string;
  providerId: string;
  source?: string;
  workspaceId?: string;
};

const debugAdapterParams = (descriptor: PiariumDebugAdapterDescriptor): JsonObject => {
  const params: JsonObject = {
    adapterId: descriptor.adapterId,
    command: descriptor.command,
  };
  if (descriptor.args) params.args = [...descriptor.args];
  if (descriptor.languageIds) params.languageIds = [...descriptor.languageIds];
  if (descriptor.source) params.source = descriptor.source;
  if (descriptor.workspaceId) params.workspaceId = descriptor.workspaceId;
  return params;
};

const testProviderParams = (descriptor: PiariumTestProviderDescriptor): JsonObject => {
  const params: JsonObject = { providerId: descriptor.providerId };
  if (descriptor.command) params.command = descriptor.command;
  if (descriptor.args) params.args = [...descriptor.args];
  if (descriptor.kind) params.kind = descriptor.kind;
  if (descriptor.source) params.source = descriptor.source;
  if (descriptor.workspaceId) params.workspaceId = descriptor.workspaceId;
  return params;
};

export interface PiariumWorkspaceDebugClient {
  getStatus(workspaceId: string): Promise<JsonValue>;
  registerAdapter(descriptor: PiariumDebugAdapterDescriptor): Promise<JsonValue>;
  unregisterAdapter(adapterId: string): Promise<JsonValue>;
}

export interface PiariumWorkspaceTestClient {
  discover(workspaceId: string): Promise<JsonValue>;
  registerProvider(descriptor: PiariumTestProviderDescriptor): Promise<JsonValue>;
  unregisterProvider(providerId: string): Promise<JsonValue>;
}

export const createWorkspaceDebugClient = (
  capabilities: PiariumIsolatedCapabilityClient | PiariumHostCapabilityClient,
): PiariumWorkspaceDebugClient => ({
  registerAdapter: (descriptor) => callWorkspaceDebug(capabilities, "registerAdapter", debugAdapterParams(descriptor)),
  unregisterAdapter: (adapterId) => callWorkspaceDebug(capabilities, "unregisterAdapter", { adapterId }),
  getStatus: (workspaceId) => callWorkspaceDebug(capabilities, "getStatus", { workspaceId }),
});

export const createWorkspaceTestClient = (
  capabilities: PiariumIsolatedCapabilityClient | PiariumHostCapabilityClient,
): PiariumWorkspaceTestClient => ({
  registerProvider: (descriptor) => callWorkspaceTest(capabilities, "registerProvider", testProviderParams(descriptor)),
  unregisterProvider: (providerId) => callWorkspaceTest(capabilities, "unregisterProvider", { providerId }),
  discover: (workspaceId) => callWorkspaceTest(capabilities, "discover", { workspaceId }),
});

export const defineDebugAdapter = (
  input: PiariumDebugAdapterDescriptor | PiariumHostDescriptorFactory<PiariumDebugAdapterDescriptor>,
): PiariumBrokeredHostExtension => defineHostExtension(async (context) => {
  const descriptor = typeof input === "function" ? await input(context) : input;
  const client = createWorkspaceDebugClient(context.capabilities);
  await client.registerAdapter({
    ...descriptor,
    source: descriptor.source ?? "extension",
  });
  context.effect(async () => { await client.unregisterAdapter(descriptor.adapterId); });
});

export const defineTestProvider = (
  input: PiariumTestProviderDescriptor | PiariumHostDescriptorFactory<PiariumTestProviderDescriptor>,
): PiariumBrokeredHostExtension => defineHostExtension(async (context) => {
  const descriptor = typeof input === "function" ? await input(context) : input;
  const client = createWorkspaceTestClient(context.capabilities);
  await client.registerProvider({
    ...descriptor,
    source: descriptor.source ?? "extension",
  });
  context.effect(async () => { await client.unregisterProvider(descriptor.providerId); });
});
