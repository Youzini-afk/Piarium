import {
  PIARIUM_EXTENSION_CATALOG_SCHEMA_VERSION,
  type PiariumExtensionActualState,
  type PiariumExtensionCatalogEntry,
  type PiariumExtensionCatalogSnapshot,
  type PiariumExtensionCandidateCapabilityReviewRequest,
  type PiariumExtensionCapabilityGrant,
  type PiariumExtensionCapabilityReviewRequest,
  type PiariumExtensionInstallationRecord,
  type PiariumExtensionPreparedArtifact,
} from "@piarium/extension-contract";
import type { PiariumBuiltinExtensionDefinition } from "@piarium/extension-builtins";
import { ExtensionCatalogStaleStateError } from "./errors.js";
import { ExtensionCatalogStore, type CatalogReadState } from "./catalog-store.js";

function actualKey(extensionId: string, state: PiariumExtensionActualState): string {
  return `${extensionId}\0${state.realmKind}\0${state.realmId}\0${state.entrypointId}`;
}

export class ApplicationExtensionCatalog {
  readonly store: ExtensionCatalogStore;
  readonly #actual = new Map<string, { extensionId: string; state: PiariumExtensionActualState }>();

  constructor(options: { dataDir: string; store?: ExtensionCatalogStore }) {
    this.store = options.store ?? new ExtensionCatalogStore(options.dataDir);
  }

  async snapshot(): Promise<PiariumExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([this.store.getHostIdentity(), this.store.read()]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async upsert(record: PiariumExtensionInstallationRecord, expectedRevision: number): Promise<PiariumExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.upsert(record, expectedRevision),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async remove(extensionId: string, expectedRevision: number): Promise<PiariumExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.remove(extensionId, expectedRevision),
    ]);
    for (const [key, value] of this.#actual) if (value.extensionId === extensionId) this.#actual.delete(key);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async setEnabled(extensionId: string, enabled: boolean, expectedRevision: number): Promise<PiariumExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.setEnabled(extensionId, enabled, expectedRevision),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async setAllEnabled(enabled: boolean, expectedRevision: number): Promise<PiariumExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.setAllEnabled(enabled, expectedRevision),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async setEnabledSet(extensionIds: readonly string[], expectedRevision: number): Promise<PiariumExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.setEnabledSet(extensionIds, expectedRevision),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async reconcileBuiltins(
    definitions: readonly PiariumBuiltinExtensionDefinition[],
    ownedPrefix: string,
  ): Promise<PiariumExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.reconcileBuiltins(definitions, ownedPrefix),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async setCapabilityGrant(
    extensionId: string,
    grant: PiariumExtensionCapabilityGrant,
    expectedRevision: number,
  ): Promise<PiariumExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.setCapabilityGrant(extensionId, grant, expectedRevision),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async reviewCapabilities(
    request: PiariumExtensionCapabilityReviewRequest,
  ): Promise<PiariumExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.reviewCapabilities(request.extensionId, request.decisions, request.expectedRevision),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async stageCandidate(candidate: PiariumExtensionPreparedArtifact, expectedRevision: number): Promise<PiariumExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.stageCandidate(candidate, expectedRevision),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async reviewCandidateCapabilities(
    request: PiariumExtensionCandidateCapabilityReviewRequest,
  ): Promise<PiariumExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.reviewCandidateCapabilities(
        request.extensionId,
        request.candidateIntegrity,
        request.decisions,
        request.expectedRevision,
      ),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async selectCandidate(
    extensionId: string,
    candidateIntegrity: string,
    expectedRevision: number,
  ): Promise<PiariumExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.selectCandidate(extensionId, candidateIntegrity, expectedRevision),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async requestCandidateApplication(
    extensionId: string,
    candidateIntegrity: string,
    expectedRevision: number,
  ): Promise<PiariumExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.requestCandidateApplication(extensionId, candidateIntegrity, expectedRevision),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async discardCandidate(
    extensionId: string,
    candidateIntegrity: string,
    expectedRevision: number,
  ): Promise<PiariumExtensionCatalogSnapshot> {
    const [identity, read] = await Promise.all([
      this.store.getHostIdentity(),
      this.store.discardCandidate(extensionId, candidateIntegrity, expectedRevision),
    ]);
    return this.#publicSnapshot(identity.hostId, read);
  }

  async reportActualState(extensionId: string, state: PiariumExtensionActualState): Promise<void> {
    const snapshot = await this.snapshot();
    if (state.hostId !== snapshot.hostId) throw new ExtensionCatalogStaleStateError("Actual state belongs to another application host");
    const entry = snapshot.extensions.find((item) => item.manifest.id === extensionId);
    if (!entry) throw new ExtensionCatalogStaleStateError(`Actual state belongs to an uninstalled extension: ${extensionId}`);
    if (state.desiredRevision !== entry.desired.revision) {
      throw new ExtensionCatalogStaleStateError(`Actual state desired revision ${state.desiredRevision} is stale; current revision is ${entry.desired.revision}`);
    }
    const key = actualKey(extensionId, state);
    const previous = this.#actual.get(key)?.state;
    if (previous && state.generation < previous.generation) {
      throw new ExtensionCatalogStaleStateError(`Actual state generation ${state.generation} is stale; current generation is ${previous.generation}`);
    }
    this.#actual.set(key, { extensionId, state: structuredClone(state) });
  }

  #publicSnapshot(hostId: string, read: CatalogReadState): PiariumExtensionCatalogSnapshot {
    const extensions = Object.values(read.document.extensions)
      .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
      .map<PiariumExtensionCatalogEntry>((record) => {
        const actual = [...this.#actual.values()]
          .filter((value) => (
            value.extensionId === record.manifest.id
            && value.state.hostId === hostId
            && value.state.desiredRevision === record.desired.revision
          ))
          .map((value) => structuredClone(value.state))
          .sort((left, right) => left.realmId.localeCompare(right.realmId) || left.entrypointId.localeCompare(right.entrypointId));
        return {
          actual,
          ...(record.candidate ? {
            candidate: {
              applyRequested: record.candidate.applyRequested,
              capabilitiesReviewed: record.candidate.capabilitiesReviewed,
              capabilityDelta: structuredClone(record.candidate.capabilityDelta),
              capabilityGrants: structuredClone(record.candidate.capabilityGrants),
              integrity: record.candidate.integrity,
              manifest: structuredClone(record.candidate.manifest),
              preparedAt: record.candidate.preparedAt,
              resolvedVersion: record.candidate.resolvedVersion,
              source: {
                display: record.candidate.source.display,
                kind: record.candidate.source.kind,
              },
            },
          } : {}),
          capabilityGrants: structuredClone(record.capabilityGrants),
          desired: structuredClone(record.desired),
          installedAt: record.installedAt,
          manifest: structuredClone(record.manifest),
          resolvedVersion: record.resolvedVersion,
          selectedVersion: record.selectedVersion,
          source: { display: record.source.display, kind: record.source.kind },
          updatedAt: record.updatedAt,
          ...(record.integrity ? { integrity: record.integrity } : {}),
        };
      });
    return {
      authoritative: read.authoritative,
      diagnostics: structuredClone(read.diagnostics),
      extensions,
      hostId,
      loadedAt: new Date().toISOString(),
      revision: read.document.revision,
      schemaVersion: PIARIUM_EXTENSION_CATALOG_SCHEMA_VERSION,
      storageState: read.storageState,
    };
  }
}
