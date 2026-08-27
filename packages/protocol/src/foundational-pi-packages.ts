export const FOUNDATIONAL_PI_PACKAGE_MANIFEST_REVISION = 1 as const;

export const FOUNDATIONAL_PI_PACKAGE_IDS = [
  "mcp",
  "permission-system",
  "workspace-history",
  "wtf",
] as const;

export type FoundationalPiPackageId = (typeof FOUNDATIONAL_PI_PACKAGE_IDS)[number];

export interface FoundationalPiPackageManifestEntry {
  /** Stable Piarium integration identity. It is not a package-source allowlist. */
  id: FoundationalPiPackageId;
  introducedRevision: number;
  /** Name declared by the package itself. */
  packageName: string;
  /** Package identities accepted when matching Pi's observed package descriptor. */
  packageAliases: readonly string[];
  /** Current source used only for default provisioning. */
  source: string;
}

export interface FoundationalPiPackageManifest {
  integrations: readonly FoundationalPiPackageManifestEntry[];
  revision: typeof FOUNDATIONAL_PI_PACKAGE_MANIFEST_REVISION;
}

export const FOUNDATIONAL_PI_PACKAGE_MANIFEST = {
  integrations: [
    {
      id: "mcp",
      introducedRevision: 1,
      packageAliases: ["pi-mcp-adapter"],
      packageName: "pi-mcp-adapter",
      source: "https://github.com/Youzini-afk/pi-mcp-adapter.git",
    },
    {
      id: "permission-system",
      introducedRevision: 1,
      packageAliases: ["@gotgenes/pi-permission-system", "pi-permission-system"],
      packageName: "@gotgenes/pi-permission-system",
      source: "npm:@gotgenes/pi-permission-system",
    },
    {
      id: "workspace-history",
      introducedRevision: 1,
      packageAliases: ["pi-workspace-history"],
      packageName: "pi-workspace-history",
      source: "npm:pi-workspace-history",
    },
    {
      id: "wtf",
      introducedRevision: 1,
      packageAliases: ["pi-wtf"],
      packageName: "pi-wtf",
      source: "npm:pi-wtf",
    },
  ],
  revision: FOUNDATIONAL_PI_PACKAGE_MANIFEST_REVISION,
} as const satisfies FoundationalPiPackageManifest;

export const FOUNDATIONAL_PI_PACKAGE_INTENTS = [
  "eligible",
  "suppressed",
  "policy_skipped",
] as const;

export type FoundationalPiPackageIntent = (typeof FOUNDATIONAL_PI_PACKAGE_INTENTS)[number];

export const FOUNDATIONAL_PI_PACKAGE_PROVENANCES = ["none", "auto_managed", "adopted"] as const;

export type FoundationalPiPackageProvenance =
  (typeof FOUNDATIONAL_PI_PACKAGE_PROVENANCES)[number];

export const FOUNDATIONAL_PI_PACKAGE_OBSERVED_STATES = [
  "missing",
  "enabled",
  "disabled",
  "configured_broken",
  "incompatible",
  "source_conflict",
] as const;

export type FoundationalPiPackageObservedState =
  (typeof FOUNDATIONAL_PI_PACKAGE_OBSERVED_STATES)[number];

export const FOUNDATIONAL_PI_PACKAGE_OPERATION_STATES = [
  "idle",
  "planned",
  "mutating",
  "verifying",
  "failed_retryable",
  "action_required",
] as const;

export type FoundationalPiPackageOperationState =
  (typeof FOUNDATIONAL_PI_PACKAGE_OPERATION_STATES)[number];

export const FOUNDATIONAL_PI_PACKAGE_STATUS_STATES = [
  "idle",
  "running",
  "ready",
  "degraded",
] as const;

export type FoundationalPiPackageStatusState =
  (typeof FOUNDATIONAL_PI_PACKAGE_STATUS_STATES)[number];

/** Browser-safe projection of one foundational package's current state. */
export interface FoundationalPiPackageStatusEntry {
  error?: string;
  id: FoundationalPiPackageId;
  intent: FoundationalPiPackageIntent;
  observed: FoundationalPiPackageObservedState;
  operation: FoundationalPiPackageOperationState;
  provenance: FoundationalPiPackageProvenance;
  /** Actual source reported by Pi, which may differ from the manifest source. */
  source?: string;
}

/** Browser-safe projection; it deliberately contains no filesystem paths or receipt internals. */
export interface FoundationalPiPackageStatusSnapshot {
  autoInstallNew: boolean;
  entries: FoundationalPiPackageStatusEntry[];
  manifestRevision: number;
  /** Monotonic within one broker lifetime so stale reads cannot replace newer status. */
  revision: number;
  state: FoundationalPiPackageStatusState;
}
