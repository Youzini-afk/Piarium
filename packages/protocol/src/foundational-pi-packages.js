export const FOUNDATIONAL_PI_PACKAGE_MANIFEST_REVISION = 2;
export const FOUNDATIONAL_PI_PACKAGE_IDS = [
    "mcp",
    "permission-system",
];
export const FOUNDATIONAL_PI_PACKAGE_MANIFEST = {
    integrations: [
        {
            id: "mcp",
            introducedRevision: 1,
            packageAliases: ["@piarium/pi-mcp-adapter", "pi-mcp-adapter"],
            packageName: "@piarium/pi-mcp-adapter",
            source: "npm:@piarium/pi-mcp-adapter",
        },
        {
            id: "permission-system",
            introducedRevision: 1,
            packageAliases: ["@gotgenes/pi-permission-system", "pi-permission-system"],
            packageName: "@gotgenes/pi-permission-system",
            source: "npm:@gotgenes/pi-permission-system",
        },
    ],
    revision: FOUNDATIONAL_PI_PACKAGE_MANIFEST_REVISION,
};
export const FOUNDATIONAL_PI_PACKAGE_INTENTS = [
    "eligible",
    "suppressed",
    "policy_skipped",
];
export const FOUNDATIONAL_PI_PACKAGE_PROVENANCES = ["none", "auto_managed", "adopted"];
export const FOUNDATIONAL_PI_PACKAGE_OBSERVED_STATES = [
    "missing",
    "enabled",
    "disabled",
    "configured_broken",
    "incompatible",
    "source_conflict",
];
export const FOUNDATIONAL_PI_PACKAGE_OPERATION_STATES = [
    "idle",
    "planned",
    "mutating",
    "verifying",
    "failed_retryable",
    "action_required",
];
export const FOUNDATIONAL_PI_PACKAGE_STATUS_STATES = [
    "idle",
    "running",
    "ready",
    "degraded",
];
function packageNameFromIdentity(value) {
    let identity = value.trim();
    if (identity.startsWith("npm:"))
        identity = identity.slice(4);
    if (identity.startsWith("@")) {
        const slash = identity.indexOf("/");
        const version = slash < 0 ? -1 : identity.indexOf("@", slash);
        return (version < 0 ? identity : identity.slice(0, version)).toLowerCase();
    }
    if (/^[A-Za-z0-9_.-]+(?:@[^@/]+)?$/.test(identity)) {
        return (identity.split("@")[0] ?? identity).toLowerCase();
    }
    const normalized = identity.replaceAll("\\", "/").replace(/\/+$/, "");
    const leaf = normalized.slice(Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf(":")) + 1);
    return (leaf.replace(/\.git$/i, "") || identity).toLowerCase();
}
export function foundationalPackageIdentity(value) {
    return packageNameFromIdentity(value);
}
export function matchesFoundationalPackage(entry, descriptor) {
    if (descriptor.source === entry.source)
        return true;
    const identities = new Set([entry.packageName, ...entry.packageAliases, entry.source].map(packageNameFromIdentity));
    return identities.has(packageNameFromIdentity(descriptor.name))
        || identities.has(packageNameFromIdentity(descriptor.source));
}
export function findFoundationalPackageBySource(integrations, source) {
    const identity = packageNameFromIdentity(source);
    return integrations.find((entry) => (entry.source === source
        || [entry.packageName, ...entry.packageAliases, entry.source]
            .some((candidate) => packageNameFromIdentity(candidate) === identity)));
}
//# sourceMappingURL=foundational-pi-packages.js.map