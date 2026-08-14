import {
  parsePiariumExtensionAssetPayload,
  parsePiariumExtensionCatalogAvailability,
  parsePiariumExtensionCatalogSnapshot,
  parsePiariumExtensionCandidatePreparationResult,
  parsePiariumExtensionHostStateSnapshot,
  parsePiariumExtensionManagedEntrypointPayload,
  type PiariumApplicationSurface,
  type PiariumExtensionActualState,
  type PiariumExtensionAssetPayload,
  type PiariumExtensionAssetRequest,
  type PiariumExtensionCandidateSelectionRequest,
  type PiariumExtensionCapabilityGrant,
  type PiariumExtensionCandidatePreparationResult,
  type PiariumExtensionCatalogAvailability,
  type PiariumExtensionCatalogEntry,
  type PiariumExtensionCatalogSnapshot,
  type PiariumExtensionDiagnostic,
  type PiariumExtensionManagedEntrypointPayload,
  type PiariumExtensionManagedEntrypointRequest,
  type PiariumExtensionManifest,
  type PiariumExtensionHostStateSnapshot,
  type PiariumExtensionHostStateWaitRequest,
  type PiariumExtensionSurfaceEntrypoint,
  type PiariumExtensionServiceInvocationRequest,
  type PiariumExtensionServiceProviderSnapshot,
  type JsonValue,
} from "@piarium/extension-contract";
import {
  resolveSurfaceExtensionModule,
  type PiariumManagedSurfaceContext,
  type PiariumManagedSurfaceModule,
  type PiariumSurfaceAsset,
} from "@piarium/extension-sdk";
import {
  SurfaceCapabilityRegistry,
  SurfaceExtensionRuntime,
  type SurfaceActivation,
  type SurfaceActivationContext,
  type SurfaceActivationOptions,
  type SurfaceCapabilityAccessContext,
  type SurfaceOwnerIdentity,
} from "@piarium/extension-surface";
import {
  browserIsolatedSurfaceRealmFactory,
  type IsolatedSurfaceRealm,
  type IsolatedSurfaceRealmFactory,
} from "./isolated-realm.js";

export interface SurfaceExtensionHost {
  activateExtension(extensionId: string): Promise<void>;
  catalog(): Promise<PiariumExtensionCatalogAvailability>;
  discardPreparedCandidate(extensionId: string, candidateIntegrity: string): Promise<void>;
  hostState(): Promise<PiariumExtensionHostStateSnapshot>;
  invokeService(request: PiariumExtensionServiceInvocationRequest): Promise<JsonValue>;
  prepareCandidate(extensionId: string, candidateIntegrity: string): Promise<PiariumExtensionCandidatePreparationResult>;
  requestCandidateApplication(request: PiariumExtensionCandidateSelectionRequest): Promise<PiariumExtensionCatalogSnapshot>;
  readAsset(request: PiariumExtensionAssetRequest): Promise<PiariumExtensionAssetPayload>;
  readManagedEntrypoint(request: PiariumExtensionManagedEntrypointRequest): Promise<PiariumExtensionManagedEntrypointPayload>;
  reportActualState(extensionId: string, state: PiariumExtensionActualState): Promise<void>;
  selectCandidate(request: PiariumExtensionCandidateSelectionRequest): Promise<PiariumExtensionCatalogSnapshot>;
  waitForHostState(request: PiariumExtensionHostStateWaitRequest, signal?: AbortSignal): Promise<PiariumExtensionHostStateSnapshot>;
}

export interface ManagedSurfaceModuleEvaluator {
  (source: string, identity: { entrypointId: string; extensionId: string; integrity: string }): PiariumManagedSurfaceModule | Promise<PiariumManagedSurfaceModule>;
}

export interface ManagedStyleHandle {
  commit(): void;
  dispose(): void;
}

export interface ManagedStyleHost {
  stage(cssText: string, ownerLabel: string): ManagedStyleHandle;
}

export interface SurfaceExtensionLoaderDiagnostic extends PiariumExtensionDiagnostic {
  entrypointId?: string;
  integrity?: string;
  moduleGeneration?: number;
}

export interface SurfaceExtensionLoaderSnapshot {
  active: Array<{
    entrypointId: string;
    extensionId: string;
    extensionVersion: string;
    integrity: string;
    moduleGeneration: number;
  }>;
  diagnostics: SurfaceExtensionLoaderDiagnostic[];
  hostId: string | null;
  revision: number;
}

export interface SurfaceExtensionLoaderOptions {
  accessContext?: () => Omit<SurfaceCapabilityAccessContext, "surface">;
  capabilities?: SurfaceCapabilityRegistry;
  evaluateModule?: ManagedSurfaceModuleEvaluator;
  host: SurfaceExtensionHost;
  isolatedRealmFactory?: IsolatedSurfaceRealmFactory;
  realmId?: string;
  styleHost?: ManagedStyleHost;
  surface: PiariumApplicationSurface;
  surfaceRuntime: SurfaceExtensionRuntime;
}

interface ActiveEntrypoint {
  artifactIntegrity: string;
  capabilityBindings: string;
  mode: Exclude<PiariumExtensionSurfaceEntrypoint["mode"], "declarative">;
  moduleGeneration: number;
  owner: SurfaceOwnerIdentity;
  serviceBindings: string;
}

interface ArtifactSelection {
  capabilityGrants: PiariumExtensionCapabilityGrant[];
  integrity: string;
  manifest: PiariumExtensionManifest;
  slot: "candidate" | "selected";
  version: string;
}

type ExecutableSurfaceEntrypoint = PiariumExtensionSurfaceEntrypoint & {
  mode: Exclude<PiariumExtensionSurfaceEntrypoint["mode"], "declarative">;
};

const keyFor = (extensionId: string, entrypointId: string): string => `${extensionId}\0${entrypointId}`;

const defaultRealmId = (): string => (
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `surface-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return `sha256-${[...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
};

const verifyAsset = async (
  value: PiariumExtensionAssetPayload,
  expectedArtifactIntegrity: string,
): Promise<{ bytes: Uint8Array; payload: PiariumExtensionAssetPayload }> => {
  const payload = parsePiariumExtensionAssetPayload(value);
  if (payload.artifactIntegrity !== expectedArtifactIntegrity) {
    throw new Error("Surface asset belongs to another extension artifact generation");
  }
  const bytes = decodeBase64(payload.bytesBase64);
  if (await sha256(bytes) !== payload.integrity) throw new Error(`Surface asset integrity failed: ${payload.path}`);
  return { bytes, payload };
};

export const evaluateManagedSurfaceModule: ManagedSurfaceModuleEvaluator = (source, identity) => {
  const module = { exports: {} as unknown };
  const sourceUrl = `piarium-extension://${identity.extensionId}/${identity.integrity}/${identity.entrypointId}`;
  const evaluate = new Function("module", "exports", `${source}\n//# sourceURL=${sourceUrl}`) as (
    module: { exports: unknown },
    exports: unknown,
  ) => void;
  evaluate(module, module.exports);
  return module.exports as PiariumManagedSurfaceModule;
};

const defaultStyleHost: ManagedStyleHost = {
  stage: (cssText, ownerLabel) => {
    if (typeof document === "undefined") return { commit: () => undefined, dispose: () => undefined };
    const element = document.createElement("style");
    element.dataset.piariumExtensionOwner = ownerLabel;
    element.media = "not all";
    element.textContent = cssText;
    document.head.appendChild(element);
    return {
      commit: () => { element.media = "all"; },
      dispose: () => element.remove(),
    };
  },
};

class ModuleResourceScope {
  readonly #artifactIntegrity: string;
  readonly #disposers: Array<() => void> = [];
  readonly #host: SurfaceExtensionHost;
  readonly #identity: { extensionId: string; integrity: string; slot: "candidate" | "selected" };
  readonly #styleHost: ManagedStyleHost;
  readonly #styles: ManagedStyleHandle[] = [];
  #disposed = false;

  constructor(options: {
    artifactIntegrity: string;
    extensionId: string;
    host: SurfaceExtensionHost;
    slot: "candidate" | "selected";
    styleHost: ManagedStyleHost;
  }) {
    this.#artifactIntegrity = options.artifactIntegrity;
    this.#host = options.host;
    this.#identity = { extensionId: options.extensionId, integrity: options.artifactIntegrity, slot: options.slot };
    this.#styleHost = options.styleHost;
  }

  async stageBundledStyles(styles: PiariumExtensionAssetPayload[]): Promise<void> {
    for (const style of styles) {
      const verified = await verifyAsset(style, this.#artifactIntegrity);
      this.#stageStyle(new TextDecoder().decode(verified.bytes), verified.payload.path);
    }
  }

  context(base: SurfaceActivationContext): PiariumManagedSurfaceContext {
    return {
      ...base,
      assets: {
        read: (path) => this.#read(path),
        url: async (path) => {
          const asset = await this.#read(path);
          const url = URL.createObjectURL(new Blob([asset.bytes.slice().buffer], { type: asset.contentType }));
          this.#disposers.push(() => URL.revokeObjectURL(url));
          return url;
        },
      },
      styles: {
        use: async (path) => {
          const asset = await this.#read(path);
          this.#stageStyle(new TextDecoder().decode(asset.bytes), asset.path);
        },
      },
    };
  }

  commit(): void {
    if (this.#disposed) throw new Error("Cannot commit disposed managed Surface resources");
    for (const style of this.#styles) style.commit();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const style of this.#styles.reverse()) style.dispose();
    for (const dispose of this.#disposers.reverse()) dispose();
  }

  async #read(path: string): Promise<PiariumSurfaceAsset> {
    if (this.#disposed) throw new Error("Managed Surface resource owner is inactive");
    const verified = await verifyAsset(await this.#host.readAsset({ ...this.#identity, path }), this.#artifactIntegrity);
    return {
      bytes: verified.bytes,
      contentType: verified.payload.contentType,
      integrity: verified.payload.integrity,
      path: verified.payload.path,
    };
  }

  #stageStyle(cssText: string, path: string): void {
    if (this.#disposed) throw new Error("Managed Surface resource owner is inactive");
    this.#styles.push(this.#styleHost.stage(cssText, `${this.#identity.extensionId}:${path}`));
  }
}

const publicCandidateSelection = (entry: PiariumExtensionCatalogEntry): ArtifactSelection | null => {
  if (!entry.integrity) return null;
  return {
    capabilityGrants: entry.capabilityGrants,
    integrity: entry.integrity,
    manifest: entry.manifest,
    slot: "selected",
    version: entry.selectedVersion,
  };
};

const explicitCandidateSelection = (
  entry: PiariumExtensionCatalogEntry,
  integrity: string,
): ArtifactSelection => {
  const candidate = entry.candidate;
  if (!candidate || candidate.integrity !== integrity) {
    throw new Error(`Piarium extension candidate is no longer current: ${entry.manifest.id}`);
  }
  if (!candidate.capabilitiesReviewed) {
    throw new Error(`Piarium extension candidate capability changes require review: ${entry.manifest.id}`);
  }
  return {
    capabilityGrants: candidate.capabilityGrants,
    integrity: candidate.integrity,
    manifest: candidate.manifest,
    slot: "candidate",
    version: candidate.resolvedVersion,
  };
};

const selectionCapabilities = (selection: ArtifactSelection): string[] => selection.capabilityGrants
  .filter((grant) => grant.realm === "surface" && grant.granted && grant.manifestVersion === selection.version)
  .map((grant) => grant.capability);

const compatibleExecutableEntrypoints = (
  manifest: PiariumExtensionManifest,
  surface: PiariumApplicationSurface,
): ExecutableSurfaceEntrypoint[] => (
  (manifest.entrypoints?.surfaces ?? []).filter((entrypoint): entrypoint is ExecutableSurfaceEntrypoint => (
    entrypoint.mode !== "declarative" && entrypoint.supports.includes(surface)
  ))
);

const toReportedActual = (state: ReturnType<SurfaceExtensionRuntime["getSnapshot"]>["actual"][number]): PiariumExtensionActualState => ({
  desiredRevision: state.desiredRevision,
  diagnostics: state.diagnostics,
  entrypointId: state.entrypointId,
  generation: state.generation,
  hostId: state.hostId,
  realmId: state.realmId,
  realmKind: state.realmKind,
  status: state.status,
  updatedAt: state.updatedAt,
});

export class SurfaceExtensionLoader {
  readonly #accessContext: () => SurfaceCapabilityAccessContext;
  readonly #active = new Map<string, ActiveEntrypoint>();
  readonly #capabilities: SurfaceCapabilityRegistry;
  readonly #diagnostics: SurfaceExtensionLoaderDiagnostic[] = [];
  readonly #evaluate: ManagedSurfaceModuleEvaluator;
  readonly #failedCandidates = new Set<string>();
  readonly #generations = new Map<string, number>();
  readonly #host: SurfaceExtensionHost;
  readonly #isolatedRealmFactory: IsolatedSurfaceRealmFactory;
  readonly #listeners = new Set<() => void>();
  readonly #nativeRestartRequired = new Set<string>();
  readonly #realmId: string;
  readonly #styleHost: ManagedStyleHost;
  readonly #surface: PiariumApplicationSurface;
  readonly #surfaceRuntime: SurfaceExtensionRuntime;
  #hostId: string | null = null;
  #queue: Promise<void> = Promise.resolve();
  #revision = 0;
  #hostStateRevision = 0;
  #watchController: AbortController | null = null;

  constructor(options: SurfaceExtensionLoaderOptions) {
    this.#accessContext = () => {
      const provided = options.accessContext?.();
      return {
        access: provided?.access ?? (options.surface === "desktop" || options.surface === "vscode" ? "local" : "remote"),
        projectTrusted: provided?.projectTrusted ?? false,
        surface: options.surface,
      };
    };
    this.#capabilities = options.capabilities ?? new SurfaceCapabilityRegistry();
    this.#evaluate = options.evaluateModule ?? evaluateManagedSurfaceModule;
    this.#host = options.host;
    this.#isolatedRealmFactory = options.isolatedRealmFactory ?? browserIsolatedSurfaceRealmFactory;
    this.#realmId = options.realmId ?? defaultRealmId();
    this.#styleHost = options.styleHost ?? defaultStyleHost;
    this.#surface = options.surface;
    this.#surfaceRuntime = options.surfaceRuntime;
  }

  getSnapshot = (): SurfaceExtensionLoaderSnapshot => ({
    active: [...this.#active.values()].map((entry) => ({
      entrypointId: entry.owner.entrypointId,
      extensionId: entry.owner.extensionId,
      extensionVersion: entry.owner.extensionVersion,
      integrity: entry.artifactIntegrity,
      moduleGeneration: entry.moduleGeneration,
    })).sort((left, right) => left.extensionId.localeCompare(right.extensionId) || left.entrypointId.localeCompare(right.entrypointId)),
    diagnostics: this.#diagnostics.map((item) => ({ ...item })),
    hostId: this.#hostId,
    revision: this.#revision,
  });

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  reconcile(availability?: PiariumExtensionCatalogAvailability): Promise<void> {
    const operation = async () => {
      if (!availability) {
        const state = parsePiariumExtensionHostStateSnapshot(await this.#host.hostState());
        await this.#reconcileSnapshot(state.catalog, state);
        return;
      }
      const result = availability
        ? parsePiariumExtensionCatalogAvailability(availability)
        : parsePiariumExtensionCatalogAvailability(await this.#host.catalog());
      if (result.supported !== true || result.status !== "ready") return;
      const state = parsePiariumExtensionHostStateSnapshot(await this.#host.hostState());
      await this.#reconcileSnapshot(result.snapshot, state);
    };
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  applyCandidate(
    extensionId: string,
    candidateIntegrity: string,
    expectedRevision: number,
  ): Promise<PiariumExtensionCatalogSnapshot> {
    const operation = async (): Promise<PiariumExtensionCatalogSnapshot> => {
      const state = parsePiariumExtensionHostStateSnapshot(await this.#host.hostState());
      let snapshot = state.catalog;
      if (!snapshot.authoritative) throw new Error("Cannot apply a candidate from a stale extension catalog");
      if (snapshot.revision !== expectedRevision) {
        throw new Error(`Extension catalog revision conflict: expected ${expectedRevision}, actual ${snapshot.revision}`);
      }
      let entry = snapshot.extensions.find((candidate) => candidate.manifest.id === extensionId);
      if (!entry) throw new Error(`Piarium extension is not installed: ${extensionId}`);
      explicitCandidateSelection(entry, candidateIntegrity);
      snapshot = parsePiariumExtensionCatalogSnapshot(await this.#host.requestCandidateApplication({
        candidateIntegrity,
        expectedRevision,
        extensionId,
      }));
      entry = snapshot.extensions.find((candidate) => candidate.manifest.id === extensionId);
      if (!entry) throw new Error(`Piarium extension is not installed: ${extensionId}`);
      const selection = explicitCandidateSelection(entry, candidateIntegrity);
      const entrypoints = compatibleExecutableEntrypoints(selection.manifest, this.#surface);
      let committed: PiariumExtensionCatalogSnapshot | null = null;
      try {
        if (!entry.desired.enabled) {
          committed = parsePiariumExtensionCatalogSnapshot(await this.#host.selectCandidate({
            candidateIntegrity,
            expectedRevision: snapshot.revision,
            extensionId,
          }));
        } else if (entrypoints.length > 0) {
          committed = await this.#activateEntryPoints(entry, selection, entrypoints, snapshot);
        } else {
          await this.#host.prepareCandidate(extensionId, candidateIntegrity);
          committed = parsePiariumExtensionCatalogSnapshot(await this.#host.selectCandidate({
            candidateIntegrity,
            expectedRevision: snapshot.revision,
            extensionId,
          }));
        }
        if (!committed) throw new Error(`Piarium extension candidate was not committed: ${extensionId}`);
        const retained = new Set(entrypoints.map((entrypoint) => keyFor(extensionId, entrypoint.id)));
        for (const [key, active] of [...this.#active]) {
          if (active.owner.extensionId === extensionId && !retained.has(key)) {
            await this.#deactivate(active, entry.desired.revision);
          }
        }
        this.#failedCandidates.delete(`${extensionId}\0${candidateIntegrity}`);
        this.#revision = committed.revision;
        this.#publish();
        return committed;
      } catch (error) {
        if (
          selection.manifest.entrypoints?.host?.mode === "native"
          && error instanceof Error
          && error.message.includes("requires an application-host restart")
        ) {
          this.#revision = snapshot.revision;
          this.#publish();
          return snapshot;
        }
        await this.#host.discardPreparedCandidate(extensionId, candidateIntegrity).catch(() => undefined);
        this.#diagnose(
          extensionId,
          "candidate_application_failed",
          error instanceof Error ? error.message : String(error),
          { integrity: candidateIntegrity },
        );
        this.#publish();
        throw error;
      }
    };
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async start(): Promise<void> {
    if (this.#watchController) return;
    await this.reconcile();
    const controller = new AbortController();
    this.#watchController = controller;
    void this.#watch(controller).catch((error) => {
      if (!controller.signal.aborted) {
        this.#diagnose("piarium.extensions", "host_state_watch_failed", error instanceof Error ? error.message : String(error));
        this.#publish();
      }
      if (this.#watchController === controller) this.#watchController = null;
    });
  }

  async stop(): Promise<void> {
    this.#watchController?.abort("Surface extension loader stopped");
    this.#watchController = null;
    await this.deactivateAll();
  }

  async deactivateAll(): Promise<void> {
    const active = [...this.#active.values()];
    for (const entry of active) await this.#deactivate(entry, entry.owner.desiredRevision + 1);
    this.#publish();
  }

  async #reconcileSnapshot(
    snapshotValue: PiariumExtensionCatalogSnapshot,
    hostState: PiariumExtensionHostStateSnapshot,
  ): Promise<void> {
    let snapshot = parsePiariumExtensionCatalogSnapshot(snapshotValue);
    if (!snapshot.authoritative) return;
    if (this.#hostId && this.#hostId !== snapshot.hostId) await this.deactivateAll();
    this.#hostId = snapshot.hostId;
    this.#hostStateRevision = hostState.revision;
    this.#revision = snapshot.revision;
    const desiredKeys = new Set<string>();

    for (const entry of snapshot.extensions) {
      if (entry.source.kind === "builtin") continue;
      const selected = publicCandidateSelection(entry);
      const entrypoints = selected ? compatibleExecutableEntrypoints(selected.manifest, this.#surface) : [];
      if (!entry.desired.enabled || !selected) continue;
      for (const entrypoint of entrypoints) desiredKeys.add(keyFor(entry.manifest.id, entrypoint.id));
    }
    for (const [key, active] of [...this.#active]) {
      const entry = snapshot.extensions.find((candidate) => candidate.manifest.id === active.owner.extensionId);
      if (!entry || !entry.desired.enabled || !desiredKeys.has(key)) {
        await this.#deactivate(active, entry?.desired.revision ?? active.owner.desiredRevision + 1);
      }
    }

    for (const entry of snapshot.extensions) {
      if (entry.source.kind === "builtin") continue;
      if (!entry.desired.enabled) continue;
      const selected = publicCandidateSelection(entry);
      if (!selected) {
        this.#diagnose(entry.manifest.id, "artifact_unavailable", "Surface extension has no content-addressed artifact");
        continue;
      }
      const entrypoints = compatibleExecutableEntrypoints(selected.manifest, this.#surface);
      if (entrypoints.length === 0) continue;
      const failedKey = `${entry.manifest.id}\0${selected.integrity}`;
      if (selected.slot === "candidate" && this.#failedCandidates.has(failedKey)) continue;
      if (entrypoints.some((entrypoint) => entrypoint.mode === "native") && this.#nativeRestartRequired.has(entry.manifest.id)) continue;
      const expectedBindings = selected.slot === "selected"
        ? this.#serviceBindingSignature(this.#resolveExternalProviders(selected, hostState, null))
        : null;
      const expectedCapabilityBindings = this.#capabilityBindingSignature(selectionCapabilities(selected), this.#accessContext());
      const currentEntrypoints = entrypoints
        .map((entrypoint) => this.#active.get(keyFor(entry.manifest.id, entrypoint.id)))
        .filter((value): value is ActiveEntrypoint => value !== undefined);
      if (currentEntrypoints.length > 0 && selected.slot === "selected"
        && !this.#requirementsSatisfied(selected, hostState)) {
        for (const active of currentEntrypoints) await this.#deactivate(active, entry.desired.revision);
        this.#diagnose(entry.manifest.id, "required_service_withdrawn", "A required extension service is no longer available");
        continue;
      }
      const allCurrent = entrypoints.every((entrypoint) => (
        this.#active.get(keyFor(entry.manifest.id, entrypoint.id))?.artifactIntegrity === selected.integrity
        && this.#active.get(keyFor(entry.manifest.id, entrypoint.id))?.capabilityBindings === expectedCapabilityBindings
        && (expectedBindings === null
          || this.#active.get(keyFor(entry.manifest.id, entrypoint.id))?.serviceBindings === expectedBindings)
      ));
      if (allCurrent) continue;
      try {
        const selection = await this.#activateEntryPoints(entry, selected, entrypoints, snapshot);
        if (selection) {
          snapshot = selection;
          const retained = new Set(entrypoints.map((entrypoint) => keyFor(entry.manifest.id, entrypoint.id)));
          for (const [key, active] of [...this.#active]) {
            if (active.owner.extensionId === entry.manifest.id && !retained.has(key)) {
              await this.#deactivate(active, entry.desired.revision);
            }
          }
        }
      } catch (error) {
        if (selected.slot === "candidate") this.#failedCandidates.add(failedKey);
        if (selected.slot === "candidate") {
          await this.#host.discardPreparedCandidate(entry.manifest.id, selected.integrity).catch(() => undefined);
        }
        this.#diagnose(
          entry.manifest.id,
          selected.slot === "candidate" ? "candidate_module_activation_failed" : "module_activation_failed",
          error instanceof Error ? error.message : String(error),
          { integrity: selected.integrity },
        );
      }
    }
    this.#revision = snapshot.revision;
    this.#publish();
  }

  async #activateEntryPoints(
    entry: PiariumExtensionCatalogEntry,
    selection: ArtifactSelection,
    entrypoints: ExecutableSurfaceEntrypoint[],
    snapshot: PiariumExtensionCatalogSnapshot,
  ): Promise<PiariumExtensionCatalogSnapshot | null> {
    const resources: ModuleResourceScope[] = [];
    const realms: IsolatedSurfaceRealm[] = [];
    const nativeOwners: SurfaceOwnerIdentity[] = [];
    const requests: Array<{ activation: SurfaceActivation; options: SurfaceActivationOptions }> = [];
    const activated: ActiveEntrypoint[] = [];
    try {
    let prepared: PiariumExtensionCandidatePreparationResult | null = null;
    if (selection.slot === "candidate") {
      prepared = parsePiariumExtensionCandidatePreparationResult(
        await this.#host.prepareCandidate(entry.manifest.id, selection.integrity),
      );
    } else {
      await this.#host.activateExtension(entry.manifest.id);
    }
    const currentHostState = parsePiariumExtensionHostStateSnapshot(await this.#host.hostState());
    const externalProviders = this.#resolveExternalProviders(selection, currentHostState, prepared);
    const externalServices = this.#externalServices(externalProviders);
    const serviceBindings = this.#serviceBindingSignature(externalProviders);
    for (const entrypoint of entrypoints) {
      const key = keyFor(entry.manifest.id, entrypoint.id);
      const moduleGeneration = (this.#generations.get(key) ?? 0) + 1;
      this.#generations.set(key, moduleGeneration);
      const payload = parsePiariumExtensionManagedEntrypointPayload(await this.#host.readManagedEntrypoint({
        entrypointId: entrypoint.id,
        extensionId: entry.manifest.id,
        integrity: selection.integrity,
        slot: selection.slot,
      }));
      const verifiedModule = await verifyAsset(payload.module, selection.integrity);
      const source = new TextDecoder().decode(verifiedModule.bytes);
      const owner: SurfaceOwnerIdentity = {
        desiredRevision: entry.desired.revision,
        entrypointId: entrypoint.id,
        extensionId: entry.manifest.id,
        extensionVersion: selection.version,
        generation: moduleGeneration,
        hostId: snapshot.hostId,
        realmId: this.#realmId,
      };
      if (entrypoint.mode === "native") nativeOwners.push(owner);
      const requestedGrants = selectionCapabilities(selection);
      const accessContext = this.#accessContext();
      const grantedCapabilities = this.#capabilities.resolveGranted(requestedGrants, accessContext);
      let activation: SurfaceActivation;
      if (entrypoint.mode === "isolated") {
        const styles: string[] = [];
        for (const style of payload.styles) {
          const verifiedStyle = await verifyAsset(style, selection.integrity);
          styles.push(new TextDecoder().decode(verifiedStyle.bytes));
        }
        const realm = this.#isolatedRealmFactory.create(source, styles, {
          entrypointId: entrypoint.id,
          extensionId: entry.manifest.id,
          integrity: selection.integrity,
          kind: entrypoint.isolation ?? "iframe",
          realmId: `${this.#realmId}:${entry.manifest.id}:${entrypoint.id}:${moduleGeneration}`,
        });
        realms.push(realm);
        activation = async (context) => {
          context.onDispose(() => realm.dispose());
          await realm.activate({
            callCapability: (capability, method, params) => this.#capabilities.invoke(
              capability,
              method,
              params,
              owner,
              grantedCapabilities,
              accessContext,
              context.signal,
            ),
            callService: async (serviceId, version, providerId, method, args) => {
              if (providerId) {
                const provider = externalProviders.find((candidate) => candidate.providerId === providerId);
                if (!provider || provider.descriptor.id !== serviceId || provider.descriptor.version !== version) {
                  throw new Error(`Isolated Surface service provider is unavailable: ${providerId}`);
                }
                return this.#host.invokeService({ args, method, providerId, serviceId, version });
              }
              const implementation = context.useService<Record<string, (...values: JsonValue[]) => JsonValue | Promise<JsonValue>>>(serviceId, version);
              const handler = implementation?.[method];
              if (typeof handler !== "function") throw new Error(`Isolated Surface service method is unavailable: ${serviceId}@${version}.${method}`);
              return Promise.resolve(handler(...args));
            },
            contribute: (descriptor, implementation) => context.contribute(descriptor, implementation),
            grantedCapabilities,
            readAsset: async (path) => {
              const value = await this.#host.readAsset({
                extensionId: entry.manifest.id,
                integrity: selection.integrity,
                path,
                slot: selection.slot,
              });
              return (await verifyAsset(value, selection.integrity)).payload;
            },
          });
        };
      } else {
        const module = await this.#evaluate(source, {
          entrypointId: entrypoint.id,
          extensionId: entry.manifest.id,
          integrity: selection.integrity,
        });
        const extension = resolveSurfaceExtensionModule(module);
        const resourceScope = new ModuleResourceScope({
          artifactIntegrity: selection.integrity,
          extensionId: entry.manifest.id,
          host: this.#host,
          slot: selection.slot,
          styleHost: this.#styleHost,
        });
        await resourceScope.stageBundledStyles(payload.styles);
        resources.push(resourceScope);
        activation = async (context) => {
          context.onDispose(() => resourceScope.dispose());
          await extension.activate(resourceScope.context(context));
        };
      }
      requests.push({
        activation,
        options: {
          grantedCapabilities,
          owner,
          ...(externalServices.length > 0 ? { externalServices } : {}),
          ...(selection.manifest.requires?.services
            ? { requirements: selection.manifest.requires.services }
            : {}),
        },
      });
      activated.push({
        artifactIntegrity: selection.integrity,
        capabilityBindings: this.#capabilityBindingSignature(grantedCapabilities, accessContext),
        mode: entrypoint.mode,
        moduleGeneration,
        owner,
        serviceBindings,
      });
    }

    let committedSnapshot: PiariumExtensionCatalogSnapshot | null = null;
      await this.#surfaceRuntime.activateBatchWithCommit(requests, async () => {
        if (selection.slot !== "candidate") return;
        committedSnapshot = parsePiariumExtensionCatalogSnapshot(await this.#host.selectCandidate({
          candidateIntegrity: selection.integrity,
          expectedRevision: snapshot.revision,
          extensionId: entry.manifest.id,
        }));
      });
      for (const resource of resources) resource.commit();
      for (const active of activated) this.#active.set(keyFor(active.owner.extensionId, active.owner.entrypointId), active);
      await this.#reportActual(entry.manifest.id);
      return committedSnapshot;
    } catch (error) {
      for (const resource of resources) resource.dispose();
      for (const realm of realms) realm.dispose(error);
      for (const owner of nativeOwners) {
        this.#nativeRestartRequired.add(owner.extensionId);
        this.#surfaceRuntime.markRestartRequired(
          owner,
          "native_surface_rollback_not_guaranteed",
          "Trusted-native Surface activation failed; reload this Surface before retrying the extension",
        );
      }
      await this.#reportActual(entry.manifest.id);
      throw error;
    }
  }

  async #watch(controller: AbortController): Promise<void> {
    for (;;) {
      if (controller.signal.aborted || !this.#hostId) return;
      const state = parsePiariumExtensionHostStateSnapshot(await this.#host.waitForHostState({
        hostId: this.#hostId,
        revision: this.#hostStateRevision,
      }, controller.signal));
      if (controller.signal.aborted) return;
      const operation = () => this.#reconcileSnapshot(state.catalog, state);
      const result = this.#queue.then(operation, operation);
      this.#queue = result.then(() => undefined, () => undefined);
      await result;
    }
  }

  #resolveExternalProviders(
    selection: ArtifactSelection,
    state: PiariumExtensionHostStateSnapshot,
    prepared: PiariumExtensionCandidatePreparationResult | null,
  ): PiariumExtensionServiceProviderSnapshot[] {
    const requirements = selection.manifest.requires?.services ?? [];
    const preparedProviders = prepared?.providers ?? [];
    const selectedProviders: PiariumExtensionServiceProviderSnapshot[] = [];
    for (const requirement of requirements) {
      const candidateKeys = new Set(preparedProviders
        .filter((provider) => provider.descriptor.id === requirement.id && provider.descriptor.version === requirement.version)
        .map((provider) => `${provider.extensionId}\0${provider.descriptor.id}\0${provider.descriptor.version}`));
      const active = state.services.providers.filter((provider) => (
        provider.status === "active"
        && provider.descriptor.id === requirement.id
        && provider.descriptor.version === requirement.version
        && !candidateKeys.has(`${provider.extensionId}\0${provider.descriptor.id}\0${provider.descriptor.version}`)
      ));
      const candidates = preparedProviders.filter((provider) => (
        provider.descriptor.id === requirement.id && provider.descriptor.version === requirement.version
      ));
      const matches = [...active, ...candidates];
      const binding = requirement.binding ?? "single";
      if (binding === "all") selectedProviders.push(...matches);
      else if (binding === "selected") {
        const selectedId = state.services.selections[`${requirement.id}@${requirement.version}`];
        const selected = matches.find((provider) => provider.providerId === selectedId)
          ?? (candidates.length === 1 && state.services.providers.some((provider) => (
            provider.providerId === selectedId && provider.extensionId === candidates[0]?.extensionId
          )) ? candidates[0] : undefined);
        if (selected) selectedProviders.push(selected);
      } else if (matches.length === 1) selectedProviders.push(matches[0] as PiariumExtensionServiceProviderSnapshot);
    }
    return [...new Map(selectedProviders.map((provider) => [provider.providerId, provider])).values()];
  }

  #externalServices(
    providers: PiariumExtensionServiceProviderSnapshot[],
  ): NonNullable<SurfaceActivationOptions["externalServices"]> {
    return providers.map((provider) => ({
      descriptor: { ...provider.descriptor },
      implementation: new Proxy({}, {
        get: (_target, property) => property === "then" || typeof property !== "string"
          ? undefined
          : (...args: JsonValue[]) => this.#host.invokeService({
            args,
            method: property,
            providerId: provider.providerId,
            serviceId: provider.descriptor.id,
            version: provider.descriptor.version,
          }),
      }),
      providerId: provider.providerId,
    }));
  }

  #requirementsSatisfied(selection: ArtifactSelection, state: PiariumExtensionHostStateSnapshot): boolean {
    const external = this.#resolveExternalProviders(selection, state, null);
    return (selection.manifest.requires?.services ?? []).every((requirement) => {
      if (requirement.optional) return true;
      const externalCount = external.filter((provider) => (
        provider.descriptor.id === requirement.id && provider.descriptor.version === requirement.version
      )).length;
      const localCount = this.#surfaceRuntime.getServices(requirement.id, requirement.version).length;
      const count = externalCount + localCount;
      if ((requirement.binding ?? "single") === "single") return count === 1;
      if (requirement.binding === "selected") {
        return externalCount > 0 || this.#surfaceRuntime.getService(requirement.id, requirement.version) !== undefined;
      }
      return count > 0;
    });
  }

  #serviceBindingSignature(providers: PiariumExtensionServiceProviderSnapshot[]): string {
    return providers.map((provider) => provider.providerId).sort().join("\0");
  }

  #capabilityBindingSignature(capabilities: Iterable<string>, context: SurfaceCapabilityAccessContext): string {
    return JSON.stringify({
      access: context.access,
      capabilities: this.#capabilities.resolveGranted(capabilities, context).sort(),
      projectTrusted: context.projectTrusted,
      surface: context.surface,
    });
  }

  async #deactivate(active: ActiveEntrypoint, desiredRevision: number): Promise<void> {
    const owner = {
      ...active.owner,
      desiredRevision,
      generation: active.moduleGeneration + 1,
    };
    await this.#surfaceRuntime.deactivate(owner);
    if (active.mode === "native") {
      const actual = this.#surfaceRuntime.getSnapshot().actual.find((state) => (
        state.extensionId === owner.extensionId
        && state.entrypointId === owner.entrypointId
        && state.realmId === owner.realmId
      ));
      if (actual?.diagnostics.some((item) => item.code === "deactivation_cleanup_failed")) {
        this.#nativeRestartRequired.add(owner.extensionId);
        this.#surfaceRuntime.markRestartRequired(
          owner,
          "native_surface_cleanup_failed",
          "Trusted-native Surface cleanup failed; reload this Surface to complete deactivation",
        );
      }
    }
    this.#active.delete(keyFor(active.owner.extensionId, active.owner.entrypointId));
    await this.#reportActual(active.owner.extensionId);
  }

  async #reportActual(extensionId: string): Promise<void> {
    const states = this.#surfaceRuntime.getSnapshot().actual.filter((state) => (
      state.extensionId === extensionId && state.realmId === this.#realmId
    ));
    for (const state of states) await this.#host.reportActualState(extensionId, toReportedActual(state)).catch(() => undefined);
  }

  #diagnose(
    extensionId: string,
    code: string,
    message: string,
    details: Pick<SurfaceExtensionLoaderDiagnostic, "entrypointId" | "integrity" | "moduleGeneration"> = {},
  ): void {
    this.#diagnostics.push({
      code,
      extensionId,
      message,
      realmId: this.#realmId,
      severity: "error",
      timestamp: new Date().toISOString(),
      ...details,
    });
  }

  #publish(): void {
    for (const listener of this.#listeners) listener();
  }
}
