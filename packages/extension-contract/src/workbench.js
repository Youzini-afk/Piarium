const record = (value) => (typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null);
export const PIARIUM_WORKBENCH_PROFILE_SCHEMA_VERSION = 1;
export const PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID = "default";
export const PIARIUM_WORKBENCH_DEFAULT_PROFILE_LABEL = "Agent";
export const PIARIUM_WORKBENCH_IDE_PROFILE_ID = "piarium.ide";
export const PIARIUM_WORKBENCH_IDE_PROFILE_LABEL = "IDE";
export const PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID = "piarium.builtin.agent-workspace";
export const PIARIUM_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID = "piarium.builtin.agent-workspace.shell";
export const PIARIUM_BUILTIN_AGENT_WORKSPACE_SURFACES = ["web", "desktop", "mobile"];
export const PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION_ID = "piarium.builtin.ide-workbench";
export const PIARIUM_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID = "piarium.builtin.ide-workbench.shell";
export const PIARIUM_BUILTIN_IDE_WORKBENCH_SURFACES = ["web", "desktop"];
export const PIARIUM_WORKBENCH_REPLACEMENT_TARGETS = {
    agents: "agents.workbench",
    chatComposer: "chat.composer",
    chatTimeline: "chat.timeline",
    mcp: "mcp.workbench",
    sessionNavigator: "sessions.navigator",
    settings: "settings.workbench",
    shell: "workbench.shell",
    workspaceExplorer: "workspace.explorer",
    activity: "workbench.activity",
    primarySidebar: "workbench.primary-sidebar",
    editor: "workbench.editor",
    secondarySidebar: "workbench.secondary-sidebar",
    panel: "workbench.panel",
    status: "workbench.status",
    transition: "workbench.transition",
};
export const PIARIUM_WORKBENCH_SLOTS = {
    activityItems: "workbench.activity.items",
    primarySidebarViews: "workbench.primary-sidebar.views",
    editorActions: "workbench.editor.actions",
    secondarySidebarViews: "workbench.secondary-sidebar.views",
    panelViews: "workbench.panel.views",
    statusItems: "workbench.status.items",
};
export const PIARIUM_WORKBENCH_CONTEXT_KEYS = {
    editorHasSelection: "editorHasSelection",
    editorIsDirty: "editorIsDirty",
    editorIsOpen: "editorIsOpen",
    debugIsActive: "debugIsActive",
    debugIsPaused: "debugIsPaused",
    testHasFailure: "testHasFailure",
    taskIsRunning: "taskIsRunning",
};
// ---------------------------------------------------------------------------
// Shell seam contract (v1)
//
// A shell contribution declares which replacement targets and slots it
// actually hosts per surface. This makes the contract truthful: the
// Extensions settings page can distinguish supported, dormant, and
// missing selections instead of showing every target as available.
// ---------------------------------------------------------------------------
export const PIARIUM_WORKBENCH_SHELL_DATA_CONTRACT = "piarium-workbench-shell/v1";
const SHELL_SEAM_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const FORBIDDEN_NESTED_TARGETS = new Set([
    PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell,
    PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.transition,
]);
export class PiariumWorkbenchShellContractError extends Error {
    issues;
    constructor(message, issues) {
        super(message);
        this.name = "PiariumWorkbenchShellContractError";
        this.issues = issues;
    }
}
const isShellSurface = (value) => (value === "desktop" || value === "mobile" || value === "vscode" || value === "web");
const validateSeamIdentifiers = (values, label, issues) => {
    if (!Array.isArray(values)) {
        issues.push(`${label} must be an array`);
        return [];
    }
    const result = [];
    const seen = new Set();
    for (let index = 0; index < values.length; index += 1) {
        const item = values[index];
        if (typeof item !== "string" || !SHELL_SEAM_ID_PATTERN.test(item)) {
            issues.push(`${label}[${index}] must be a lowercase namespaced identifier`);
            continue;
        }
        if (FORBIDDEN_NESTED_TARGETS.has(item)) {
            issues.push(`${label}[${index}] must not be ${item} (prevents recursive shell mounting)`);
            continue;
        }
        if (seen.has(item)) {
            issues.push(`${label} contains duplicate ${item}`);
            continue;
        }
        seen.add(item);
        result.push(item);
    }
    return result;
};
/**
 * Parse and validate shell contribution data. Throws
 * `PiariumWorkbenchShellContractError` on validation failure.
 *
 * Rules:
 * - `contract` must equal `PIARIUM_WORKBENCH_SHELL_DATA_CONTRACT`
 * - every surface in `supports` must have a `seams` entry
 * - `seams` must not declare surfaces not in `supports`
 * - `replacementTargets` and `slots` must be unique within and across each
 *   surface's seam
 * - no seam may include `workbench.shell` or `workbench.transition`
 *   (prevents recursive nesting)
 * - identifiers must match the standard contribution ID pattern
 */
export const parsePiariumWorkbenchShellContributionData = (data, supports) => {
    const raw = record(data);
    if (!raw)
        throw new PiariumWorkbenchShellContractError("Shell contribution data must be an object", ["data must be an object"]);
    const issues = [];
    // Reject unknown top-level fields (matches schema additionalProperties: false)
    const allowedTopLevel = new Set(["contract", "seams"]);
    for (const key of Object.keys(raw)) {
        if (!allowedTopLevel.has(key))
            issues.push(`data.${key} is not a recognized field`);
    }
    const contract = raw.contract;
    if (contract !== PIARIUM_WORKBENCH_SHELL_DATA_CONTRACT) {
        issues.push(`data.contract must be ${PIARIUM_WORKBENCH_SHELL_DATA_CONTRACT}`);
    }
    const rawSeams = record(raw.seams);
    if (!rawSeams) {
        issues.push("data.seams must be an object");
    }
    const supportSet = new Set(supports);
    const seams = {};
    const processedSurfaces = new Set();
    if (rawSeams) {
        for (const [surfaceKey, surfaceValue] of Object.entries(rawSeams)) {
            if (!isShellSurface(surfaceKey)) {
                issues.push(`data.seams.${surfaceKey} is not a valid surface`);
                continue;
            }
            if (!supportSet.has(surfaceKey)) {
                issues.push(`data.seams.${surfaceKey} declares a surface not in contribution supports`);
                continue;
            }
            processedSurfaces.add(surfaceKey);
            const surfaceRaw = record(surfaceValue);
            if (!surfaceRaw) {
                issues.push(`data.seams.${surfaceKey} must be an object`);
                continue;
            }
            // Reject unknown fields in surface seams (matches schema additionalProperties: false)
            const allowedSeamFields = new Set(["replacementTargets", "slots"]);
            for (const fieldKey of Object.keys(surfaceRaw)) {
                if (!allowedSeamFields.has(fieldKey)) {
                    issues.push(`data.seams.${surfaceKey}.${fieldKey} is not a recognized field`);
                }
            }
            const replacementTargets = validateSeamIdentifiers(surfaceRaw.replacementTargets, `data.seams.${surfaceKey}.replacementTargets`, issues);
            const slots = validateSeamIdentifiers(surfaceRaw.slots, `data.seams.${surfaceKey}.slots`, issues);
            // Cross-check: no overlap between targets and slots within a surface
            const targetSet = new Set(replacementTargets);
            for (const slot of slots) {
                if (targetSet.has(slot)) {
                    issues.push(`data.seams.${surfaceKey} has ${slot} in both replacementTargets and slots`);
                }
            }
            seams[surfaceKey] = { replacementTargets, slots };
        }
    }
    // Every supported surface must have a seams entry
    for (const surface of supports) {
        if (!processedSurfaces.has(surface)) {
            issues.push(`data.seams.${surface} is missing (surface is in contribution supports)`);
        }
    }
    if (issues.length > 0) {
        throw new PiariumWorkbenchShellContractError("Shell contribution data is invalid", issues);
    }
    return {
        contract: PIARIUM_WORKBENCH_SHELL_DATA_CONTRACT,
        seams,
    };
};
/**
 * Resolve the seams for a specific surface from a parsed shell contribution
 * data. Returns empty seams if the surface is not declared.
 */
export const resolvePiariumWorkbenchShellSurfaceSeams = (data, surface) => (data.seams[surface] ?? { replacementTargets: [], slots: [] });
const SURFACES = new Set(["desktop", "mobile", "vscode", "web"]);
const SCOPES = new Set(["distribution", "user", "workspace"]);
const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const text = (value, label) => {
    if (typeof value !== "string" || value.trim().length === 0)
        throw new Error(`${label} must be a non-empty string`);
    return value.trim();
};
const revision = (value, label) => {
    if (!Number.isSafeInteger(value) || Number(value) < 0)
        throw new Error(`${label} must be a non-negative safe integer`);
    return Number(value);
};
const profileId = (value, label) => {
    const parsed = text(value, label);
    if (!ID_PATTERN.test(parsed))
        throw new Error(`${label} is invalid`);
    return parsed;
};
const contributionId = (value, label) => {
    const parsed = text(value, label);
    if (!ID_PATTERN.test(parsed))
        throw new Error(`${label} is invalid`);
    return parsed;
};
const parseProfile = (value, label) => {
    const raw = record(value);
    if (!raw)
        throw new Error(`${label} must be an object`);
    let extensionIds;
    if (raw.extensionIds !== undefined) {
        if (!Array.isArray(raw.extensionIds))
            throw new Error(`${label}.extensionIds must be an array`);
        extensionIds = raw.extensionIds.map((id, index) => contributionId(id, `${label}.extensionIds[${index}]`));
        if (new Set(extensionIds).size !== extensionIds.length)
            throw new Error(`${label}.extensionIds contains duplicates`);
    }
    return {
        id: profileId(raw.id, `${label}.id`),
        label: text(raw.label, `${label}.label`),
        ...(extensionIds ? { extensionIds } : {}),
    };
};
const parseReference = (value, label) => {
    const raw = record(value);
    if (!raw)
        throw new Error(`${label} must be an object`);
    const result = {
        contributionId: contributionId(raw.contributionId, `${label}.contributionId`),
    };
    if (raw.order !== undefined) {
        if (typeof raw.order !== "number" || !Number.isFinite(raw.order))
            throw new Error(`${label}.order must be finite`);
        result.order = raw.order;
    }
    if (raw.region !== undefined)
        result.region = text(raw.region, `${label}.region`);
    if (raw.size !== undefined) {
        if (typeof raw.size !== "number" || !Number.isFinite(raw.size) || raw.size <= 0)
            throw new Error(`${label}.size must be positive`);
        result.size = raw.size;
    }
    if (raw.visible !== undefined) {
        if (typeof raw.visible !== "boolean")
            throw new Error(`${label}.visible must be boolean`);
        result.visible = raw.visible;
    }
    return result;
};
export const parsePiariumWorkbenchLayoutLayer = (value) => {
    const raw = record(value);
    if (!raw)
        throw new Error("Workbench layout layer must be an object");
    const surface = text(raw.surface, "layer.surface");
    if (!SURFACES.has(surface))
        throw new Error("layer.surface is unsupported");
    const scope = text(raw.scope, "layer.scope");
    if (!SCOPES.has(scope))
        throw new Error("layer.scope is unsupported");
    if (!Array.isArray(raw.references))
        throw new Error("layer.references must be an array");
    const references = raw.references.map((item, index) => parseReference(item, `layer.references[${index}]`));
    if (new Set(references.map((item) => item.contributionId)).size !== references.length) {
        throw new Error("layer.references contains duplicate contribution IDs");
    }
    const rawSelections = record(raw.replacementSelections);
    if (!rawSelections)
        throw new Error("layer.replacementSelections must be an object");
    const replacementSelections = {};
    for (const [target, selected] of Object.entries(rawSelections)) {
        replacementSelections[contributionId(target, `layer.replacementSelections.${target}`)] = contributionId(selected, `layer.replacementSelections.${target}`);
    }
    return {
        profileId: profileId(raw.profileId, "layer.profileId"),
        references,
        replacementSelections,
        scope,
        scopeId: text(raw.scopeId, "layer.scopeId"),
        surface,
    };
};
const parseStringMap = (value, label) => {
    const raw = record(value);
    if (!raw)
        throw new Error(`${label} must be an object`);
    const result = {};
    for (const [key, selected] of Object.entries(raw)) {
        if (!key.trim())
            throw new Error(`${label} contains an empty scope ID`);
        result[key] = profileId(selected, `${label}.${key}`);
    }
    return result;
};
export const parsePiariumWorkbenchProfileDocument = (value) => {
    const raw = record(value);
    if (!raw)
        throw new Error("Workbench profile document must be an object");
    if (raw.schemaVersion !== PIARIUM_WORKBENCH_PROFILE_SCHEMA_VERSION)
        throw new Error("Workbench profile schemaVersion is unsupported");
    if (!Array.isArray(raw.profiles) || raw.profiles.length === 0)
        throw new Error("Workbench profiles must contain at least one profile");
    const profiles = raw.profiles.map((item, index) => parseProfile(item, `profiles[${index}]`));
    if (new Set(profiles.map((item) => item.id)).size !== profiles.length)
        throw new Error("Workbench profile IDs must be unique");
    if (!Array.isArray(raw.layouts))
        throw new Error("Workbench layouts must be an array");
    const layouts = raw.layouts.map(parsePiariumWorkbenchLayoutLayer);
    const layoutKeys = layouts.map((layer) => `${layer.profileId}\0${layer.surface}\0${layer.scope}\0${layer.scopeId}`);
    if (new Set(layoutKeys).size !== layoutKeys.length)
        throw new Error("Workbench layout layer identities must be unique");
    const selections = record(raw.profileSelections);
    if (!selections)
        throw new Error("Workbench profileSelections must be an object");
    const activeProfileId = profileId(raw.activeProfileId, "activeProfileId");
    const knownProfiles = new Set(profiles.map((item) => item.id));
    const profileSelections = {
        users: parseStringMap(selections.users, "profileSelections.users"),
        workspaces: parseStringMap(selections.workspaces, "profileSelections.workspaces"),
    };
    if (!knownProfiles.has(activeProfileId))
        throw new Error("activeProfileId does not name an installed profile");
    for (const selected of [...Object.values(profileSelections.users), ...Object.values(profileSelections.workspaces)]) {
        if (!knownProfiles.has(selected))
            throw new Error(`Profile selection names an unknown profile: ${selected}`);
    }
    for (const layer of layouts) {
        if (!knownProfiles.has(layer.profileId))
            throw new Error(`Layout names an unknown profile: ${layer.profileId}`);
    }
    const updatedAt = text(raw.updatedAt, "updatedAt");
    if (!Number.isFinite(Date.parse(updatedAt)))
        throw new Error("updatedAt must be an ISO timestamp");
    return {
        activeProfileId,
        layouts,
        profileSelections,
        profiles,
        revision: revision(raw.revision, "revision"),
        schemaVersion: PIARIUM_WORKBENCH_PROFILE_SCHEMA_VERSION,
        updatedAt,
    };
};
export const parsePiariumWorkbenchProfileSnapshot = (value) => {
    const raw = record(value);
    if (!raw)
        throw new Error("Workbench profile snapshot must be an object");
    const storageState = raw.storageState;
    if (storageState !== "missing" && storageState !== "ready" && storageState !== "stale") {
        throw new Error("Workbench profile storageState is unsupported");
    }
    if (typeof raw.authoritative !== "boolean")
        throw new Error("Workbench profile authoritative must be boolean");
    if (!Array.isArray(raw.diagnostics))
        throw new Error("Workbench profile diagnostics must be an array");
    return {
        authoritative: raw.authoritative,
        diagnostics: raw.diagnostics,
        document: parsePiariumWorkbenchProfileDocument(raw.document),
        hostId: text(raw.hostId, "hostId"),
        storageState,
    };
};
export const parsePiariumWorkbenchLayoutUpdateRequest = (value) => {
    const raw = record(value);
    if (!raw)
        throw new Error("Workbench layout update request must be an object");
    return {
        expectedRevision: revision(raw.expectedRevision, "expectedRevision"),
        layer: parsePiariumWorkbenchLayoutLayer(raw.layer),
    };
};
export const parsePiariumWorkbenchProfileSelectionRequest = (value) => {
    const raw = record(value);
    if (!raw)
        throw new Error("Workbench profile selection request must be an object");
    const scope = raw.scope;
    if (scope !== "application" && scope !== "user" && scope !== "workspace")
        throw new Error("Profile selection scope is unsupported");
    const scopeId = raw.scopeId === undefined ? undefined : text(raw.scopeId, "scopeId");
    if (scope === "application" && scopeId !== undefined)
        throw new Error("Application profile selection cannot include scopeId");
    if (scope !== "application" && scopeId === undefined)
        throw new Error(`${scope} profile selection requires scopeId`);
    return {
        expectedRevision: revision(raw.expectedRevision, "expectedRevision"),
        profileId: profileId(raw.profileId, "profileId"),
        scope,
        ...(scopeId ? { scopeId } : {}),
    };
};
export const parsePiariumWorkbenchProfileUpsertRequest = (value) => {
    const raw = record(value);
    if (!raw)
        throw new Error("Workbench profile upsert request must be an object");
    return { expectedRevision: revision(raw.expectedRevision, "expectedRevision"), profile: parseProfile(raw.profile, "profile") };
};
export const parsePiariumWorkbenchProfileRemoveRequest = (value) => {
    const raw = record(value);
    if (!raw)
        throw new Error("Workbench profile remove request must be an object");
    return { expectedRevision: revision(raw.expectedRevision, "expectedRevision"), profileId: profileId(raw.profileId, "profileId") };
};
export const parsePiariumWorkbenchProfileApplyRequest = (value) => {
    const raw = record(value);
    if (!raw)
        throw new Error("Workbench profile apply request must be an object");
    return {
        expectedCatalogRevision: revision(raw.expectedCatalogRevision, "expectedCatalogRevision"),
        profileId: profileId(raw.profileId, "profileId"),
    };
};
const distributionShellLayer = (profileId, surface, shellContributionId) => ({
    profileId,
    references: [],
    replacementSelections: {
        [PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell]: shellContributionId,
    },
    scope: "distribution",
    scopeId: profileId,
    surface,
});
const ensureDistributionShellLayouts = (document, profileId, surfaces, shellContributionId) => {
    let changed = false;
    for (const surface of surfaces) {
        const index = document.layouts.findIndex((layer) => (layer.profileId === profileId
            && layer.scope === "distribution"
            && layer.scopeId === profileId
            && layer.surface === surface));
        if (index === -1) {
            document.layouts.push(distributionShellLayer(profileId, surface, shellContributionId));
            changed = true;
            continue;
        }
        const layer = document.layouts[index];
        if (!layer || layer.replacementSelections[PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell])
            continue;
        document.layouts[index] = {
            ...layer,
            replacementSelections: {
                ...layer.replacementSelections,
                [PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell]: shellContributionId,
            },
        };
        changed = true;
    }
    return changed;
};
export const defaultPiariumWorkbenchProfileDocument = () => ({
    activeProfileId: PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID,
    layouts: [
        ...PIARIUM_BUILTIN_AGENT_WORKSPACE_SURFACES.map((surface) => (distributionShellLayer(PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID, surface, PIARIUM_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID))),
        ...PIARIUM_BUILTIN_IDE_WORKBENCH_SURFACES.map((surface) => (distributionShellLayer(PIARIUM_WORKBENCH_IDE_PROFILE_ID, surface, PIARIUM_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID))),
    ],
    profileSelections: { users: {}, workspaces: {} },
    profiles: [
        { id: PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID, label: PIARIUM_WORKBENCH_DEFAULT_PROFILE_LABEL },
        { id: PIARIUM_WORKBENCH_IDE_PROFILE_ID, label: PIARIUM_WORKBENCH_IDE_PROFILE_LABEL },
    ],
    revision: 0,
    schemaVersion: PIARIUM_WORKBENCH_PROFILE_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
});
export const migratePiariumWorkbenchProfileDocument = (document) => {
    let changed = false;
    const profile = document.profiles.find((candidate) => candidate.id === PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID);
    if (profile && profile.label === "Default") {
        profile.label = PIARIUM_WORKBENCH_DEFAULT_PROFILE_LABEL;
        changed = true;
    }
    if (!document.profiles.some((candidate) => candidate.id === PIARIUM_WORKBENCH_IDE_PROFILE_ID)) {
        document.profiles.push({ id: PIARIUM_WORKBENCH_IDE_PROFILE_ID, label: PIARIUM_WORKBENCH_IDE_PROFILE_LABEL });
        changed = true;
    }
    changed = ensureDistributionShellLayouts(document, PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID, PIARIUM_BUILTIN_AGENT_WORKSPACE_SURFACES, PIARIUM_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID) || changed;
    changed = ensureDistributionShellLayouts(document, PIARIUM_WORKBENCH_IDE_PROFILE_ID, PIARIUM_BUILTIN_IDE_WORKBENCH_SURFACES, PIARIUM_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID) || changed;
    return changed;
};
export const resolvePiariumWorkbenchLayout = (documentValue, context) => {
    const document = parsePiariumWorkbenchProfileDocument(documentValue);
    if (!SURFACES.has(context.surface))
        throw new Error("Workbench resolution surface is unsupported");
    const userId = text(context.userId, "userId");
    const workspaceId = context.workspaceId?.trim() || undefined;
    const profileIdValue = (workspaceId ? document.profileSelections.workspaces[workspaceId] : undefined)
        ?? document.profileSelections.users[userId]
        ?? document.activeProfileId;
    const layers = document.layouts.filter((layer) => (layer.profileId === profileIdValue
        && layer.surface === context.surface
        && ((layer.scope === "distribution" && layer.scopeId === profileIdValue)
            || (layer.scope === "user" && layer.scopeId === userId)
            || (layer.scope === "workspace" && workspaceId !== undefined && layer.scopeId === workspaceId)))).sort((left, right) => (["distribution", "user", "workspace"].indexOf(left.scope)
        - ["distribution", "user", "workspace"].indexOf(right.scope)));
    const references = new Map();
    const replacementSelections = {};
    for (const layer of layers) {
        for (const reference of layer.references) {
            references.set(reference.contributionId, {
                ...(references.get(reference.contributionId) ?? {}),
                ...reference,
            });
        }
        Object.assign(replacementSelections, layer.replacementSelections);
    }
    return { profileId: profileIdValue, references: [...references.values()], replacementSelections };
};
const catalogExtensions = (catalog) => ("extensions" in catalog ? catalog.extensions : catalog);
export const inspectPiariumWorkbenchShell = (replacementSelections, catalog, surface, actualScope) => {
    const shellContributionId = replacementSelections[PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell]?.trim();
    if (!shellContributionId)
        return { status: "builtin" };
    const extensions = catalogExtensions(catalog);
    for (const entry of extensions) {
        const contribution = entry.manifest.contributions?.find((item) => item.id === shellContributionId);
        if (!contribution || !contribution.supports.includes(surface))
            continue;
        if (!entry.desired.enabled) {
            return { status: "disabled", shellContributionId, shellExtensionId: entry.manifest.id };
        }
        if (entry.actual.some((state) => (state.status === "failed"
            && (actualScope === undefined
                || (state.desiredRevision === entry.desired.revision
                    && (actualScope.hostId === undefined || state.hostId === actualScope.hostId)
                    && (state.realmKind === "host" || actualScope.realmIds?.includes(state.realmId) === true)))))) {
            return { status: "failed", shellContributionId, shellExtensionId: entry.manifest.id };
        }
        return { status: "ready", shellContributionId, shellExtensionId: entry.manifest.id };
    }
    return { status: "missing", shellContributionId };
};
export const resolvePiariumWorkbenchLayoutForProfile = (documentValue, context, profileIdValue) => {
    const document = parsePiariumWorkbenchProfileDocument(documentValue);
    const selected = profileId(profileIdValue, "profileId");
    if (!document.profiles.some((profile) => profile.id === selected)) {
        throw new Error(`Workbench profile is not installed: ${selected}`);
    }
    const userId = text(context.userId, "userId");
    const workspaceId = context.workspaceId?.trim() || undefined;
    const nextDocument = {
        ...document,
        activeProfileId: selected,
        profileSelections: {
            users: workspaceId ? document.profileSelections.users : { ...document.profileSelections.users, [userId]: selected },
            workspaces: workspaceId
                ? { ...document.profileSelections.workspaces, [workspaceId]: selected }
                : document.profileSelections.workspaces,
        },
    };
    return resolvePiariumWorkbenchLayout(nextDocument, context);
};
export const resolvePiariumWorkbenchProfile = (documentValue, catalog, context) => {
    const layout = resolvePiariumWorkbenchLayout(documentValue, context);
    const inspected = inspectPiariumWorkbenchShell(layout.replacementSelections, catalog, context.surface);
    return {
        layout,
        profileId: layout.profileId,
        status: inspected.status,
        ...(inspected.shellContributionId ? { shellContributionId: inspected.shellContributionId } : {}),
        ...(inspected.shellExtensionId ? { shellExtensionId: inspected.shellExtensionId } : {}),
    };
};
export const workbenchDocumentFromStorage = (snapshot) => parsePiariumWorkbenchProfileDocument({
    ...(snapshot.exists ? snapshot.document.data : defaultPiariumWorkbenchProfileDocument()),
    revision: snapshot.document.revision,
    schemaVersion: PIARIUM_WORKBENCH_PROFILE_SCHEMA_VERSION,
    updatedAt: snapshot.document.updatedAt,
});
//# sourceMappingURL=workbench.js.map