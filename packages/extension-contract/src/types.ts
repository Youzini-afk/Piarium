export const PIARIUM_EXTENSION_MANIFEST_SCHEMA_VERSION = 1 as const;
export const PIARIUM_EXTENSION_CATALOG_SCHEMA_VERSION = 1 as const;
export const PIARIUM_EXTENSION_MANIFEST_FILE = "piarium.extension.json" as const;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type PiariumApplicationSurface = "desktop" | "mobile" | "vscode" | "web";
export type PiariumExtensionHostMode = "brokered" | "native";
export type PiariumExtensionSurfaceMode = "declarative" | "isolated" | "managed" | "native";
export type PiariumExtensionIsolationKind = "iframe" | "worker";
export type PiariumExtensionActivationEvent =
  | "application-startup"
  | "background"
  | "command"
  | "contribution-visible"
  | "service-request"
  | "workspace-match";

export interface PiariumExtensionEntrypointBase {
  activation?: PiariumExtensionActivationEvent[];
  file?: string;
}

export interface PiariumExtensionHostEntrypoint extends PiariumExtensionEntrypointBase {
  file: string;
  mode: PiariumExtensionHostMode;
}

export interface PiariumExtensionSurfaceEntrypoint extends PiariumExtensionEntrypointBase {
  id: string;
  isolation?: PiariumExtensionIsolationKind;
  mode: PiariumExtensionSurfaceMode;
  supports: PiariumApplicationSurface[];
}

export interface PiariumExtensionServiceRequirement {
  binding?: "all" | "selected" | "single";
  id: string;
  optional?: boolean;
  version: number;
}

export interface PiariumExtensionServiceProvision {
  id: string;
  multiple?: boolean;
  version: number;
}

export type PiariumExtensionContributionKind =
  | "command"
  | "composer-action"
  | "editor"
  | "keybinding"
  | "menu-item"
  | "message-renderer"
  | "page"
  | "panel"
  | "session-decoration"
  | "settings-page"
  | "shell"
  | "sidebar"
  | "status-item"
  | "tool-renderer"
  | "view";

export interface PiariumExtensionContributionPlacement {
  after?: string[];
  before?: string[];
  order?: number;
  slot?: string;
}

export interface PiariumExtensionContributionReplacement {
  priority?: number;
  target: string;
}

export interface PiariumExtensionStaticContribution {
  contractVersion: number;
  data: JsonObject;
  entrypoint?: string;
  id: string;
  kind: PiariumExtensionContributionKind;
  placement?: PiariumExtensionContributionPlacement;
  replacement?: PiariumExtensionContributionReplacement;
  requiresCapabilities?: string[];
  supports: PiariumApplicationSurface[];
  title?: string;
  when?: string;
}

export interface PiariumExtensionManifest {
  capabilities?: {
    host?: string[];
    surface?: string[];
  };
  contributions?: PiariumExtensionStaticContribution[];
  displayName?: string;
  engines: {
    piarium: string;
  };
  entrypoints?: {
    host?: PiariumExtensionHostEntrypoint;
    surfaces?: PiariumExtensionSurfaceEntrypoint[];
  };
  id: string;
  integrates?: {
    piPackages?: string[];
  };
  metadata?: {
    description?: string;
    homepage?: string;
    icon?: string;
    keywords?: string[];
    repository?: string;
  };
  provides?: {
    services?: PiariumExtensionServiceProvision[];
  };
  requires?: {
    services?: PiariumExtensionServiceRequirement[];
  };
  schemaVersion: typeof PIARIUM_EXTENSION_MANIFEST_SCHEMA_VERSION;
  storage?: {
    schemaVersion: number;
  };
  version: string;
}

export type PiariumExtensionPackageSourceKind = "builtin" | "git" | "local" | "npm";

export interface PiariumExtensionPackageSource {
  display: string;
  kind: PiariumExtensionPackageSourceKind;
  specifier: string;
}

export interface PiariumExtensionPublicPackageSource {
  display: string;
  kind: PiariumExtensionPackageSourceKind;
}

export interface PiariumExtensionCapabilityGrant {
  capability: string;
  granted: boolean;
  manifestVersion: string;
  realm: PiariumExtensionRealmKind;
  updatedAt: string;
}

export interface PiariumExtensionCapabilityReference {
  capability: string;
  realm: PiariumExtensionRealmKind;
}

export interface PiariumExtensionCapabilityDelta {
  added: PiariumExtensionCapabilityReference[];
  removed: PiariumExtensionCapabilityReference[];
}

export interface PiariumExtensionCapabilityDecision extends PiariumExtensionCapabilityReference {
  granted: boolean;
}

export interface PiariumExtensionDesiredState {
  enabled: boolean;
  revision: number;
  updatedAt: string;
}

export type PiariumExtensionActualStatus =
  | "active"
  | "activating"
  | "deactivating"
  | "failed"
  | "inactive"
  | "loading"
  | "resolving"
  | "restart-required"
  | "rolling-back"
  | "updating"
  | "waiting";

export type PiariumExtensionRealmKind = "host" | "surface";

export interface PiariumExtensionDiagnostic {
  code: string;
  extensionId?: string;
  message: string;
  realmId?: string;
  severity: "error" | "info" | "warning";
  timestamp: string;
}

export interface PiariumExtensionActualState {
  desiredRevision: number;
  diagnostics: PiariumExtensionDiagnostic[];
  entrypointId: string;
  generation: number;
  hostId: string;
  realmId: string;
  realmKind: PiariumExtensionRealmKind;
  status: PiariumExtensionActualStatus;
  updatedAt: string;
}

export interface PiariumExtensionInstallationRecord {
  candidate?: PiariumExtensionCandidateRecord;
  capabilityGrants: PiariumExtensionCapabilityGrant[];
  desired: PiariumExtensionDesiredState;
  installedAt: string;
  integrity?: string;
  manifest: PiariumExtensionManifest;
  resolvedVersion: string;
  resolvedPath?: string;
  selectedVersion: string;
  source: PiariumExtensionPackageSource;
  updatedAt: string;
}

export interface PiariumExtensionCandidateRecord {
  applyRequested: boolean;
  capabilitiesReviewed: boolean;
  capabilityDelta: PiariumExtensionCapabilityDelta;
  capabilityGrants: PiariumExtensionCapabilityGrant[];
  integrity: string;
  manifest: PiariumExtensionManifest;
  preparedAt: string;
  resolvedPath: string;
  resolvedVersion: string;
  source: PiariumExtensionPackageSource;
}

export interface PiariumExtensionPreparedArtifact {
  integrity: string;
  manifest: PiariumExtensionManifest;
  preparedAt: string;
  resolvedPath: string;
  resolvedVersion: string;
  source: PiariumExtensionPackageSource;
}

export interface PiariumExtensionPublicCandidate {
  applyRequested: boolean;
  capabilitiesReviewed: boolean;
  capabilityDelta: PiariumExtensionCapabilityDelta;
  capabilityGrants: PiariumExtensionCapabilityGrant[];
  integrity: string;
  manifest: PiariumExtensionManifest;
  preparedAt: string;
  resolvedVersion: string;
  source: PiariumExtensionPublicPackageSource;
}

export interface PiariumExtensionCatalogEntry {
  actual: PiariumExtensionActualState[];
  candidate?: PiariumExtensionPublicCandidate;
  capabilityGrants: PiariumExtensionCapabilityGrant[];
  desired: PiariumExtensionDesiredState;
  installedAt: string;
  integrity?: string;
  manifest: PiariumExtensionManifest;
  resolvedVersion: string;
  selectedVersion: string;
  source: PiariumExtensionPublicPackageSource;
  updatedAt: string;
}

export type PiariumExtensionArtifactSlot = "candidate" | "selected";

export interface PiariumExtensionAssetRequest {
  extensionId: string;
  integrity: string;
  path: string;
  slot: PiariumExtensionArtifactSlot;
}

export interface PiariumExtensionAssetPayload {
  artifactIntegrity: string;
  bytesBase64: string;
  contentType: string;
  integrity: string;
  path: string;
}

export interface PiariumExtensionManagedEntrypointRequest {
  entrypointId: string;
  extensionId: string;
  integrity: string;
  slot: PiariumExtensionArtifactSlot;
}

export interface PiariumExtensionManagedEntrypointPayload {
  artifactIntegrity: string;
  entrypointId: string;
  module: PiariumExtensionAssetPayload;
  styles: PiariumExtensionAssetPayload[];
}

export interface PiariumExtensionCandidateSelectionRequest {
  candidateIntegrity: string;
  expectedRevision: number;
  extensionId: string;
}

export interface PiariumExtensionCandidateCapabilityReviewRequest {
  candidateIntegrity: string;
  decisions: PiariumExtensionCapabilityDecision[];
  expectedRevision: number;
  extensionId: string;
}

export interface PiariumExtensionCapabilityReviewRequest {
  decisions: PiariumExtensionCapabilityDecision[];
  expectedRevision: number;
  extensionId: string;
}

export interface PiariumExtensionPackageInstallRequest {
  expectedRevision: number;
  source: PiariumExtensionPackageSource;
}

export interface PiariumExtensionLocalSourceReloadRequest {
  expectedRevision: number;
  extensionId: string;
}

export type PiariumExtensionLocalSourceReloadResult =
  | {
      outcome: "unchanged";
      snapshot: PiariumExtensionCatalogSnapshot;
    }
  | {
      candidateIntegrity: string;
      outcome: "staged";
      snapshot: PiariumExtensionCatalogSnapshot;
    };

export interface PiariumExtensionRemoveRequest {
  deleteData: boolean;
  expectedRevision: number;
  extensionId: string;
}

export type PiariumExtensionServiceProviderStatus = "active" | "candidate" | "draining";

export interface PiariumExtensionServiceProviderSnapshot {
  descriptor: PiariumExtensionServiceProvision;
  entrypointId: string;
  extensionId: string;
  extensionVersion: string;
  generation: number;
  providerId: string;
  providerKey: string;
  status: PiariumExtensionServiceProviderStatus;
}

export interface PiariumExtensionServiceCatalogSnapshot {
  hostId: string;
  providers: PiariumExtensionServiceProviderSnapshot[];
  revision: number;
  selections: Record<string, string>;
}

export interface PiariumExtensionServiceInvocationRequest {
  args: JsonValue[];
  method: string;
  providerId?: string;
  routing?: import("./service-routing.js").PiariumExtensionServiceRoutingContext;
  serviceId: string;
  version: number;
}

export interface PiariumExtensionServiceSelectionRequest {
  providerId: string | null;
  serviceId: string;
  version: number;
}

export interface PiariumExtensionCandidatePreparationResult {
  extensionId: string;
  integrity: string;
  providers: PiariumExtensionServiceProviderSnapshot[];
}

export interface PiariumExtensionHostStateSnapshot {
  catalog: PiariumExtensionCatalogSnapshot;
  revision: number;
  services: PiariumExtensionServiceCatalogSnapshot;
  routing: import("./service-routing.js").PiariumExtensionServiceRoutingSnapshot;
  workbench: import("./workbench.js").PiariumWorkbenchProfileSnapshot;
}

export interface PiariumExtensionHostStateWaitRequest {
  hostId: string;
  revision: number;
}

export type PiariumExtensionStorageScope = "application" | "profile" | "session" | "surface" | "workspace";

export interface PiariumExtensionStorageAddress {
  extensionId: string;
  key: string;
  scope: PiariumExtensionStorageScope;
}

export interface PiariumExtensionStorageOpenRequest {
  key: string;
  schemaVersion?: number;
  scope: PiariumExtensionStorageScope;
}

export interface PiariumExtensionStorageDocument {
  data: JsonObject;
  revision: number;
  schemaVersion: number;
  updatedAt: string;
}

export interface PiariumExtensionStorageSnapshot {
  address: PiariumExtensionStorageAddress;
  authoritative: boolean;
  diagnostics: PiariumExtensionDiagnostic[];
  document: PiariumExtensionStorageDocument;
  exists: boolean;
  storageState: "missing" | "ready" | "stale";
}

export type PiariumExtensionCatalogStorageState = "missing" | "ready" | "stale";

export interface PiariumExtensionCatalogSnapshot {
  authoritative: boolean;
  diagnostics: PiariumExtensionDiagnostic[];
  extensions: PiariumExtensionCatalogEntry[];
  hostId: string;
  loadedAt: string;
  revision: number;
  schemaVersion: typeof PIARIUM_EXTENSION_CATALOG_SCHEMA_VERSION;
  storageState: PiariumExtensionCatalogStorageState;
}

export interface PiariumExtensionCatalogError {
  code: string;
  message: string;
  retryable: boolean;
}

export type PiariumExtensionCatalogAvailability =
  | {
      supported: false;
      reason: string;
    }
  | {
      error: PiariumExtensionCatalogError;
      supported: true;
      status: "error";
    }
  | {
      snapshot: PiariumExtensionCatalogSnapshot;
      supported: true;
      status: "ready";
    };

export interface PiariumExtensionCatalogDocument {
  extensions: Record<string, PiariumExtensionInstallationRecord>;
  revision: number;
  schemaVersion: typeof PIARIUM_EXTENSION_CATALOG_SCHEMA_VERSION;
  updatedAt: string;
}

export interface PiariumExtensionHostIdentityDocument {
  createdAt: string;
  hostId: string;
  schemaVersion: typeof PIARIUM_EXTENSION_CATALOG_SCHEMA_VERSION;
}

export interface PiariumExtensionPackageCandidate {
  integrity?: string;
  manifest: PiariumExtensionManifest;
  resolvedPath: string;
  source: PiariumExtensionPackageSource;
}
