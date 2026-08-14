export const PIARIUM_EXTENSION_MANIFEST_SCHEMA_VERSION = 1 as const;
export const PIARIUM_EXTENSION_CATALOG_SCHEMA_VERSION = 1 as const;
export const PIARIUM_EXTENSION_MANIFEST_FILE = "piarium.extension.json" as const;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type PiariumApplicationSurface = "desktop" | "mobile" | "vscode" | "web";
export type PiariumExtensionHostMode = "brokered" | "native";
export type PiariumExtensionSurfaceMode = "declarative" | "isolated" | "managed" | "native";
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
  | "tool-renderer";

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
  provides?: {
    services?: PiariumExtensionServiceProvision[];
  };
  requires?: {
    services?: PiariumExtensionServiceRequirement[];
  };
  schemaVersion: typeof PIARIUM_EXTENSION_MANIFEST_SCHEMA_VERSION;
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

export interface PiariumExtensionCatalogEntry {
  actual: PiariumExtensionActualState[];
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
