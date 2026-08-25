import {
  parsePiariumExtensionManifest,
  isPiariumExtensionId,
  type PiariumApplicationSurface,
  type PiariumExtensionActualState,
  type PiariumExtensionDiagnostic,
  type PiariumExtensionServiceProvision,
  type PiariumExtensionServiceRequirement,
  type PiariumExtensionStaticContribution,
} from "@piarium/extension-contract";
import { SurfaceActivationStaleError, SurfaceRegistryConflictError } from "./errors.js";
import { SurfaceOwnerScope } from "./owner-scope.js";
import type {
  SurfaceActivation,
  SurfaceActualState,
  SurfaceActivationContext,
  SurfaceActivationOptions,
  SurfaceContribution,
  SurfaceExternalService,
  SurfaceExtensionRuntimeOptions,
  SurfaceLayoutReference,
  SurfaceOwnerHandle,
  SurfaceOwnerIdentity,
  SurfaceRegistrySnapshot,
  SurfaceService,
} from "./types.js";

interface ActiveOwner {
  contributions: SurfaceContribution[];
  externalServices: SurfaceExternalService[];
  owner: SurfaceOwnerIdentity;
  requirements: PiariumExtensionServiceRequirement[];
  scope: SurfaceOwnerScope;
  services: SurfaceService[];
}

interface RequestVersion {
  desiredRevision: number;
  generation: number;
}

const ACTUAL_REALM_KIND = "surface" as const;

function ownerKey(owner: SurfaceOwnerIdentity): string {
  return `${owner.extensionId}\0${owner.realmId}\0${owner.entrypointId}`;
}

function compareRequest(left: RequestVersion, right: RequestVersion): number {
  return left.desiredRevision - right.desiredRevision || left.generation - right.generation;
}

function diagnostic(owner: SurfaceOwnerIdentity, code: string, message: string): PiariumExtensionDiagnostic {
  return {
    code,
    extensionId: owner.extensionId,
    message,
    realmId: owner.realmId,
    severity: "error",
    timestamp: new Date().toISOString(),
  };
}

function actual(
  owner: SurfaceOwnerIdentity,
  status: PiariumExtensionActualState["status"],
  diagnostics: PiariumExtensionDiagnostic[] = [],
): SurfaceActualState {
  return {
    desiredRevision: owner.desiredRevision,
    diagnostics,
    entrypointId: owner.entrypointId,
    extensionId: owner.extensionId,
    extensionVersion: owner.extensionVersion,
    generation: owner.generation,
    hostId: owner.hostId,
    realmId: owner.realmId,
    realmKind: ACTUAL_REALM_KIND,
    status,
    updatedAt: new Date().toISOString(),
  };
}

function validateOwner(owner: SurfaceOwnerIdentity): void {
  parsePiariumExtensionManifest({
    schemaVersion: 1,
    id: owner.extensionId,
    version: owner.extensionVersion,
    engines: { piarium: "*" },
  });
  if (!isPiariumExtensionId(owner.entrypointId)) throw new Error(`Invalid Surface owner entrypoint ID: ${owner.entrypointId}`);
  if (!owner.realmId.trim()) throw new Error("Surface owner realmId is required");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner.hostId)) {
    throw new Error("Surface owner hostId must be an application-host UUID");
  }
  if (!Number.isSafeInteger(owner.generation) || owner.generation < 0) throw new Error("Surface owner generation must be a non-negative safe integer");
  if (!Number.isSafeInteger(owner.desiredRevision) || owner.desiredRevision <= 0) throw new Error("Surface owner desired revision must be a positive safe integer");
}

function normalizeRequirements(
  owner: SurfaceOwnerIdentity,
  requirements: PiariumExtensionServiceRequirement[],
): PiariumExtensionServiceRequirement[] {
  const parsed = parsePiariumExtensionManifest({
    schemaVersion: 1,
    id: owner.extensionId,
    version: owner.extensionVersion,
    engines: { piarium: "*" },
    requires: { services: requirements },
  });
  return parsed.requires?.services ?? [];
}

function normalizeContribution(
  owner: SurfaceOwnerIdentity,
  descriptor: PiariumExtensionStaticContribution,
): PiariumExtensionStaticContribution {
  const parsed = parsePiariumExtensionManifest({
    schemaVersion: 1,
    id: owner.extensionId,
    version: owner.extensionVersion,
    engines: { piarium: "*" },
    entrypoints: {
      surfaces: [{
        id: owner.entrypointId,
        file: "runtime-entrypoint.mjs",
        mode: "managed",
        supports: descriptor.supports,
      }],
    },
    ...(descriptor.requiresCapabilities && descriptor.requiresCapabilities.length > 0
      ? { capabilities: { surface: descriptor.requiresCapabilities } }
      : {}),
    contributions: [descriptor],
  });
  const normalized = parsed.contributions?.[0];
  if (!normalized) throw new Error(`Surface contribution could not be normalized: ${descriptor.id}`);
  return normalized;
}

function validateService(descriptor: PiariumExtensionServiceProvision): PiariumExtensionServiceProvision {
  if (!isPiariumExtensionId(descriptor.id)) throw new Error(`Invalid Surface service ID: ${descriptor.id}`);
  if (!Number.isSafeInteger(descriptor.version) || descriptor.version <= 0) throw new Error(`Invalid Surface service version: ${descriptor.id}`);
  if (descriptor.multiple !== undefined && typeof descriptor.multiple !== "boolean") throw new Error(`Invalid Surface service multiplicity: ${descriptor.id}`);
  return { id: descriptor.id, version: descriptor.version, ...(descriptor.multiple !== undefined ? { multiple: descriptor.multiple } : {}) };
}

function contributionOrder(
  left: SurfaceContribution,
  right: SurfaceContribution,
  layoutReferences: ReadonlyMap<string, SurfaceLayoutReference>,
): number {
  const leftOrder = layoutReferences.get(left.descriptor.id)?.order ?? left.descriptor.placement?.order ?? 0;
  const rightOrder = layoutReferences.get(right.descriptor.id)?.order ?? right.descriptor.placement?.order ?? 0;
  return leftOrder - rightOrder
    || left.descriptor.id.localeCompare(right.descriptor.id);
}

function selectVisibleContributions(
  contributions: SurfaceContribution[],
  replacementSelections: ReadonlyMap<string, string>,
  layoutReferences: ReadonlyMap<string, SurfaceLayoutReference>,
): SurfaceContribution[] {
  const additive: SurfaceContribution[] = [];
  const replacements = new Map<string, SurfaceContribution[]>();
  for (const contribution of contributions) {
    if (layoutReferences.get(contribution.descriptor.id)?.visible === false) continue;
    const target = contribution.descriptor.replacement?.target;
    if (!target) additive.push(contribution);
    else {
      const group = replacements.get(target) ?? [];
      group.push(contribution);
      replacements.set(target, group);
    }
  }
  for (const [target, candidates] of replacements) {
    const selectedId = replacementSelections.get(target);
    const selected = selectedId ? candidates.find((candidate) => candidate.descriptor.id === selectedId) : undefined;
    const fallback = candidates.find((candidate) => candidate.descriptor.data.fallback === true);
    if (selected ?? fallback) additive.push((selected ?? fallback) as SurfaceContribution);
  }
  return orderContributions(additive, layoutReferences);
}

function orderContributions(
  contributions: SurfaceContribution[],
  layoutReferences: ReadonlyMap<string, SurfaceLayoutReference> = new Map(),
): SurfaceContribution[] {
  const byId = new Map(contributions.map((contribution) => [contribution.descriptor.id, contribution]));
  const outgoing = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const id of byId.keys()) {
    outgoing.set(id, new Set());
    indegree.set(id, 0);
  }
  const edge = (from: string, to: string) => {
    if (from === to || !byId.has(from) || !byId.has(to)) return;
    const targets = outgoing.get(from) as Set<string>;
    if (targets.has(to)) return;
    targets.add(to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  };
  for (const contribution of contributions) {
    for (const before of contribution.descriptor.placement?.before ?? []) edge(contribution.descriptor.id, before);
    for (const after of contribution.descriptor.placement?.after ?? []) edge(after, contribution.descriptor.id);
  }
  const ready = contributions
    .filter((item) => indegree.get(item.descriptor.id) === 0)
    .sort((left, right) => contributionOrder(left, right, layoutReferences));
  const ordered: SurfaceContribution[] = [];
  while (ready.length > 0) {
    const next = ready.shift() as SurfaceContribution;
    ordered.push(next);
    for (const target of outgoing.get(next.descriptor.id) ?? []) {
      const remaining = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        const contribution = byId.get(target);
        if (contribution) {
          ready.push(contribution);
          ready.sort((left, right) => contributionOrder(left, right, layoutReferences));
        }
      }
    }
  }
  if (ordered.length !== contributions.length) {
    const cycle = contributions.map((item) => item.descriptor.id).filter((id) => !ordered.some((item) => item.descriptor.id === id));
    throw new SurfaceRegistryConflictError("Surface contribution ordering contains a cycle", cycle);
  }
  return ordered;
}

export class SurfaceExtensionRuntime {
  readonly surface: PiariumApplicationSurface;
  readonly #activeOwners = new Map<string, ActiveOwner>();
  readonly #actual = new Map<string, SurfaceActualState>();
  readonly #latestRequests = new Map<string, RequestVersion>();
  readonly #listeners = new Set<() => void>();
  readonly #layoutReferences = new Map<string, SurfaceLayoutReference>();
  #lifecycleQueue: Promise<void> = Promise.resolve();
  readonly #replacementSelections = new Map<string, string>();
  readonly #serviceSelections = new Map<string, string>();
  #snapshot: SurfaceRegistrySnapshot = {
    actual: [],
    contributions: [],
    layoutReferences: [],
    replacementSelections: {},
    revision: 0,
    serviceSelections: {},
    services: [],
    visibleContributions: [],
  };

  constructor(options: SurfaceExtensionRuntimeOptions) {
    this.surface = options.surface;
  }

  getSnapshot = (): SurfaceRegistrySnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  activate(options: SurfaceActivationOptions, activation: SurfaceActivation): Promise<SurfaceOwnerHandle> {
    return this.activateWithCommit(options, activation, async () => undefined);
  }

  activateWithCommit(
    options: SurfaceActivationOptions,
    activation: SurfaceActivation,
    commit: () => void | Promise<void>,
  ): Promise<SurfaceOwnerHandle> {
    return this.activateBatchWithCommit([{ activation, options }], commit)
      .then((handles) => handles[0] as SurfaceOwnerHandle);
  }

  activateBatchWithCommit(
    requests: readonly { activation: SurfaceActivation; options: SurfaceActivationOptions }[],
    commit: () => void | Promise<void>,
  ): Promise<SurfaceOwnerHandle[]> {
    if (requests.length === 0) return Promise.resolve([]);
    const extensionId = requests[0]?.options.owner.extensionId as string;
    const keys = new Set<string>();
    for (const request of requests) {
      validateOwner(request.options.owner);
      if (request.options.owner.extensionId !== extensionId) {
        throw new Error("A transactional Surface activation batch must belong to one extension");
      }
      const key = ownerKey(request.options.owner);
      if (keys.has(key)) throw new Error(`Duplicate Surface owner in activation batch: ${request.options.owner.entrypointId}`);
      keys.add(key);
      this.#markLatest(key, request.options.owner);
    }
    return this.#enqueue(extensionId, async () => {
      const previous = new Map<string, ActiveOwner | undefined>();
      const candidates = new Map<string, ActiveOwner>();
      for (const request of requests) {
        const key = ownerKey(request.options.owner);
        this.#assertLatest(key, request.options.owner);
        previous.set(key, this.#activeOwners.get(key));
        this.#actual.set(key, actual(request.options.owner, previous.get(key) ? "updating" : "activating"));
      }
      this.#publish();

      try {
        for (const request of requests) {
          const owner = request.options.owner;
          const key = ownerKey(owner);
          const scope = new SurfaceOwnerScope();
          const stagedContributions: SurfaceContribution[] = [];
          const stagedServices: SurfaceService[] = [];
          const granted = new Set(request.options.grantedCapabilities ?? []);
          const requirements = normalizeRequirements(owner, request.options.requirements ?? []);
          const externalServices = [...(request.options.externalServices ?? [])].map((service) => ({
            descriptor: validateService(service.descriptor),
            ...(service.dispose ? { dispose: service.dispose } : {}),
            implementation: service.implementation,
            providerId: service.providerId,
          }));
          for (const service of externalServices) {
            if (service.dispose) scope.onDispose(service.dispose);
          }
          const context: SurfaceActivationContext = {
            signal: scope.signal,
            contribute: (descriptor, implementation) => {
              const normalized = normalizeContribution(owner, descriptor);
              if (!normalized.supports.includes(this.surface)) {
                throw new SurfaceRegistryConflictError(
                  `Contribution ${normalized.id} does not support ${this.surface}`,
                  [normalized.id],
                );
              }
              const missing = (normalized.requiresCapabilities ?? []).filter((capability) => !granted.has(capability));
              if (missing.length > 0) {
                throw new SurfaceRegistryConflictError(`Contribution ${normalized.id} lacks capability grants`, missing);
              }
              stagedContributions.push({ descriptor: normalized, implementation, owner: { ...owner } });
            },
            provide: (descriptor, implementation) => {
              stagedServices.push({ descriptor: validateService(descriptor), implementation, owner: { ...owner } });
            },
            onDispose: (disposer) => scope.onDispose(disposer),
            useService: <TImplementation = unknown>(id: string, version: number): TImplementation | undefined => {
              const external = externalServices.filter((service) => service.descriptor.id === id && service.descriptor.version === version);
              if (external.length === 1) return external[0]?.implementation as TImplementation;
              return this.getService<TImplementation>(id, version);
            },
            useServices: <TImplementation = unknown>(id: string, version: number): TImplementation[] => [
              ...this.getServices<TImplementation>(id, version),
              ...externalServices
                .filter((service) => service.descriptor.id === id && service.descriptor.version === version)
                .map((service) => service.implementation as TImplementation),
            ],
          };
          try {
            await request.activation(context);
          } catch (error) {
            await scope.dispose(error).catch(() => undefined);
            throw error;
          }
          this.#assertLatest(key, owner);
          candidates.set(key, {
            contributions: stagedContributions,
            externalServices,
            owner: { ...owner },
            requirements,
            scope,
            services: stagedServices,
          });
        }
        this.#validateCandidates(candidates);
        for (const request of requests) this.#assertLatest(ownerKey(request.options.owner), request.options.owner);
        await commit();
        // The external commit is the transaction boundary. A newer queued lifecycle request may
        // arrive while it is in flight; publish this committed generation first, then let that
        // queued request replace or deactivate it without turning a successful catalog commit
        // into a partial rollback.
        for (const [key, candidate] of candidates) {
          this.#activeOwners.set(key, candidate);
          this.#actual.set(key, actual(candidate.owner, "active"));
        }
        this.#publish();
        for (const [key, oldOwner] of previous) {
          if (!oldOwner) continue;
          await oldOwner.scope.dispose("Surface owner generation replaced").catch((error) => {
            const state = this.#actual.get(key);
            if (state) state.diagnostics = [diagnostic(state, "previous_generation_cleanup_failed", error instanceof Error ? error.message : String(error))];
          });
        }
        this.#publish();
        return requests.map((request) => this.#handle(request.options.owner));
      } catch (error) {
        for (const candidate of candidates.values()) await candidate.scope.dispose(error).catch(() => undefined);
        for (const request of requests) {
          const key = ownerKey(request.options.owner);
          const oldOwner = previous.get(key);
          this.#actual.set(key, oldOwner
            ? actual(oldOwner.owner, "active", [diagnostic(request.options.owner, "candidate_activation_failed", error instanceof Error ? error.message : String(error))])
            : actual(request.options.owner, error instanceof SurfaceActivationStaleError ? "inactive" : "failed", [
              diagnostic(request.options.owner, error instanceof SurfaceActivationStaleError ? "activation_superseded" : "activation_failed", error instanceof Error ? error.message : String(error)),
            ]));
        }
        this.#publish();
        throw error;
      }
    });
  }

  deactivate(owner: SurfaceOwnerIdentity): Promise<void> {
    validateOwner(owner);
    const key = ownerKey(owner);
    this.#markLatest(key, owner);
    return this.#enqueue(owner.extensionId, async () => {
      this.#assertLatest(key, owner);
      const active = this.#activeOwners.get(key);
      if (!active) {
        this.#actual.set(key, actual(owner, "inactive"));
        this.#publish();
        return;
      }
      await this.#deactivateTree(key, owner, new Set());
    });
  }

  markRestartRequired(owner: SurfaceOwnerIdentity, code: string, message: string): void {
    validateOwner(owner);
    const key = ownerKey(owner);
    this.#actual.set(key, actual(owner, "restart-required", [diagnostic(owner, code, message)]));
    this.#publish();
  }

  setReplacementSelection(target: string, contributionId: string | null): void {
    if (!isPiariumExtensionId(target)) throw new Error(`Invalid replacement target: ${target}`);
    if (contributionId === null) this.#replacementSelections.delete(target);
    else {
      if (!isPiariumExtensionId(contributionId)) throw new Error(`Invalid replacement contribution ID: ${contributionId}`);
      this.#replacementSelections.set(target, contributionId);
    }
    this.#publish();
  }

  setLayoutReferences(references: readonly SurfaceLayoutReference[]): void {
    this.setWorkbenchState(references, Object.fromEntries(this.#replacementSelections));
  }

  setWorkbenchState(
    references: readonly SurfaceLayoutReference[],
    replacementSelections: Readonly<Record<string, string>>,
  ): void {
    const next = new Map<string, SurfaceLayoutReference>();
    for (const reference of references) {
      if (!isPiariumExtensionId(reference.contributionId)) {
        throw new Error(`Invalid Surface layout contribution ID: ${reference.contributionId}`);
      }
      if (next.has(reference.contributionId)) {
        throw new Error(`Duplicate Surface layout contribution ID: ${reference.contributionId}`);
      }
      if (reference.order !== undefined && !Number.isFinite(reference.order)) {
        throw new Error(`Invalid Surface layout order: ${reference.contributionId}`);
      }
      if (reference.region !== undefined && !reference.region.trim()) {
        throw new Error(`Invalid Surface layout region: ${reference.contributionId}`);
      }
      if (reference.size !== undefined && (!Number.isFinite(reference.size) || reference.size <= 0)) {
        throw new Error(`Invalid Surface layout size: ${reference.contributionId}`);
      }
      if (reference.visible !== undefined && typeof reference.visible !== "boolean") {
        throw new Error(`Invalid Surface layout visibility: ${reference.contributionId}`);
      }
      next.set(reference.contributionId, {
        contributionId: reference.contributionId,
        ...(reference.order !== undefined ? { order: reference.order } : {}),
        ...(reference.region !== undefined ? { region: reference.region } : {}),
        ...(reference.size !== undefined ? { size: reference.size } : {}),
        ...(reference.visible !== undefined ? { visible: reference.visible } : {}),
      });
    }
    const nextSelections = new Map<string, string>();
    for (const [target, contributionId] of Object.entries(replacementSelections)) {
      if (!isPiariumExtensionId(target)) throw new Error(`Invalid replacement target: ${target}`);
      if (!isPiariumExtensionId(contributionId)) throw new Error(`Invalid replacement contribution ID: ${contributionId}`);
      nextSelections.set(target, contributionId);
    }
    this.#layoutReferences.clear();
    for (const [id, reference] of next) this.#layoutReferences.set(id, reference);
    this.#replacementSelections.clear();
    for (const [target, contributionId] of nextSelections) this.#replacementSelections.set(target, contributionId);
    this.#publish();
  }

  setServiceSelection(id: string, version: number, extensionId: string | null): void {
    if (!isPiariumExtensionId(id) || !Number.isSafeInteger(version) || version <= 0) {
      throw new Error(`Invalid Surface service selection: ${id}@${version}`);
    }
    const key = `${id}@${version}`;
    if (extensionId === null) this.#serviceSelections.delete(key);
    else {
      if (!isPiariumExtensionId(extensionId)) throw new Error(`Invalid Surface service provider ID: ${extensionId}`);
      this.#serviceSelections.set(key, extensionId);
    }
    this.#publish();
  }

  getService<TImplementation = unknown>(id: string, version: number): TImplementation | undefined {
    const services = this.#matchingServices(id, version);
    const selectedExtensionId = this.#serviceSelections.get(`${id}@${version}`);
    const selected = selectedExtensionId
      ? services.find((service) => service.owner.extensionId === selectedExtensionId)
      : services.length === 1 ? services[0] : undefined;
    return selected?.implementation as TImplementation | undefined;
  }

  getServices<TImplementation = unknown>(id: string, version: number): TImplementation[] {
    return this.#matchingServices(id, version).map((service) => service.implementation as TImplementation);
  }

  #handle(owner: SurfaceOwnerIdentity): SurfaceOwnerHandle {
    return {
      owner: { ...owner },
      deactivate: (desiredRevision, generation) => this.deactivate({
        ...owner,
        desiredRevision,
        generation,
      }),
    };
  }

  #matchingServices(
    id: string,
    version: number,
    owners: ReadonlyMap<string, ActiveOwner> = this.#activeOwners,
  ): SurfaceService[] {
    return [...owners.values()]
      .flatMap((owner) => owner.services)
      .filter((service) => service.descriptor.id === id && service.descriptor.version === version)
      .sort((left, right) => left.owner.extensionId.localeCompare(right.owner.extensionId));
  }

  async #deactivateTree(
    key: string,
    requestedOwner: SurfaceOwnerIdentity,
    visited: Set<string>,
  ): Promise<void> {
    if (visited.has(key)) return;
    visited.add(key);
    const active = this.#activeOwners.get(key);
    if (!active) return;
    const withoutProvider = new Map(this.#activeOwners);
    withoutProvider.delete(key);
    for (const [dependentKey, dependent] of [...withoutProvider]) {
      if (this.#requirementsSatisfied(dependent, withoutProvider)) continue;
      const dependentOwner = {
        ...dependent.owner,
        generation: dependent.owner.generation + 1,
      };
      await this.#deactivateTree(dependentKey, dependentOwner, visited);
      this.#actual.set(dependentKey, actual(dependentOwner, "inactive", [
        diagnostic(dependentOwner, "required_service_withdrawn", "A required Surface service was withdrawn"),
      ]));
      withoutProvider.delete(dependentKey);
    }
    this.#actual.set(key, actual(requestedOwner, "deactivating"));
    this.#activeOwners.delete(key);
    this.#publish();
    let diagnostics: PiariumExtensionDiagnostic[] = [];
    try {
      await active.scope.dispose("Surface extension disabled");
    } catch (error) {
      diagnostics = [diagnostic(requestedOwner, "deactivation_cleanup_failed", error instanceof Error ? error.message : String(error))];
    }
    this.#actual.set(key, actual(requestedOwner, "inactive", diagnostics));
    this.#publish();
  }

  #requirementsSatisfied(owner: ActiveOwner, owners: ReadonlyMap<string, ActiveOwner>): boolean {
    return owner.requirements.every((requirement) => {
      if (requirement.optional) return true;
      const local = this.#matchingServices(requirement.id, requirement.version, owners);
      const external = owner.externalServices.filter((service) => (
        service.descriptor.id === requirement.id && service.descriptor.version === requirement.version
      ));
      const count = local.length + external.length;
      if (requirement.binding === "selected") {
        const selected = this.#serviceSelections.get(`${requirement.id}@${requirement.version}`);
        return external.length > 0 || Boolean(selected && local.some((service) => service.owner.extensionId === selected));
      }
      if ((requirement.binding ?? "single") === "single") return count === 1;
      return count > 0;
    });
  }

  #validateCandidates(candidates: ReadonlyMap<string, ActiveOwner>): void {
    const candidateOwners = new Map(this.#activeOwners);
    for (const [key, candidate] of candidates) candidateOwners.set(key, candidate);
    const allContributions = [...candidateOwners.values()].flatMap((owner) => owner.contributions);
    const duplicateContributions = allContributions
      .map((item) => item.descriptor.id)
      .filter((id, index, values) => values.indexOf(id) !== index);
    if (duplicateContributions.length > 0) {
      throw new SurfaceRegistryConflictError("Surface contribution IDs must be unique", [...new Set(duplicateContributions)]);
    }
    orderContributions(allContributions);
    const fallbackReplacements = new Map<string, SurfaceContribution[]>();
    for (const contribution of allContributions) {
      const target = contribution.descriptor.replacement?.target;
      if (!target || contribution.descriptor.data.fallback !== true) continue;
      const group = fallbackReplacements.get(target) ?? [];
      group.push(contribution);
      fallbackReplacements.set(target, group);
    }
    for (const [target, fallbacks] of fallbackReplacements) {
      if (fallbacks.length <= 1) continue;
      throw new SurfaceRegistryConflictError(
        `Surface replacement ${target} has more than one fallback`,
        fallbacks.map((fallback) => fallback.descriptor.id),
      );
    }

    const allServices = [...candidateOwners.values()].flatMap((owner) => owner.services);
    const serviceGroups = new Map<string, SurfaceService[]>();
    for (const service of allServices) {
      const serviceKey = `${service.descriptor.id}@${service.descriptor.version}`;
      const group = serviceGroups.get(serviceKey) ?? [];
      group.push(service);
      serviceGroups.set(serviceKey, group);
    }
    for (const [serviceKey, providers] of serviceGroups) {
      if (providers.length > 1 && providers.some((provider) => provider.descriptor.multiple !== true)) {
        throw new SurfaceRegistryConflictError(`Surface service ${serviceKey} does not allow multiple providers`, providers.map((provider) => provider.owner.extensionId));
      }
    }
    for (const activeOwner of candidateOwners.values()) {
      for (const requirement of activeOwner.requirements) {
        if (requirement.optional) continue;
        const serviceKey = `${requirement.id}@${requirement.version}`;
        const providers = serviceGroups.get(serviceKey) ?? [];
        const externalProviders = activeOwner.externalServices.filter((service) => (
          service.descriptor.id === requirement.id && service.descriptor.version === requirement.version
        ));
        const providerCount = providers.length + externalProviders.length;
        if (providerCount === 0) {
          throw new SurfaceRegistryConflictError(`Required Surface service is unavailable: ${serviceKey}`, [requirement.id]);
        }
        if (requirement.binding === "selected") {
          const selected = this.#serviceSelections.get(serviceKey);
          const selectedLocal = selected && providers.some((provider) => provider.owner.extensionId === selected);
          if (!selectedLocal && externalProviders.length === 0) {
            throw new SurfaceRegistryConflictError(`Selected Surface service provider is unavailable: ${serviceKey}`, [requirement.id]);
          }
        } else if ((requirement.binding ?? "single") === "single" && providerCount !== 1) {
          throw new SurfaceRegistryConflictError(`Required Surface service is ambiguous: ${serviceKey}`, [
            ...providers.map((provider) => provider.owner.extensionId),
            ...externalProviders.map((provider) => provider.providerId),
          ]);
        }
      }
    }
  }

  #markLatest(key: string, request: RequestVersion): void {
    const previous = this.#latestRequests.get(key);
    if (previous && compareRequest(request, previous) < 0) {
      throw new SurfaceActivationStaleError("Surface lifecycle request is older than the current desired generation");
    }
    this.#latestRequests.set(key, { desiredRevision: request.desiredRevision, generation: request.generation });
  }

  #assertLatest(key: string, request: RequestVersion): void {
    const latest = this.#latestRequests.get(key);
    if (!latest || compareRequest(request, latest) !== 0) {
      throw new SurfaceActivationStaleError("Surface activation was superseded by a newer desired generation");
    }
  }

  #publish(): void {
    const contributions = [...this.#activeOwners.values()].flatMap((owner) => owner.contributions);
    const services = [...this.#activeOwners.values()].flatMap((owner) => owner.services);
    const visibleContributions = selectVisibleContributions(
      contributions,
      this.#replacementSelections,
      this.#layoutReferences,
    );
    this.#snapshot = {
      actual: [...this.#actual.values()].map((state) => ({ ...state, diagnostics: [...state.diagnostics] })),
      contributions: [...contributions],
      layoutReferences: [...this.#layoutReferences.values()].map((reference) => ({ ...reference })),
      replacementSelections: Object.fromEntries(this.#replacementSelections),
      revision: this.#snapshot.revision + 1,
      serviceSelections: Object.fromEntries(this.#serviceSelections),
      services: [...services],
      visibleContributions,
    };
    for (const listener of this.#listeners) listener();
  }

  #enqueue<T>(_extensionId: string, operation: () => Promise<T>): Promise<T> {
    const result = this.#lifecycleQueue.then(operation, operation);
    this.#lifecycleQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
