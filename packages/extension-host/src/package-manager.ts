import {
  assertPiariumApplicationVersion,
  assertPiariumExtensionManifestCompatibility,
  parsePiariumExtensionAssetRequest,
  parsePiariumExtensionCandidateSelectionRequest,
  parsePiariumExtensionManagedEntrypointRequest,
  type PiariumExtensionActualState,
  type PiariumExtensionAssetPayload,
  type PiariumExtensionAssetRequest,
  type PiariumExtensionCandidateSelectionRequest,
  type PiariumExtensionCatalogSnapshot,
  type PiariumExtensionInstallationRecord,
  type PiariumExtensionManagedEntrypointPayload,
  type PiariumExtensionManagedEntrypointRequest,
  type PiariumExtensionLocalSourceReloadRequest,
  type PiariumExtensionLocalSourceReloadResult,
  type PiariumExtensionManifest,
  type PiariumExtensionPackageSource,
} from "@piarium/extension-contract";
import { ApplicationExtensionCatalog } from "./application-catalog.js";
import { ExtensionArtifactStore } from "./artifact-store.js";
import type { BrokeredHostEntrypointArtifact } from "./artifact-store.js";
import { ExtensionCatalogRevisionConflictError } from "./errors.js";

export interface ExtensionPackageManagerOptions {
  artifacts?: ExtensionArtifactStore;
  catalog: ApplicationExtensionCatalog;
  dataDir: string;
  piariumVersion: string;
}

export class ExtensionPackageManager {
  readonly artifacts: ExtensionArtifactStore;
  readonly catalog: ApplicationExtensionCatalog;
  readonly piariumVersion: string;

  constructor(options: ExtensionPackageManagerOptions) {
    this.catalog = options.catalog;
    this.piariumVersion = options.piariumVersion;
    assertPiariumApplicationVersion(this.piariumVersion);
    this.artifacts = options.artifacts ?? new ExtensionArtifactStore({
      dataDir: options.dataDir,
      piariumVersion: options.piariumVersion,
    });
    if (this.artifacts.piariumVersion !== this.piariumVersion) {
      throw new Error("Extension artifact store targets another Piarium application version");
    }
  }

  async installOrStage(
    source: PiariumExtensionPackageSource,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<PiariumExtensionCatalogSnapshot> {
    const candidate = await this.artifacts.prepare(source, signal);
    assertPiariumExtensionManifestCompatibility(candidate.manifest, this.piariumVersion);
    const current = await this.catalog.store.read();
    if (current.document.revision !== expectedRevision) {
      // Use the catalog mutation to raise the normal revision-conflict error and keep one failure envelope.
      return this.catalog.stageCandidate(candidate, expectedRevision);
    }
    const installed = current.document.extensions[candidate.manifest.id];
    if (installed?.source.kind === "builtin" && candidate.source.kind !== "builtin") {
      throw new Error(`Built-in Piarium extensions are managed by the distribution: ${candidate.manifest.id}`);
    }
    if (installed) return this.catalog.stageCandidate(candidate, expectedRevision);
    const now = new Date().toISOString();
    const requestsCapabilities = (candidate.manifest.capabilities?.host?.length ?? 0) > 0
      || (candidate.manifest.capabilities?.surface?.length ?? 0) > 0;
    const record: PiariumExtensionInstallationRecord = {
      capabilityGrants: [],
      desired: { enabled: !requestsCapabilities, revision: 1, updatedAt: now },
      installedAt: now,
      integrity: candidate.integrity,
      manifest: candidate.manifest,
      resolvedPath: candidate.resolvedPath,
      resolvedVersion: candidate.resolvedVersion,
      selectedVersion: candidate.resolvedVersion,
      source: candidate.source,
      updatedAt: now,
    };
    return this.catalog.upsert(record, expectedRevision);
  }

  async reloadLocalSource(
    request: PiariumExtensionLocalSourceReloadRequest,
    signal?: AbortSignal,
  ): Promise<PiariumExtensionLocalSourceReloadResult> {
    const current = await this.catalog.store.read();
    if (!current.authoritative) throw new Error("Cannot reload a local source from a stale extension catalog");
    if (current.document.revision !== request.expectedRevision) {
      throw new ExtensionCatalogRevisionConflictError(request.expectedRevision, current.document.revision);
    }
    const record = current.document.extensions[request.extensionId];
    if (!record) throw new Error(`Piarium extension is not installed: ${request.extensionId}`);
    if (record.source.kind !== "local") {
      throw new Error(`Piarium extension is not installed from a local source: ${request.extensionId}`);
    }

    const candidate = await this.artifacts.prepare(structuredClone(record.source), signal);
    assertPiariumExtensionManifestCompatibility(candidate.manifest, this.piariumVersion);
    if (candidate.manifest.id !== request.extensionId) {
      throw new Error(
        `Local Piarium extension source now declares ${candidate.manifest.id}; expected ${request.extensionId}`,
      );
    }

    const latest = await this.catalog.snapshot();
    if (!latest.authoritative) throw new Error("Cannot reload a local source from a stale extension catalog");
    if (latest.revision !== request.expectedRevision) {
      throw new ExtensionCatalogRevisionConflictError(request.expectedRevision, latest.revision);
    }
    const selected = latest.extensions.find((entry) => entry.manifest.id === request.extensionId);
    if (!selected) throw new Error(`Piarium extension is not installed: ${request.extensionId}`);
    if (selected.source.kind !== "local") {
      throw new Error(`Piarium extension is not installed from a local source: ${request.extensionId}`);
    }
    if (selected.integrity === candidate.integrity) return { outcome: "unchanged", snapshot: latest };

    const snapshot = await this.catalog.stageCandidate(candidate, request.expectedRevision);
    return { candidateIntegrity: candidate.integrity, outcome: "staged", snapshot };
  }

  selectCandidate(requestValue: PiariumExtensionCandidateSelectionRequest | unknown): Promise<PiariumExtensionCatalogSnapshot> {
    const request = parsePiariumExtensionCandidateSelectionRequest(requestValue);
    return this.catalog.selectCandidate(request.extensionId, request.candidateIntegrity, request.expectedRevision);
  }

  async readAsset(requestValue: PiariumExtensionAssetRequest | unknown): Promise<PiariumExtensionAssetPayload> {
    const request = parsePiariumExtensionAssetRequest(requestValue);
    const artifact = await this.#artifact(request.extensionId, request.slot, request.integrity);
    return this.artifacts.readAsset(artifact.resolvedPath, request.integrity, request.path, artifact.manifest);
  }

  async readManagedEntrypoint(
    requestValue: PiariumExtensionManagedEntrypointRequest | unknown,
  ): Promise<PiariumExtensionManagedEntrypointPayload> {
    const request = parsePiariumExtensionManagedEntrypointRequest(requestValue);
    const artifact = await this.#artifact(request.extensionId, request.slot, request.integrity);
    return this.artifacts.readManagedEntrypoint(
      artifact.resolvedPath,
      request.integrity,
      request.entrypointId,
      artifact.manifest,
    );
  }

  reportActualState(extensionId: string, state: PiariumExtensionActualState): Promise<void> {
    return this.catalog.reportActualState(extensionId, state);
  }

  async resolveBrokeredHostEntrypoint(
    extensionId: string,
    slot: "candidate" | "selected",
    integrity: string,
  ): Promise<BrokeredHostEntrypointArtifact> {
    const artifact = await this.#artifact(extensionId, slot, integrity);
    return this.artifacts.resolveBrokeredHostEntrypoint(artifact.resolvedPath, integrity, artifact.manifest);
  }

  async #artifact(
    extensionId: string,
    slot: "candidate" | "selected",
    integrity: string,
  ): Promise<{ manifest: PiariumExtensionManifest; resolvedPath: string }> {
    const read = await this.catalog.store.read();
    const record = read.document.extensions[extensionId];
    if (!record) throw new Error(`Piarium extension is not installed: ${extensionId}`);
    const artifact = slot === "candidate" ? record.candidate : record;
    if (!artifact?.resolvedPath || artifact.integrity !== integrity) {
      throw new Error(`Piarium extension ${slot} artifact is no longer current: ${extensionId}`);
    }
    return { manifest: artifact.manifest, resolvedPath: artifact.resolvedPath };
  }
}
