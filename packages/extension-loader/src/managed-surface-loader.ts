import {
  parsePiariumExtensionAssetPayload,
  parsePiariumExtensionCatalogAvailability,
  parsePiariumExtensionCatalogSnapshot,
  parsePiariumExtensionManagedEntrypointPayload,
  type PiariumApplicationSurface,
  type PiariumExtensionActualState,
  type PiariumExtensionAssetPayload,
  type PiariumExtensionAssetRequest,
  type PiariumExtensionCandidateSelectionRequest,
  type PiariumExtensionCatalogAvailability,
  type PiariumExtensionCatalogEntry,
  type PiariumExtensionCatalogSnapshot,
  type PiariumExtensionDiagnostic,
  type PiariumExtensionManagedEntrypointPayload,
  type PiariumExtensionManagedEntrypointRequest,
  type PiariumExtensionManifest,
  type PiariumExtensionPublicCandidate,
  type PiariumExtensionSurfaceEntrypoint,
} from "@piarium/extension-contract";
import {
  resolveSurfaceExtensionModule,
  type PiariumManagedSurfaceContext,
  type PiariumManagedSurfaceModule,
  type PiariumSurfaceAsset,
} from "@piarium/extension-sdk";
import {
  SurfaceExtensionRuntime,
  type SurfaceActivation,
  type SurfaceActivationContext,
  type SurfaceActivationOptions,
  type SurfaceOwnerIdentity,
} from "@piarium/extension-surface";

export interface ManagedSurfaceExtensionHost {
  catalog(): Promise<PiariumExtensionCatalogAvailability>;
  readAsset(request: PiariumExtensionAssetRequest): Promise<PiariumExtensionAssetPayload>;
  readManagedEntrypoint(request: PiariumExtensionManagedEntrypointRequest): Promise<PiariumExtensionManagedEntrypointPayload>;
  reportActualState(extensionId: string, state: PiariumExtensionActualState): Promise<void>;
  selectCandidate(request: PiariumExtensionCandidateSelectionRequest): Promise<PiariumExtensionCatalogSnapshot>;
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

export interface ManagedSurfaceLoaderDiagnostic extends PiariumExtensionDiagnostic {
  entrypointId?: string;
  integrity?: string;
  moduleGeneration?: number;
}

export interface ManagedSurfaceLoaderSnapshot {
  active: Array<{
    entrypointId: string;
    extensionId: string;
    extensionVersion: string;
    integrity: string;
    moduleGeneration: number;
  }>;
  diagnostics: ManagedSurfaceLoaderDiagnostic[];
  hostId: string | null;
  revision: number;
}

export interface ManagedSurfaceExtensionLoaderOptions {
  evaluateModule?: ManagedSurfaceModuleEvaluator;
  host: ManagedSurfaceExtensionHost;
  realmId?: string;
  styleHost?: ManagedStyleHost;
  surface: PiariumApplicationSurface;
  surfaceRuntime: SurfaceExtensionRuntime;
}

interface ActiveEntrypoint {
  artifactIntegrity: string;
  moduleGeneration: number;
  owner: SurfaceOwnerIdentity;
}

interface ArtifactSelection {
  integrity: string;
  manifest: PiariumExtensionManifest;
  slot: "candidate" | "selected";
  version: string;
}

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
    throw new Error("Managed Surface asset belongs to another extension artifact generation");
  }
  const bytes = decodeBase64(payload.bytesBase64);
  if (await sha256(bytes) !== payload.integrity) throw new Error(`Managed Surface asset integrity failed: ${payload.path}`);
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
  readonly #host: ManagedSurfaceExtensionHost;
  readonly #identity: { extensionId: string; integrity: string; slot: "candidate" | "selected" };
  readonly #styleHost: ManagedStyleHost;
  readonly #styles: ManagedStyleHandle[] = [];
  #disposed = false;

  constructor(options: {
    artifactIntegrity: string;
    extensionId: string;
    host: ManagedSurfaceExtensionHost;
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
  const candidate: PiariumExtensionPublicCandidate | undefined = entry.candidate;
  if (candidate) {
    return {
      integrity: candidate.integrity,
      manifest: candidate.manifest,
      slot: "candidate",
      version: candidate.resolvedVersion,
    };
  }
  if (!entry.integrity) return null;
  return {
    integrity: entry.integrity,
    manifest: entry.manifest,
    slot: "selected",
    version: entry.selectedVersion,
  };
};

const compatibleManagedEntrypoints = (
  manifest: PiariumExtensionManifest,
  surface: PiariumApplicationSurface,
): PiariumExtensionSurfaceEntrypoint[] => (
  (manifest.entrypoints?.surfaces ?? []).filter((entrypoint) => (
    entrypoint.mode === "managed" && entrypoint.supports.includes(surface)
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

export class ManagedSurfaceExtensionLoader {
  readonly #active = new Map<string, ActiveEntrypoint>();
  readonly #diagnostics: ManagedSurfaceLoaderDiagnostic[] = [];
  readonly #evaluate: ManagedSurfaceModuleEvaluator;
  readonly #failedCandidates = new Set<string>();
  readonly #generations = new Map<string, number>();
  readonly #host: ManagedSurfaceExtensionHost;
  readonly #listeners = new Set<() => void>();
  readonly #realmId: string;
  readonly #styleHost: ManagedStyleHost;
  readonly #surface: PiariumApplicationSurface;
  readonly #surfaceRuntime: SurfaceExtensionRuntime;
  #hostId: string | null = null;
  #queue: Promise<void> = Promise.resolve();
  #revision = 0;

  constructor(options: ManagedSurfaceExtensionLoaderOptions) {
    this.#evaluate = options.evaluateModule ?? evaluateManagedSurfaceModule;
    this.#host = options.host;
    this.#realmId = options.realmId ?? defaultRealmId();
    this.#styleHost = options.styleHost ?? defaultStyleHost;
    this.#surface = options.surface;
    this.#surfaceRuntime = options.surfaceRuntime;
  }

  getSnapshot = (): ManagedSurfaceLoaderSnapshot => ({
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
      const result = availability
        ? parsePiariumExtensionCatalogAvailability(availability)
        : parsePiariumExtensionCatalogAvailability(await this.#host.catalog());
      if (result.supported !== true || result.status !== "ready") return;
      await this.#reconcileSnapshot(result.snapshot);
    };
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async deactivateAll(): Promise<void> {
    const active = [...this.#active.values()];
    for (const entry of active) await this.#deactivate(entry, entry.owner.desiredRevision + 1);
    this.#publish();
  }

  async #reconcileSnapshot(snapshotValue: PiariumExtensionCatalogSnapshot): Promise<void> {
    let snapshot = parsePiariumExtensionCatalogSnapshot(snapshotValue);
    if (!snapshot.authoritative) return;
    if (this.#hostId && this.#hostId !== snapshot.hostId) await this.deactivateAll();
    this.#hostId = snapshot.hostId;
    this.#revision = snapshot.revision;
    const desiredKeys = new Set<string>();

    for (const entry of snapshot.extensions) {
      const selected = publicCandidateSelection(entry);
      const entrypoints = selected ? compatibleManagedEntrypoints(selected.manifest, this.#surface) : [];
      if (!entry.desired.enabled || !selected) continue;
      for (const entrypoint of entrypoints) desiredKeys.add(keyFor(entry.manifest.id, entrypoint.id));
    }
    for (const [key, active] of [...this.#active]) {
      const entry = snapshot.extensions.find((candidate) => candidate.manifest.id === active.owner.extensionId);
      if (!entry || !entry.desired.enabled || (!entry.candidate && !desiredKeys.has(key))) {
        await this.#deactivate(active, entry?.desired.revision ?? active.owner.desiredRevision + 1);
      }
    }

    for (const entry of snapshot.extensions) {
      if (!entry.desired.enabled) continue;
      const selected = publicCandidateSelection(entry);
      if (!selected) {
        this.#diagnose(entry.manifest.id, "artifact_unavailable", "Managed Surface extension has no content-addressed artifact");
        continue;
      }
      const entrypoints = compatibleManagedEntrypoints(selected.manifest, this.#surface);
      if (entrypoints.length === 0) continue;
      const failedKey = `${entry.manifest.id}\0${selected.integrity}`;
      if (selected.slot === "candidate" && this.#failedCandidates.has(failedKey)) continue;
      const allCurrent = entrypoints.every((entrypoint) => (
        this.#active.get(keyFor(entry.manifest.id, entrypoint.id))?.artifactIntegrity === selected.integrity
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
    entrypoints: PiariumExtensionSurfaceEntrypoint[],
    snapshot: PiariumExtensionCatalogSnapshot,
  ): Promise<PiariumExtensionCatalogSnapshot | null> {
    const resources: ModuleResourceScope[] = [];
    const requests: Array<{ activation: SurfaceActivation; options: SurfaceActivationOptions }> = [];
    const activated: ActiveEntrypoint[] = [];
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
      const module = await this.#evaluate(new TextDecoder().decode(verifiedModule.bytes), {
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
      const owner: SurfaceOwnerIdentity = {
        desiredRevision: entry.desired.revision,
        entrypointId: entrypoint.id,
        extensionId: entry.manifest.id,
        extensionVersion: selection.version,
        generation: moduleGeneration,
        hostId: snapshot.hostId,
        realmId: this.#realmId,
      };
      requests.push({
        activation: async (context) => {
          context.onDispose(() => resourceScope.dispose());
          await extension.activate(resourceScope.context(context));
        },
        options: {
          grantedCapabilities: entry.capabilityGrants
            .filter((grant) => grant.realm === "surface" && grant.granted && grant.manifestVersion === selection.version)
            .map((grant) => grant.capability),
          owner,
          ...(selection.manifest.requires?.services
            ? { requirements: selection.manifest.requires.services }
            : {}),
        },
      });
      activated.push({ artifactIntegrity: selection.integrity, moduleGeneration, owner });
    }

    let committedSnapshot: PiariumExtensionCatalogSnapshot | null = null;
    try {
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
      await this.#reportActual(entry.manifest.id);
      throw error;
    }
  }

  async #deactivate(active: ActiveEntrypoint, desiredRevision: number): Promise<void> {
    const owner = {
      ...active.owner,
      desiredRevision,
      generation: active.moduleGeneration + 1,
    };
    await this.#surfaceRuntime.deactivate(owner);
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
    details: Pick<ManagedSurfaceLoaderDiagnostic, "entrypointId" | "integrity" | "moduleGeneration"> = {},
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
