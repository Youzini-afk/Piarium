import type { PiariumApplicationSurface, PiariumExtensionCatalogEntry, PiariumExtensionCatalogSnapshot, PiariumExtensionDiagnostic, PiariumExtensionStorageSnapshot } from "./types.js";
export declare const PIARIUM_WORKBENCH_PROFILE_SCHEMA_VERSION: 1;
export declare const PIARIUM_WORKBENCH_DEFAULT_PROFILE_ID = "default";
export declare const PIARIUM_WORKBENCH_DEFAULT_PROFILE_LABEL = "Agent";
export declare const PIARIUM_WORKBENCH_IDE_PROFILE_ID = "piarium.ide";
export declare const PIARIUM_WORKBENCH_IDE_PROFILE_LABEL = "IDE";
export declare const PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID = "piarium.builtin.agent-workspace";
export declare const PIARIUM_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID = "piarium.builtin.agent-workspace.shell";
export declare const PIARIUM_BUILTIN_AGENT_WORKSPACE_SURFACES: PiariumApplicationSurface[];
export declare const PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION_ID = "piarium.builtin.ide-workbench";
export declare const PIARIUM_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID = "piarium.builtin.ide-workbench.shell";
export declare const PIARIUM_BUILTIN_IDE_WORKBENCH_SURFACES: PiariumApplicationSurface[];
export declare const PIARIUM_WORKBENCH_REPLACEMENT_TARGETS: {
    readonly agents: "agents.workbench";
    readonly chatComposer: "chat.composer";
    readonly chatTimeline: "chat.timeline";
    readonly mcp: "mcp.workbench";
    readonly sessionNavigator: "sessions.navigator";
    readonly settings: "settings.workbench";
    readonly shell: "workbench.shell";
    readonly workspaceExplorer: "workspace.explorer";
    readonly activity: "workbench.activity";
    readonly primarySidebar: "workbench.primary-sidebar";
    readonly editor: "workbench.editor";
    readonly secondarySidebar: "workbench.secondary-sidebar";
    readonly panel: "workbench.panel";
    readonly status: "workbench.status";
    readonly transition: "workbench.transition";
};
export declare const PIARIUM_WORKBENCH_SLOTS: {
    readonly activityItems: "workbench.activity.items";
    readonly primarySidebarViews: "workbench.primary-sidebar.views";
    readonly editorActions: "workbench.editor.actions";
    readonly secondarySidebarViews: "workbench.secondary-sidebar.views";
    readonly panelViews: "workbench.panel.views";
    readonly statusItems: "workbench.status.items";
};
/** Props for `workbench.editor.actions` — rendered in the active editor group's action strip. */
export interface PiariumWorkbenchEditorActionsSlotProps {
    workspaceId: string;
    groupId: string;
    resourceId?: string;
    viewId?: string;
}
/** Props for `workbench.panel.views` — rendered in the panel content area. */
export interface PiariumWorkbenchPanelViewsSlotProps {
    workspaceId: string;
    activePanelId: string;
}
/** Props for `workbench.activity.items` — rendered in the activity bar. */
export interface PiariumWorkbenchActivityItemsSlotProps {
    workspaceId: string;
}
/** Props for `workbench.primary-sidebar.views` — rendered in the primary sidebar. */
export interface PiariumWorkbenchPrimarySidebarViewsSlotProps {
    workspaceId: string;
    activeActivityId: string;
}
/** Props for `workbench.secondary-sidebar.views` — rendered in the secondary sidebar. */
export interface PiariumWorkbenchSecondarySidebarViewsSlotProps {
    workspaceId: string;
}
/** Props for `workbench.status.items` — rendered in the status bar. */
export interface PiariumWorkbenchStatusItemsSlotProps {
    workspaceId: string;
}
export declare const PIARIUM_WORKBENCH_CONTEXT_KEYS: {
    readonly editorHasSelection: "editorHasSelection";
    readonly editorIsDirty: "editorIsDirty";
    readonly editorIsOpen: "editorIsOpen";
    readonly debugIsActive: "debugIsActive";
    readonly debugIsPaused: "debugIsPaused";
    readonly testHasFailure: "testHasFailure";
    readonly taskIsRunning: "taskIsRunning";
};
export declare const PIARIUM_WORKBENCH_SHELL_DATA_CONTRACT: "piarium-workbench-shell/v1";
export interface PiariumWorkbenchShellSurfaceSeams {
    replacementTargets: string[];
    slots: string[];
}
export type PiariumWorkbenchShellContributionDataV1 = {
    contract: typeof PIARIUM_WORKBENCH_SHELL_DATA_CONTRACT;
    seams: Partial<Record<PiariumApplicationSurface, PiariumWorkbenchShellSurfaceSeams>>;
};
export declare class PiariumWorkbenchShellContractError extends Error {
    readonly issues: string[];
    constructor(message: string, issues: string[]);
}
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
export declare const parsePiariumWorkbenchShellContributionData: (data: unknown, supports: readonly PiariumApplicationSurface[]) => PiariumWorkbenchShellContributionDataV1;
/**
 * Resolve the seams for a specific surface from a parsed shell contribution
 * data. Returns empty seams if the surface is not declared.
 */
export declare const resolvePiariumWorkbenchShellSurfaceSeams: (data: PiariumWorkbenchShellContributionDataV1, surface: PiariumApplicationSurface) => PiariumWorkbenchShellSurfaceSeams;
export type PiariumWorkbenchShellStatus = "builtin" | "disabled" | "failed" | "missing" | "ready";
export interface PiariumWorkbenchResolvedProfile {
    layout: PiariumWorkbenchResolvedLayout;
    profileId: string;
    shellContributionId?: string;
    shellExtensionId?: string;
    status: PiariumWorkbenchShellStatus;
}
export type PiariumWorkbenchLayoutScope = "distribution" | "user" | "workspace";
export interface PiariumWorkbenchLayoutReference {
    contributionId: string;
    order?: number;
    region?: string;
    size?: number;
    visible?: boolean;
}
export interface PiariumWorkbenchLayoutLayer {
    profileId: string;
    references: PiariumWorkbenchLayoutReference[];
    replacementSelections: Record<string, string>;
    scope: PiariumWorkbenchLayoutScope;
    scopeId: string;
    surface: PiariumApplicationSurface;
}
export interface PiariumWorkbenchDistributionProfile {
    extensionIds?: string[];
    id: string;
    label: string;
}
export interface PiariumWorkbenchProfileSelections {
    users: Record<string, string>;
    workspaces: Record<string, string>;
}
export interface PiariumWorkbenchProfileDocument {
    activeProfileId: string;
    layouts: PiariumWorkbenchLayoutLayer[];
    profileSelections: PiariumWorkbenchProfileSelections;
    profiles: PiariumWorkbenchDistributionProfile[];
    revision: number;
    schemaVersion: typeof PIARIUM_WORKBENCH_PROFILE_SCHEMA_VERSION;
    updatedAt: string;
}
export interface PiariumWorkbenchProfileSnapshot {
    authoritative: boolean;
    diagnostics: PiariumExtensionDiagnostic[];
    document: PiariumWorkbenchProfileDocument;
    hostId: string;
    storageState: "missing" | "ready" | "stale";
}
export interface PiariumWorkbenchLayoutUpdateRequest {
    expectedRevision: number;
    layer: PiariumWorkbenchLayoutLayer;
}
export interface PiariumWorkbenchProfileSelectionRequest {
    expectedRevision: number;
    profileId: string;
    scope: "application" | "user" | "workspace";
    scopeId?: string;
}
export interface PiariumWorkbenchProfileUpsertRequest {
    expectedRevision: number;
    profile: PiariumWorkbenchDistributionProfile;
}
export interface PiariumWorkbenchProfileRemoveRequest {
    expectedRevision: number;
    profileId: string;
}
export interface PiariumWorkbenchProfileApplyRequest {
    expectedCatalogRevision: number;
    profileId: string;
}
export interface PiariumWorkbenchResolutionContext {
    surface: PiariumApplicationSurface;
    userId: string;
    workspaceId?: string;
}
export interface PiariumWorkbenchResolvedLayout {
    profileId: string;
    references: PiariumWorkbenchLayoutReference[];
    replacementSelections: Record<string, string>;
}
export declare const parsePiariumWorkbenchLayoutLayer: (value: unknown) => PiariumWorkbenchLayoutLayer;
export declare const parsePiariumWorkbenchProfileDocument: (value: unknown) => PiariumWorkbenchProfileDocument;
export declare const parsePiariumWorkbenchProfileSnapshot: (value: unknown) => PiariumWorkbenchProfileSnapshot;
export declare const parsePiariumWorkbenchLayoutUpdateRequest: (value: unknown) => PiariumWorkbenchLayoutUpdateRequest;
export declare const parsePiariumWorkbenchProfileSelectionRequest: (value: unknown) => PiariumWorkbenchProfileSelectionRequest;
export declare const parsePiariumWorkbenchProfileUpsertRequest: (value: unknown) => PiariumWorkbenchProfileUpsertRequest;
export declare const parsePiariumWorkbenchProfileRemoveRequest: (value: unknown) => PiariumWorkbenchProfileRemoveRequest;
export declare const parsePiariumWorkbenchProfileApplyRequest: (value: unknown) => PiariumWorkbenchProfileApplyRequest;
export declare const defaultPiariumWorkbenchProfileDocument: () => PiariumWorkbenchProfileDocument;
export declare const migratePiariumWorkbenchProfileDocument: (document: PiariumWorkbenchProfileDocument) => boolean;
export declare const resolvePiariumWorkbenchLayout: (documentValue: PiariumWorkbenchProfileDocument | unknown, context: PiariumWorkbenchResolutionContext) => PiariumWorkbenchResolvedLayout;
export declare const inspectPiariumWorkbenchShell: (replacementSelections: Readonly<Record<string, string>>, catalog: Pick<PiariumExtensionCatalogSnapshot, "extensions"> | readonly PiariumExtensionCatalogEntry[], surface: PiariumApplicationSurface, actualScope?: {
    hostId?: string;
    realmIds?: readonly string[];
}) => Pick<PiariumWorkbenchResolvedProfile, "shellContributionId" | "shellExtensionId" | "status">;
export declare const resolvePiariumWorkbenchLayoutForProfile: (documentValue: PiariumWorkbenchProfileDocument | unknown, context: PiariumWorkbenchResolutionContext, profileIdValue: string) => PiariumWorkbenchResolvedLayout;
export declare const resolvePiariumWorkbenchProfile: (documentValue: PiariumWorkbenchProfileDocument | unknown, catalog: Pick<PiariumExtensionCatalogSnapshot, "extensions"> | readonly PiariumExtensionCatalogEntry[], context: PiariumWorkbenchResolutionContext) => PiariumWorkbenchResolvedProfile;
export declare const workbenchDocumentFromStorage: (snapshot: PiariumExtensionStorageSnapshot) => PiariumWorkbenchProfileDocument;
//# sourceMappingURL=workbench.d.ts.map