import type { PackageDescriptor } from "./types.js";
export declare const FOUNDATIONAL_PI_PACKAGE_MANIFEST_REVISION: 2;
export declare const FOUNDATIONAL_PI_PACKAGE_IDS: readonly ["mcp", "permission-system"];
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
export interface PackageBootstrapItemResult {
    error?: string;
    source: string;
    status: "installed" | "already_configured" | "failed";
}
/** Private Host batch result used by the broker-owned provisioner. */
export interface PackageBootstrapResult {
    packages: PackageDescriptor[];
    results: PackageBootstrapItemResult[];
}
export declare const FOUNDATIONAL_PI_PACKAGE_MANIFEST: {
    readonly integrations: readonly [{
        readonly id: "mcp";
        readonly introducedRevision: 1;
        readonly packageAliases: readonly ["@piarium/pi-mcp-adapter", "pi-mcp-adapter"];
        readonly packageName: "@piarium/pi-mcp-adapter";
        readonly source: "npm:@piarium/pi-mcp-adapter";
    }, {
        readonly id: "permission-system";
        readonly introducedRevision: 1;
        readonly packageAliases: readonly ["@gotgenes/pi-permission-system", "pi-permission-system"];
        readonly packageName: "@gotgenes/pi-permission-system";
        readonly source: "npm:@gotgenes/pi-permission-system";
    }];
    readonly revision: 2;
};
export declare const FOUNDATIONAL_PI_PACKAGE_INTENTS: readonly ["eligible", "suppressed", "policy_skipped"];
export type FoundationalPiPackageIntent = (typeof FOUNDATIONAL_PI_PACKAGE_INTENTS)[number];
export declare const FOUNDATIONAL_PI_PACKAGE_PROVENANCES: readonly ["none", "auto_managed", "adopted"];
export type FoundationalPiPackageProvenance = (typeof FOUNDATIONAL_PI_PACKAGE_PROVENANCES)[number];
export declare const FOUNDATIONAL_PI_PACKAGE_OBSERVED_STATES: readonly ["missing", "enabled", "disabled", "configured_broken", "incompatible", "source_conflict"];
export type FoundationalPiPackageObservedState = (typeof FOUNDATIONAL_PI_PACKAGE_OBSERVED_STATES)[number];
export declare const FOUNDATIONAL_PI_PACKAGE_OPERATION_STATES: readonly ["idle", "planned", "mutating", "verifying", "failed_retryable", "action_required"];
export type FoundationalPiPackageOperationState = (typeof FOUNDATIONAL_PI_PACKAGE_OPERATION_STATES)[number];
export declare const FOUNDATIONAL_PI_PACKAGE_STATUS_STATES: readonly ["idle", "running", "ready", "degraded"];
export type FoundationalPiPackageStatusState = (typeof FOUNDATIONAL_PI_PACKAGE_STATUS_STATES)[number];
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
/**
 * JSON-safe projection that excludes receipt internals. `source` and actionable errors retain the
 * same host path visibility as Pi's existing PackageDescriptor surface.
 */
export interface FoundationalPiPackageStatusSnapshot {
    autoInstallNew: boolean;
    entries: FoundationalPiPackageStatusEntry[];
    manifestRevision: number;
    /** Monotonic within one broker lifetime so stale reads cannot replace newer status. */
    revision: number;
    state: FoundationalPiPackageStatusState;
}
export declare function foundationalPackageIdentity(value: string): string;
export declare function matchesFoundationalPackage(entry: FoundationalPiPackageManifestEntry, descriptor: Pick<PackageDescriptor, "name" | "source">): boolean;
export declare function findFoundationalPackageBySource(integrations: readonly FoundationalPiPackageManifestEntry[], source: string): FoundationalPiPackageManifestEntry | undefined;
//# sourceMappingURL=foundational-pi-packages.d.ts.map