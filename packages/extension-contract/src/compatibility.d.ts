import type { PiariumExtensionContributionKind } from "./types.js";
/**
 * Result of checking whether a contribution's contract version is compatible
 * with the current Piarium runtime.
 */
export type PiariumContributionCompatibility = {
    status: "supported";
    kind: PiariumExtensionContributionKind;
    contractVersion: number;
} | {
    status: "unsupported-contract-version";
    kind: PiariumExtensionContributionKind;
    contractVersion: number;
    supportedVersions: number[];
};
/**
 * The single source of truth for which contribution contract versions the
 * current Piarium runtime understands. Every kind currently supports only
 * version 1. When a future version is introduced, add it here — do not
 * scatter `version === N` checks across consumers.
 */
export declare const PIARIUM_CONTRIBUTION_SUPPORTED_VERSIONS: Readonly<Record<PiariumExtensionContributionKind, readonly number[]>>;
/**
 * Check whether a contribution's contract version is compatible with the
 * current Piarium runtime. This is a pure function — it does not throw.
 *
 * The `kind` must already be validated as a known contribution kind.
 * The `contractVersion` must already be validated as a positive integer.
 */
export declare const checkPiariumContributionCompatibility: (kind: PiariumExtensionContributionKind, contractVersion: number) => PiariumContributionCompatibility;
/**
 * Convenience predicate. Returns `true` when the contribution's contract
 * version is supported by the current runtime.
 */
export declare const isPiariumContributionCompatible: (kind: PiariumExtensionContributionKind, contractVersion: number) => boolean;
//# sourceMappingURL=compatibility.d.ts.map