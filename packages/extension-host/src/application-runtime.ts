import {
  assertPiariumApplicationVersion,
  parsePiariumExtensionActualState,
  parsePiariumExtensionCandidateCapabilityReviewRequest,
  parsePiariumExtensionCandidateSelectionRequest,
  parsePiariumExtensionCapabilityReviewRequest,
  parsePiariumExtensionHostStateWaitRequest,
  parsePiariumExtensionLocalSourceReloadRequest,
  parsePiariumExtensionPackageInstallRequest,
  parsePiariumExtensionRemoveRequest,
  parsePiariumExtensionServiceInvocationRequest,
  parsePiariumExtensionServiceSelectionRequest,
  parsePiariumWorkbenchProfileApplyRequest,
  resolvePiariumExtensionServiceRouting,
  type JsonValue,
  type PiariumExtensionActivationEvent,
  type PiariumExtensionActualState,
  type PiariumExtensionCandidateCapabilityReviewRequest,
  type PiariumExtensionCandidateSelectionRequest,
  type PiariumExtensionCapabilityReviewRequest,
  type PiariumExtensionCandidatePreparationResult,
  type PiariumExtensionCatalogSnapshot,
  type PiariumExtensionHostStateSnapshot,
  type PiariumExtensionHostStateWaitRequest,
  type PiariumExtensionLocalSourceReloadRequest,
  type PiariumExtensionLocalSourceReloadResult,
  type PiariumExtensionPackageInstallRequest,
  type PiariumExtensionRemoveRequest,
  type PiariumExtensionServiceInvocationRequest,
  type PiariumExtensionServiceRoutingRuleRemoveRequest,
  type PiariumExtensionServiceRoutingRuleUpdateRequest,
  type PiariumExtensionServiceRoutingSnapshot,
  type PiariumExtensionServiceSelectionRequest,
  type PiariumWorkbenchLayoutUpdateRequest,
  type PiariumWorkbenchProfileRemoveRequest,
  type PiariumWorkbenchProfileApplyRequest,
  type PiariumWorkbenchProfileSelectionRequest,
  type PiariumWorkbenchProfileSnapshot,
  type PiariumWorkbenchProfileUpsertRequest,
} from "@piarium/extension-contract";
import {
  PIARIUM_BUILTIN_EXTENSION_DEFINITIONS,
  PIARIUM_BUILTIN_EXTENSION_PREFIX,
} from "@piarium/extension-builtins";
import { ApplicationExtensionCatalog } from "./application-catalog.js";
import { BrokeredHostSupervisor, type BrokeredHostTransportFactory } from "./broker-supervisor.js";
import { HostCapabilityRegistry } from "./capability-registry.js";
import { ExtensionPackageManager } from "./package-manager.js";
import { HostServiceRegistry } from "./service-registry.js";
import { ServiceRoutingStore } from "./service-routing-store.js";
import { ExtensionStorageError } from "./errors.js";
import { ExtensionStorageStore } from "./storage-store.js";
import { WorkbenchProfileStore } from "./workbench-profile-store.js";

export interface ApplicationExtensionRuntimeOptions {
  brokerScript: string;
  capabilities?: HostCapabilityRegistry;
  catalog?: ApplicationExtensionCatalog;
  dataDir: string;
  packages?: ExtensionPackageManager;
  piariumVersion: string;
  routing?: ServiceRoutingStore;
  services?: HostServiceRegistry;
  storage?: ExtensionStorageStore;
  transportFactory?: BrokeredHostTransportFactory;
  workbench?: WorkbenchProfileStore;
}

export class ApplicationExtensionRuntime {
  readonly capabilities: HostCapabilityRegistry;
  readonly catalog: ApplicationExtensionCatalog;
  readonly packages: ExtensionPackageManager;
  readonly piariumVersion: string;
  readonly routing: ServiceRoutingStore;
  readonly services: HostServiceRegistry;
  readonly storage: ExtensionStorageStore;
  readonly supervisor: BrokeredHostSupervisor;
  readonly workbench: WorkbenchProfileStore;
  readonly #listeners = new Set<() => void>();
  readonly #serviceUnsubscribe: () => void;
  #revision = 0;
  #mutationQueue: Promise<void> = Promise.resolve();
  #stopped = false;

  private constructor(options: ApplicationExtensionRuntimeOptions, hostId: string) {
    this.piariumVersion = options.piariumVersion;
    assertPiariumApplicationVersion(this.piariumVersion);
    this.catalog = options.catalog ?? new ApplicationExtensionCatalog({ dataDir: options.dataDir });
    this.packages = options.packages ?? new ExtensionPackageManager({
      catalog: this.catalog,
      dataDir: options.dataDir,
      piariumVersion: this.piariumVersion,
    });
    if (this.packages.piariumVersion !== this.piariumVersion) {
      throw new Error("Extension package manager targets another Piarium application version");
    }
    this.capabilities = options.capabilities ?? new HostCapabilityRegistry();
    this.services = options.services ?? new HostServiceRegistry(hostId);
    if (this.services.hostId !== hostId) throw new Error("Extension service registry belongs to another application host");
    this.storage = options.storage ?? new ExtensionStorageStore(options.dataDir);
    this.routing = options.routing ?? new ServiceRoutingStore({ hostId, storage: this.storage });
    if (this.routing.hostId !== hostId) throw new Error("Service routing store belongs to another application host");
    this.workbench = options.workbench ?? new WorkbenchProfileStore({ hostId, storage: this.storage });
    if (this.workbench.hostId !== hostId) throw new Error("Workbench profile store belongs to another application host");
    this.supervisor = new BrokeredHostSupervisor({
      brokerScript: options.brokerScript,
      capabilities: this.capabilities,
      catalog: this.catalog,
      onStateChange: () => this.#publish(),
      packages: this.packages,
      services: this.services,
      storage: this.storage,
      invokeService: (request, signal) => this.#invokeRegisteredService(request, signal),
      ...(options.transportFactory ? { transportFactory: options.transportFactory } : {}),
    });
    this.#serviceUnsubscribe = this.services.subscribe(() => this.#publish());
  }

  static async create(options: ApplicationExtensionRuntimeOptions): Promise<ApplicationExtensionRuntime> {
    const catalog = options.catalog ?? new ApplicationExtensionCatalog({ dataDir: options.dataDir });
    const identity = await catalog.store.getHostIdentity();
    return new ApplicationExtensionRuntime({ ...options, catalog }, identity.hostId);
  }

  async start(): Promise<PiariumExtensionHostStateSnapshot> {
    await this.#mutate(async () => {
      const snapshot = await this.catalog.reconcileBuiltins(
        PIARIUM_BUILTIN_EXTENSION_DEFINITIONS,
        PIARIUM_BUILTIN_EXTENSION_PREFIX,
      );
      await this.supervisor.reconcile(snapshot);
      await this.workbench.read();
      await this.routing.read();
      this.#publish();
    });
    return this.state();
  }

  async state(): Promise<PiariumExtensionHostStateSnapshot> {
    for (;;) {
      const before = this.#revision;
      const catalog = await this.catalog.snapshot();
      const services = this.services.getSnapshot();
      const routing = await this.routing.read();
      const workbench = await this.workbench.read();
      const after = this.#revision;
      if (before === after) return { catalog, revision: after, routing, services, workbench };
    }
  }

  subscribe(listener: () => void): () => void {
    if (this.#stopped) throw new Error("Application extension runtime is stopped");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async waitForState(
    requestValue: PiariumExtensionHostStateWaitRequest | unknown,
    signal?: AbortSignal,
  ): Promise<PiariumExtensionHostStateSnapshot> {
    const request = parsePiariumExtensionHostStateWaitRequest(requestValue);
    const current = await this.state();
    if (request.hostId !== current.catalog.hostId || request.revision !== current.revision) return current;
    return new Promise((resolveWait, rejectWait) => {
      let disposed = false;
      const finish = (callback: () => void) => {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => finish(() => rejectWait(signal?.reason ?? new Error("Extension host-state wait aborted")));
      const onChange = () => {
        void this.state().then(
          (next) => finish(() => resolveWait(next)),
          (error) => finish(() => rejectWait(error)),
        );
      };
      const unsubscribe = this.subscribe(onChange);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      if (this.#revision !== request.revision) onChange();
    });
  }

  reconcile(snapshot?: PiariumExtensionCatalogSnapshot): Promise<void> {
    return this.#mutate(async () => {
      await this.supervisor.reconcile(snapshot);
      this.#publish();
    });
  }

  installOrStage(
    requestValue: PiariumExtensionPackageInstallRequest | unknown,
    signal?: AbortSignal,
  ): Promise<PiariumExtensionCatalogSnapshot> {
    const request = parsePiariumExtensionPackageInstallRequest(requestValue);
    return this.#mutateCatalog(async () => {
      const snapshot = await this.packages.installOrStage(request.source, request.expectedRevision, signal);
      await this.supervisor.reconcile(snapshot);
      return this.catalog.snapshot();
    });
  }

  reloadLocalSource(
    requestValue: PiariumExtensionLocalSourceReloadRequest | unknown,
    signal?: AbortSignal,
  ): Promise<PiariumExtensionLocalSourceReloadResult> {
    const request = parsePiariumExtensionLocalSourceReloadRequest(requestValue);
    return this.#mutate(async () => {
      const result = await this.packages.reloadLocalSource(request, signal);
      if (result.outcome === "staged") {
        await this.supervisor.reconcile(result.snapshot);
        this.#publish();
      }
      return result;
    });
  }

  removeExtension(
    requestValue: PiariumExtensionRemoveRequest | unknown,
  ): Promise<PiariumExtensionCatalogSnapshot> {
    const request = parsePiariumExtensionRemoveRequest(requestValue);
    return this.#mutateCatalog(async () => {
      const current = await this.catalog.snapshot();
      if (current.revision !== request.expectedRevision) {
        return this.catalog.remove(request.extensionId, request.expectedRevision);
      }
      const entry = current.extensions.find((candidate) => candidate.manifest.id === request.extensionId);
      if (!entry) throw new Error(`Piarium extension is not installed: ${request.extensionId}`);
      if (entry.source.kind === "builtin") throw new Error(`Built-in Piarium extensions are managed by the distribution: ${request.extensionId}`);
      if (entry.desired.enabled) throw new Error(`Disable the Piarium extension before removing it: ${request.extensionId}`);
      await this.supervisor.deactivateExtension(request.extensionId);
      try {
        const removed = await this.catalog.remove(request.extensionId, request.expectedRevision);
        await this.supervisor.reconcile(removed);
        if (request.deleteData) {
          try {
            await this.storage.deleteExtensionData(request.extensionId);
          } catch (error) {
            throw new ExtensionStorageError(
              "storage_write_failed",
              `Piarium extension ${request.extensionId} was removed, but its namespaced storage could not be deleted`,
              { cause: error },
            );
          }
        }
        return removed;
      } catch (error) {
        await this.supervisor.reconcile(await this.catalog.snapshot()).catch(() => undefined);
        throw error;
      }
    });
  }

  setEnabled(extensionId: string, enabled: boolean, expectedRevision: number): Promise<PiariumExtensionCatalogSnapshot> {
    return this.#mutateCatalog(async () => {
      const snapshot = await this.catalog.setEnabled(extensionId, enabled, expectedRevision);
      await this.supervisor.reconcile(snapshot);
      return this.catalog.snapshot();
    });
  }

  setAllEnabled(enabled: boolean, expectedRevision: number): Promise<PiariumExtensionCatalogSnapshot> {
    return this.#mutateCatalog(async () => {
      const snapshot = await this.catalog.setAllEnabled(enabled, expectedRevision);
      await this.supervisor.reconcile(snapshot);
      return this.catalog.snapshot();
    });
  }

  prepareCandidate(extensionId: string, integrity: string): Promise<PiariumExtensionCandidatePreparationResult> {
    return this.#mutate(async () => {
      const prepared = await this.supervisor.prepareCandidate(extensionId, integrity);
      this.#publish();
      return prepared;
    });
  }

  activateExtension(extensionId: string): Promise<void> {
    return this.#mutate(async () => {
      await this.#ensureBuiltinArtifact(extensionId);
      await this.supervisor.activateExtension(extensionId);
      this.#publish();
    });
  }

  activateForEvent(event: PiariumExtensionActivationEvent): Promise<void> {
    return this.#mutate(async () => {
      const snapshot = await this.catalog.snapshot();
      if (!snapshot.authoritative) throw new Error("Cannot activate extensions from a stale catalog");
      for (const entry of snapshot.extensions) {
        if (!entry.desired.enabled || !entry.manifest.entrypoints?.host?.activation?.includes(event)) continue;
        await this.#ensureBuiltinArtifact(entry.manifest.id);
        await this.supervisor.activateExtension(entry.manifest.id);
      }
      this.#publish();
    });
  }

  discardPreparedCandidate(extensionId: string, integrity: string): Promise<void> {
    return this.#mutate(async () => {
      await this.supervisor.discardPreparedCandidate(extensionId, integrity);
      this.#publish();
    });
  }

  discardCandidate(
    requestValue: PiariumExtensionCandidateSelectionRequest | unknown,
  ): Promise<PiariumExtensionCatalogSnapshot> {
    const request = parsePiariumExtensionCandidateSelectionRequest(requestValue);
    return this.#mutateCatalog(async () => {
      const current = await this.catalog.snapshot();
      if (current.revision !== request.expectedRevision) {
        return this.catalog.discardCandidate(
          request.extensionId,
          request.candidateIntegrity,
          request.expectedRevision,
        );
      }
      await this.supervisor.discardPreparedCandidate(request.extensionId, request.candidateIntegrity);
      try {
        const snapshot = await this.catalog.discardCandidate(
          request.extensionId,
          request.candidateIntegrity,
          request.expectedRevision,
        );
        await this.supervisor.reconcile(snapshot);
        return snapshot;
      } catch (error) {
        await this.supervisor.reconcile(await this.catalog.snapshot()).catch(() => undefined);
        throw error;
      }
    });
  }

  selectCandidate(
    requestValue: PiariumExtensionCandidateSelectionRequest | unknown,
  ): Promise<PiariumExtensionCatalogSnapshot> {
    const request = parsePiariumExtensionCandidateSelectionRequest(requestValue);
    return this.#mutateCatalog(async () => {
      const selected = await this.supervisor.selectCandidate(
        request.extensionId,
        request.candidateIntegrity,
        request.expectedRevision,
      );
      await this.supervisor.reconcile(selected);
      return this.catalog.snapshot();
    });
  }

  requestCandidateApplication(
    requestValue: PiariumExtensionCandidateSelectionRequest | unknown,
  ): Promise<PiariumExtensionCatalogSnapshot> {
    const request = parsePiariumExtensionCandidateSelectionRequest(requestValue);
    return this.#mutateCatalog(() => this.catalog.requestCandidateApplication(
      request.extensionId,
      request.candidateIntegrity,
      request.expectedRevision,
    ));
  }

  reviewCandidateCapabilities(
    requestValue: PiariumExtensionCandidateCapabilityReviewRequest | unknown,
  ): Promise<PiariumExtensionCatalogSnapshot> {
    const request = parsePiariumExtensionCandidateCapabilityReviewRequest(requestValue);
    return this.#mutateCatalog(async () => {
      const reviewed = await this.catalog.reviewCandidateCapabilities(request);
      await this.supervisor.reconcile(reviewed);
      return this.catalog.snapshot();
    });
  }

  reviewCapabilities(
    requestValue: PiariumExtensionCapabilityReviewRequest | unknown,
  ): Promise<PiariumExtensionCatalogSnapshot> {
    const request = parsePiariumExtensionCapabilityReviewRequest(requestValue);
    return this.#mutateCatalog(async () => {
      const reviewed = await this.catalog.reviewCapabilities(request);
      await this.supervisor.reconcile(reviewed);
      return this.catalog.snapshot();
    });
  }

  reportActualState(extensionId: string, stateValue: PiariumExtensionActualState | unknown): Promise<void> {
    const state = parsePiariumExtensionActualState(stateValue);
    return this.#mutate(async () => {
      await this.catalog.reportActualState(extensionId, state);
      this.#publish();
    });
  }

  invokeService(request: PiariumExtensionServiceInvocationRequest | unknown, signal?: AbortSignal): Promise<JsonValue> {
    const parsed = parsePiariumExtensionServiceInvocationRequest(request);
    const providerId = parsed.providerId;
    if (typeof providerId === "string" && this.supervisor.hasStagedProvider(providerId)) {
      return this.supervisor.invokeStagedService(parsed, signal);
    }
    if (providerId) return this.services.invoke(parsed, signal);
    return this.#ensureBuiltinServiceArtifacts(parsed).then(() => this.supervisor.activateForService(parsed)).then(async () => {
      this.#publish();
      return this.#invokeRegisteredService(parsed, signal);
    });
  }

  setServiceSelection(requestValue: PiariumExtensionServiceSelectionRequest | unknown): Promise<PiariumExtensionHostStateSnapshot> {
    const request = parsePiariumExtensionServiceSelectionRequest(requestValue);
    return this.#mutate(async () => {
      this.services.setSelection(request.serviceId, request.version, request.providerId);
      this.#publish();
      return this.state();
    });
  }

  upsertServiceRoutingRule(
    request: PiariumExtensionServiceRoutingRuleUpdateRequest | unknown,
  ): Promise<PiariumExtensionServiceRoutingSnapshot> {
    return this.#mutate(async () => {
      const snapshot = await this.routing.upsertRule(request);
      this.#publish();
      return snapshot;
    });
  }

  removeServiceRoutingRule(
    request: PiariumExtensionServiceRoutingRuleRemoveRequest | unknown,
  ): Promise<PiariumExtensionServiceRoutingSnapshot> {
    return this.#mutate(async () => {
      const snapshot = await this.routing.removeRule(request);
      this.#publish();
      return snapshot;
    });
  }

  updateWorkbenchLayout(
    request: PiariumWorkbenchLayoutUpdateRequest | unknown,
  ): Promise<PiariumWorkbenchProfileSnapshot> {
    return this.#mutate(async () => {
      const snapshot = await this.workbench.updateLayout(request);
      this.#publish();
      return snapshot;
    });
  }

  selectWorkbenchProfile(
    request: PiariumWorkbenchProfileSelectionRequest | unknown,
  ): Promise<PiariumWorkbenchProfileSnapshot> {
    return this.#mutate(async () => {
      const snapshot = await this.workbench.selectProfile(request);
      this.#publish();
      return snapshot;
    });
  }

  upsertWorkbenchProfile(
    request: PiariumWorkbenchProfileUpsertRequest | unknown,
  ): Promise<PiariumWorkbenchProfileSnapshot> {
    return this.#mutate(async () => {
      const snapshot = await this.workbench.upsertProfile(request);
      this.#publish();
      return snapshot;
    });
  }

  removeWorkbenchProfile(
    request: PiariumWorkbenchProfileRemoveRequest | unknown,
  ): Promise<PiariumWorkbenchProfileSnapshot> {
    return this.#mutate(async () => {
      const snapshot = await this.workbench.removeProfile(request);
      this.#publish();
      return snapshot;
    });
  }

  applyWorkbenchProfile(
    requestValue: PiariumWorkbenchProfileApplyRequest | unknown,
  ): Promise<PiariumExtensionCatalogSnapshot> {
    const request = parsePiariumWorkbenchProfileApplyRequest(requestValue);
    return this.#mutateCatalog(async () => {
      const workbench = await this.workbench.read();
      if (!workbench.authoritative) throw new Error("Cannot apply a stale workbench profile");
      const profile = workbench.document.profiles.find((candidate) => candidate.id === request.profileId);
      if (!profile) throw new Error(`Workbench profile is not installed: ${request.profileId}`);
      if (!profile.extensionIds) throw new Error(`Workbench profile does not define an extension set: ${request.profileId}`);
      const snapshot = await this.catalog.setEnabledSet(profile.extensionIds, request.expectedCatalogRevision);
      await this.supervisor.reconcile(snapshot);
      return snapshot;
    });
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    await this.#mutate(() => this.supervisor.shutdown());
    this.#serviceUnsubscribe();
    this.#publish();
    this.#listeners.clear();
  }

  async #invokeRegisteredService(
    request: PiariumExtensionServiceInvocationRequest | unknown,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const parsed = parsePiariumExtensionServiceInvocationRequest(request);
    if (parsed.providerId) return this.services.invoke(parsed, signal);
    const services = this.services.getSnapshot();
    const key = `${parsed.serviceId}@${parsed.version}`;
    const legacySelection = services.selections[key];
    if (legacySelection) return this.services.invoke({ ...parsed, providerId: legacySelection }, signal);
    const candidates = services.providers.filter((provider) => (
      provider.status === "active"
      && provider.descriptor.id === parsed.serviceId
      && provider.descriptor.version === parsed.version
    ));
    const routing = await this.routing.read();
    const resolution = resolvePiariumExtensionServiceRouting({
      candidates: candidates.map((provider) => ({
        providerId: provider.providerId,
        providerKey: provider.providerKey,
      })),
      document: routing.document,
      serviceId: parsed.serviceId,
      version: parsed.version,
      ...(parsed.routing ? { context: parsed.routing } : {}),
    });
    if (resolution.status !== "resolved" || !resolution.providerId) {
      const detail = resolution.diagnostics.map((diagnostic) => diagnostic.message).join("; ");
      throw new Error(detail || `Host service provider is unavailable or ambiguous: ${key}`);
    }
    return this.services.invoke({ ...parsed, providerId: resolution.providerId }, signal);
  }

  async #ensureBuiltinArtifact(extensionId: string): Promise<void> {
    const definition = PIARIUM_BUILTIN_EXTENSION_DEFINITIONS.find((candidate) => (
      candidate.manifest.id === extensionId && candidate.manifest.entrypoints?.host
    ));
    if (!definition) return;
    const snapshot = await this.catalog.snapshot();
    await this.packages.reconcileBuiltinArtifacts([definition], snapshot);
  }

  async #ensureBuiltinServiceArtifacts(request: PiariumExtensionServiceInvocationRequest): Promise<void> {
    const snapshot = await this.catalog.snapshot();
    const enabled = new Set(snapshot.extensions
      .filter((entry) => entry.desired.enabled)
      .map((entry) => entry.manifest.id));
    const definitions = PIARIUM_BUILTIN_EXTENSION_DEFINITIONS.filter((definition) => (
      enabled.has(definition.manifest.id)
      && definition.manifest.entrypoints?.host
      && definition.manifest.provides?.services?.some((service) => (
        service.id === request.serviceId && service.version === request.version
      ))
    ));
    if (definitions.length > 0) await this.packages.reconcileBuiltinArtifacts(definitions, snapshot);
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationQueue.then(operation, operation);
    this.#mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  #mutateCatalog(operation: () => Promise<PiariumExtensionCatalogSnapshot>): Promise<PiariumExtensionCatalogSnapshot> {
    return this.#mutate(async () => {
      const snapshot = await operation();
      this.#publish();
      return snapshot;
    });
  }

  #publish(): void {
    this.#revision += 1;
    for (const listener of this.#listeners) listener();
  }
}
