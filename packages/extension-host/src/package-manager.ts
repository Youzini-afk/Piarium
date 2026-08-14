import {
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
  type PiariumExtensionPackageSource,
} from "@piarium/extension-contract";
import { ApplicationExtensionCatalog } from "./application-catalog.js";
import { ExtensionArtifactStore } from "./artifact-store.js";
import type { BrokeredHostEntrypointArtifact } from "./artifact-store.js";

export interface ExtensionPackageManagerOptions {
  artifacts?: ExtensionArtifactStore;
  catalog: ApplicationExtensionCatalog;
  dataDir: string;
}

export class ExtensionPackageManager {
  readonly artifacts: ExtensionArtifactStore;
  readonly catalog: ApplicationExtensionCatalog;

  constructor(options: ExtensionPackageManagerOptions) {
    this.catalog = options.catalog;
    this.artifacts = options.artifacts ?? new ExtensionArtifactStore({ dataDir: options.dataDir });
  }

  async installOrStage(
    source: PiariumExtensionPackageSource,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<PiariumExtensionCatalogSnapshot> {
    const candidate = await this.artifacts.prepare(source, signal);
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

  selectCandidate(requestValue: PiariumExtensionCandidateSelectionRequest | unknown): Promise<PiariumExtensionCatalogSnapshot> {
    const request = parsePiariumExtensionCandidateSelectionRequest(requestValue);
    return this.catalog.selectCandidate(request.extensionId, request.candidateIntegrity, request.expectedRevision);
  }

  async readAsset(requestValue: PiariumExtensionAssetRequest | unknown): Promise<PiariumExtensionAssetPayload> {
    const request = parsePiariumExtensionAssetRequest(requestValue);
    const artifact = await this.#artifact(request.extensionId, request.slot, request.integrity);
    return this.artifacts.readAsset(artifact.resolvedPath, request.integrity, request.path);
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
    return this.artifacts.resolveBrokeredHostEntrypoint(artifact.resolvedPath, integrity);
  }

  async #artifact(
    extensionId: string,
    slot: "candidate" | "selected",
    integrity: string,
  ): Promise<{ resolvedPath: string }> {
    const read = await this.catalog.store.read();
    const record = read.document.extensions[extensionId];
    if (!record) throw new Error(`Piarium extension is not installed: ${extensionId}`);
    const artifact = slot === "candidate" ? record.candidate : record;
    if (!artifact?.resolvedPath || artifact.integrity !== integrity) {
      throw new Error(`Piarium extension ${slot} artifact is no longer current: ${extensionId}`);
    }
    return { resolvedPath: artifact.resolvedPath };
  }
}
