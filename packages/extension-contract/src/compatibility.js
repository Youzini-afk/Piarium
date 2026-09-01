/**
 * The single source of truth for which contribution contract versions the
 * current Piarium runtime understands. Every kind currently supports only
 * version 1. When a future version is introduced, add it here — do not
 * scatter `version === N` checks across consumers.
 */
export const PIARIUM_CONTRIBUTION_SUPPORTED_VERSIONS = {
    command: [1],
    "composer-action": [1],
    editor: [1],
    keybinding: [1],
    "menu-item": [1],
    "message-renderer": [1],
    page: [1],
    panel: [1],
    "session-decoration": [1],
    "settings-page": [1],
    shell: [1],
    sidebar: [1],
    "status-item": [1],
    "transition-scene": [1],
    "tool-renderer": [1],
    view: [1],
};
/**
 * Check whether a contribution's contract version is compatible with the
 * current Piarium runtime. This is a pure function — it does not throw.
 *
 * The `kind` must already be validated as a known contribution kind.
 * The `contractVersion` must already be validated as a positive integer.
 */
export const checkPiariumContributionCompatibility = (kind, contractVersion) => {
    const supportedVersions = PIARIUM_CONTRIBUTION_SUPPORTED_VERSIONS[kind];
    if (supportedVersions.includes(contractVersion)) {
        return { status: "supported", kind, contractVersion };
    }
    return {
        status: "unsupported-contract-version",
        kind,
        contractVersion,
        supportedVersions: [...supportedVersions],
    };
};
/**
 * Convenience predicate. Returns `true` when the contribution's contract
 * version is supported by the current runtime.
 */
export const isPiariumContributionCompatible = (kind, contractVersion) => checkPiariumContributionCompatibility(kind, contractVersion).status === "supported";
//# sourceMappingURL=compatibility.js.map