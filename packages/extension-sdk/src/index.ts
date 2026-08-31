import type {
  SurfaceActivationContext,
  SurfaceOwnerIdentity,
} from "@piarium/extension-surface";
import type {
  JsonObject,
  JsonValue,
  PiariumEditorDocumentController,
  PiariumEditorMonacoClearDecorationsRequestV1,
  PiariumEditorMonacoExecuteActionRequestV1,
  PiariumEditorMonacoOperationResultV1,
  PiariumEditorMonacoRevealRequestV1,
  PiariumEditorMonacoServiceV1,
  PiariumEditorMonacoSetDecorationsRequestV1,
  PiariumEditorMonacoSetSelectionRequestV1,
  PiariumEditorMonacoStateResultV1,
  PiariumEditorMonacoViewRequestV1,
  PiariumEditorMonacoViewResultV1,
  PiariumEditorMonacoWaitForStateRequestV1,
  PiariumExtensionAssetPayload,
  PiariumExtensionContributionKind,
  PiariumExtensionServiceProvision,
  PiariumExtensionServiceRoutingContext,
  PiariumExtensionStaticContribution,
  PiariumExtensionStorageOpenRequest,
  PiariumExtensionStorageSnapshot,
  PiariumTransitionSceneAnimatedPhase,
  PiariumTransitionSceneFrameV1,
} from "@piarium/extension-contract";
import {
  PIARIUM_EDITOR_MONACO_SERVICE_ID,
  PIARIUM_EDITOR_MONACO_SERVICE_VERSION,
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

export interface PiariumEditorMountProps {
  document: PiariumEditorDocumentController;
  providerId: string;
  resource: { resourceId: string; workspaceId: string };
  viewId: string;
}

/**
 * Stable per-transition external store. Piarium owns the handoff transaction; a scene owns only its
 * rendering and may complete the current animated phase before its declared duration elapses.
 */
export interface PiariumTransitionSceneControllerV1 {
  complete(transitionId: number, phase: PiariumTransitionSceneAnimatedPhase): void;
  getSnapshot(): PiariumTransitionSceneFrameV1;
  subscribe(listener: () => void): () => void;
}

export interface PiariumTransitionSceneMountProps {
  transition: PiariumTransitionSceneControllerV1;
}

export interface PiariumIsolatedTransitionSceneFrameMessage {
  contributionId: string;
  frame: PiariumTransitionSceneFrameV1;
  type: "motion.transition.frame";
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
  call(
    id: string,
    version: number,
    method: string,
    args: JsonValue[],
    providerId?: string,
  ): Promise<JsonValue>;
  has(id: string, version: number, providerId?: string): Promise<boolean>;
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

export interface PiariumEditorMonacoClientV1 {
  clearDecorations(request: PiariumEditorMonacoClearDecorationsRequestV1): Promise<PiariumEditorMonacoOperationResultV1>;
  executeAction(request: PiariumEditorMonacoExecuteActionRequestV1): Promise<PiariumEditorMonacoOperationResultV1>;
  focus(request?: PiariumEditorMonacoViewRequestV1): Promise<PiariumEditorMonacoOperationResultV1>;
  getActiveView(): Promise<PiariumEditorMonacoViewResultV1>;
  getState(): Promise<PiariumEditorMonacoStateResultV1>;
  getView(request?: PiariumEditorMonacoViewRequestV1): Promise<PiariumEditorMonacoViewResultV1>;
  reveal(request: PiariumEditorMonacoRevealRequestV1): Promise<PiariumEditorMonacoOperationResultV1>;
  setDecorations(request: PiariumEditorMonacoSetDecorationsRequestV1): Promise<PiariumEditorMonacoOperationResultV1>;
  setSelection(request: PiariumEditorMonacoSetSelectionRequestV1): Promise<PiariumEditorMonacoOperationResultV1>;
  waitForState(request: PiariumEditorMonacoWaitForStateRequestV1): Promise<PiariumEditorMonacoStateResultV1>;
}

type PiariumEditorMonacoServiceContext =
  | Pick<PiariumManagedSurfaceContext, "useService">
  | Pick<PiariumIsolatedSurfaceContext, "services">;

const monacoServiceAbsent = (): PiariumEditorMonacoOperationResultV1 => ({
  reason: "provider-inactive",
  status: "absent",
});

/**
 * Resolve the owner-bound optional Monaco service injected by the Surface runtime. The extension does
 * not provide an owner identity; managed and isolated callers receive the same serialized subset.
 */
export const createPiariumEditorMonacoClient = (
  context: PiariumEditorMonacoServiceContext,
): PiariumEditorMonacoClientV1 => {
  const invoke = async <TResult extends PiariumEditorMonacoOperationResultV1 | PiariumEditorMonacoStateResultV1>(
    method: keyof PiariumEditorMonacoServiceV1,
    args: JsonValue[],
  ): Promise<TResult> => {
    if ("useService" in context) {
      const service = context.useService<PiariumEditorMonacoServiceV1>(
        PIARIUM_EDITOR_MONACO_SERVICE_ID,
        PIARIUM_EDITOR_MONACO_SERVICE_VERSION,
      );
      if (!service) return monacoServiceAbsent() as TResult;
      const handler = service[method] as (...values: unknown[]) => unknown;
      if (typeof handler !== "function") {
        return { reason: "operation-unavailable", status: "unsupported" } as TResult;
      }
      return await Promise.resolve(handler(...args)) as TResult;
    }
    const available = await context.services.has(
      PIARIUM_EDITOR_MONACO_SERVICE_ID,
      PIARIUM_EDITOR_MONACO_SERVICE_VERSION,
    );
    if (!available) return monacoServiceAbsent() as TResult;
    return await context.services.call(
      PIARIUM_EDITOR_MONACO_SERVICE_ID,
      PIARIUM_EDITOR_MONACO_SERVICE_VERSION,
      method,
      args,
    ) as TResult;
  };
  const requestArgs = (request: object | undefined): JsonValue[] => request === undefined
    ? []
    : [request as unknown as JsonValue];
  return {
    clearDecorations: (request) => invoke("clearDecorations", requestArgs(request)),
    executeAction: (request) => invoke("executeAction", requestArgs(request)),
    focus: (request) => invoke("focus", requestArgs(request)),
    getActiveView: () => invoke<PiariumEditorMonacoViewResultV1>("getActiveView", []),
    getState: () => invoke<PiariumEditorMonacoStateResultV1>("getState", []),
    getView: (request) => invoke<PiariumEditorMonacoViewResultV1>("getView", requestArgs(request)),
    reveal: (request) => invoke("reveal", requestArgs(request)),
    setDecorations: (request) => invoke("setDecorations", requestArgs(request)),
    setSelection: (request) => invoke("setSelection", requestArgs(request)),
    waitForState: (request) => invoke<PiariumEditorMonacoStateResultV1>("waitForState", requestArgs(request)),
  };
};

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
export const PIARIUM_WORKSPACE_RECOVERY_PRIMITIVES_CAPABILITY = "workspace.recovery-primitives";

export {
  PIARIUM_EDITOR_MONACO_SERVICE_ID,
  PIARIUM_EDITOR_MONACO_SERVICE_VERSION,
  PIARIUM_TRANSITION_SCENE_CONTRACT_VERSION,
  PIARIUM_TRANSITION_SCENE_DATA_CONTRACT,
  PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE,
  PIARIUM_WORKBENCH_CONTEXT_KEYS,
  PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID,
  PIARIUM_WORKBENCH_IDE_PROFILE_ID,
  PIARIUM_WORKBENCH_REPLACEMENT_TARGETS,
  PIARIUM_WORKBENCH_SLOTS,
} from "@piarium/extension-contract";

export type {
  PiariumEditorDocumentApplyEditsResult,
  PiariumEditorDocumentController,
  PiariumEditorDocumentEdit,
  PiariumEditorDocumentSnapshot,
  PiariumEditorDocumentUpdateResult,
  PiariumEditorMonacoAbsentReasonV1,
  PiariumEditorMonacoClearDecorationsRequestV1,
  PiariumEditorMonacoDecorationV1,
  PiariumEditorMonacoExecuteActionRequestV1,
  PiariumEditorMonacoFailureResultV1,
  PiariumEditorMonacoOperationResultV1,
  PiariumEditorMonacoPositionV1,
  PiariumEditorMonacoRangeV1,
  PiariumEditorMonacoRevealRequestV1,
  PiariumEditorMonacoSelectionV1,
  PiariumEditorMonacoServiceV1,
  PiariumEditorMonacoSetDecorationsRequestV1,
  PiariumEditorMonacoSetSelectionRequestV1,
  PiariumEditorMonacoStateResultV1,
  PiariumEditorMonacoStateSnapshotV1,
  PiariumEditorMonacoStaleReasonV1,
  PiariumEditorMonacoUnsupportedReasonV1,
  PiariumEditorMonacoViewRequestV1,
  PiariumEditorMonacoViewResultV1,
  PiariumEditorMonacoViewSnapshotV1,
  PiariumEditorMonacoWaitForStateRequestV1,
  PiariumTransitionSceneAnimatedPhase,
  PiariumTransitionSceneContributionDataV1,
  PiariumTransitionSceneDirection,
  PiariumTransitionSceneDurationSet,
  PiariumTransitionSceneFrameV1,
  PiariumTransitionSceneId,
  PiariumTransitionScenePhase,
  PiariumTransitionScenePhaseDurations,
  PiariumTransitionSceneTempo,
} from "@piarium/extension-contract";

export const defineShellMount = defineSurfaceMount;
export const defineViewMount = defineSurfaceMount;

// ---------------------------------------------------------------------------
// Shell composition host API
//
// A managed Shell can mount child contributions (replacements and slots) via
// the composition host. This is the public, framework-neutral API for
// external Shells that need to compose sub-regions without importing
// @piarium/ui private modules.
// ---------------------------------------------------------------------------

export interface PiariumWorkbenchChildMount {
  dispose(reason?: unknown): Promise<void>;
}

export interface PiariumWorkbenchCompositionHost {
  mountReplacement(options: {
    container: HTMLElement;
    target: string;
    props?: JsonObject;
  }): Promise<PiariumWorkbenchChildMount>;

  mountSlot(options: {
    container: HTMLElement;
    slot: string;
    kind?: PiariumExtensionContributionKind;
    props?: JsonObject;
  }): Promise<PiariumWorkbenchChildMount>;
}

export interface PiariumShellMountContext<TProps extends object = Record<string, unknown>>
  extends PiariumSurfaceMountContext<TProps> {
  readonly workbench: PiariumWorkbenchCompositionHost;
}
export const defineTransitionSceneMount = (
  implementation:
    | PiariumSurfaceMount<PiariumTransitionSceneMountProps>
    | PiariumSurfaceMountImplementation<PiariumTransitionSceneMountProps>,
): PiariumSurfaceMountImplementation<PiariumTransitionSceneMountProps> => defineSurfaceMount(implementation);
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

export const callWorkspaceRecoveryPrimitives = (
  capabilities: PiariumIsolatedCapabilityClient | PiariumHostCapabilityClient,
  method: string,
  params: JsonValue,
): Promise<JsonValue> => capabilities.call(PIARIUM_WORKSPACE_RECOVERY_PRIMITIVES_CAPABILITY, method, params);

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
  initializationOptions?: JsonObject;
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
  if (descriptor.initializationOptions) params.initializationOptions = structuredClone(descriptor.initializationOptions);
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
