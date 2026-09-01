import { PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID, PIARIUM_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID, PIARIUM_BUILTIN_AGENT_WORKSPACE_SURFACES, PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION_ID, PIARIUM_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID, PIARIUM_BUILTIN_IDE_WORKBENCH_SURFACES, PIARIUM_BUILTIN_TRANSITION_SCENE_CONTRIBUTION_ID, PIARIUM_BUILTIN_TRANSITION_SCENE_EXTENSION_ID, PIARIUM_TRANSITION_SCENE_DATA_CONTRACT, PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE, PIARIUM_CORE_SERVICE_VERSION, PIARIUM_WORKSPACE_RECOVERY_SERVICE_ID, PIARIUM_WORKSPACE_RECOVERY_SERVICE_VERSION, PIARIUM_WORKBENCH_LAYOUT_SERVICE_ID, PIARIUM_WORKBENCH_REPLACEMENT_TARGETS, PIARIUM_WORKBENCH_SHELL_DATA_CONTRACT, PIARIUM_WORKBENCH_SLOTS, } from "@piarium/extension-contract";
export const PIARIUM_BUILTIN_EXTENSION_VERSION = "0.1.0";
export const PIARIUM_BUILTIN_EXTENSION_PREFIX = "piarium.builtin.";
export const PIARIUM_INTEGRATION_ENTRYPOINT_ID = "main";
export const PIARIUM_INTEGRATION_SURFACES = ["web", "desktop", "mobile", "vscode"];
export const PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID = "piarium.builtin.typescript-language";
export const PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_VERSION = "5.3.0+typescript.5.9.3.piarium.1";
export const PIARIUM_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_ID = "piarium.builtin.recovery";
export const PIARIUM_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_VERSION = "0.4.0";
const pageContribution = (input) => ({
    contractVersion: 1,
    data: {
        group: input.group,
        icon: input.icon,
        keywords: input.keywords,
        kind: input.kind,
        order: input.order,
        slug: input.slug,
        title: input.title,
        titleKey: input.titleKey,
    },
    entrypoint: PIARIUM_INTEGRATION_ENTRYPOINT_ID,
    id: input.id,
    kind: "settings-page",
    placement: { order: input.order, slot: `settings.nav.${input.group}` },
    supports: PIARIUM_INTEGRATION_SURFACES,
});
const pluginAdapterContribution = (extensionId, adapterId, icon, packageNames) => ({
    contractVersion: 1,
    data: {
        adapterId,
        contract: "pi-plugin-settings-adapter/v1",
        icon,
        packageNames,
    },
    entrypoint: PIARIUM_INTEGRATION_ENTRYPOINT_ID,
    id: `${extensionId}.adapter`,
    kind: "panel",
    placement: { slot: "pi.plugin-settings.adapters" },
    supports: PIARIUM_INTEGRATION_SURFACES,
});
const definition = (input) => {
    const supports = input.supports ?? PIARIUM_INTEGRATION_SURFACES;
    return {
        enabledByDefault: true,
        manifest: {
            contributions: input.contributions,
            displayName: input.displayName,
            engines: { piarium: "*" },
            entrypoints: {
                surfaces: [{
                        id: PIARIUM_INTEGRATION_ENTRYPOINT_ID,
                        mode: "declarative",
                        supports,
                    }],
            },
            id: input.id,
            ...(input.piPackages ? { integrates: { piPackages: input.piPackages } } : {}),
            ...(input.provides ? { provides: input.provides } : {}),
            schemaVersion: 1,
            version: PIARIUM_BUILTIN_EXTENSION_VERSION,
        },
    };
};
export const PIARIUM_BUILTIN_AGENTS_EXTENSION = definition({
    id: "piarium.builtin.pi-agents",
    displayName: "Pi Agents Workbench",
    piPackages: ["pi-subagents", "@cortexkit/pi-magic-context"],
    contributions: [pageContribution({
            group: "pi",
            icon: "robot-2",
            id: "piarium.builtin.pi-agents.page.agents",
            keywords: ["agent", "agents", "subagent", "subagents", "roles", "workflow"],
            kind: "split",
            order: 41,
            slug: "agents",
            title: "Agents",
            titleKey: "settings.page.agents.title",
        })],
});
export const PIARIUM_BUILTIN_FLEET_EXTENSION = definition({
    id: "piarium.builtin.pi-fleet",
    displayName: "Pi Fleet Workbench",
    piPackages: ["pi-subagents", "pi-background-tasks"],
    contributions: [pageContribution({
            group: "pi",
            icon: "pulse",
            id: "piarium.builtin.pi-fleet.page.fleet",
            keywords: ["fleet", "subagent", "delegation", "tasks", "running", "background", "eventbus", "logs"],
            kind: "single",
            order: 42,
            slug: "fleet",
            title: "Fleet",
            titleKey: "settings.page.fleet.title",
        })],
});
export const PIARIUM_BUILTIN_MCP_EXTENSION = definition({
    id: "piarium.builtin.pi-mcp",
    displayName: "Pi MCP Workbench",
    piPackages: ["pi-mcp-adapter"],
    contributions: [pageContribution({
            group: "pi",
            icon: "mcp",
            id: "piarium.builtin.pi-mcp.page.mcp",
            keywords: ["mcp", "model context protocol", "pi-mcp-adapter", "servers", "tools", "oauth"],
            kind: "split",
            order: 46,
            slug: "mcp",
            title: "MCP",
            titleKey: "settings.page.mcp.title",
        })],
});
export const PIARIUM_BUILTIN_PLUGIN_SETTINGS_EXTENSION = definition({
    id: "piarium.builtin.pi-plugin-settings",
    displayName: "Pi Plugin Settings",
    contributions: [pageContribution({
            group: "pi",
            icon: "settings-3",
            id: "piarium.builtin.pi-plugin-settings.page.plugin-settings",
            keywords: ["pi", "plugin", "settings", "configuration", "json", "jsonc"],
            kind: "split",
            order: 48,
            slug: "plugin-settings",
            title: "Plugin Settings",
            titleKey: "settings.page.pluginSettings.title",
        })],
});
export const PIARIUM_BUILTIN_RECOVERY_EXTENSION = definition({
    id: "piarium.builtin.pi-recovery",
    displayName: "Piarium Recovery",
    piPackages: [],
    contributions: [{
            contractVersion: 1,
            data: { contract: "pi-settings-panel/v1", panelId: "recovery" },
            entrypoint: PIARIUM_INTEGRATION_ENTRYPOINT_ID,
            id: "piarium.builtin.pi-recovery.panel.recovery",
            kind: "panel",
            placement: { order: 40, slot: "settings.sessions.panels" },
            supports: PIARIUM_INTEGRATION_SURFACES,
        }],
});
const AGENT_FEATURE_TARGETS = [
    PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator,
    PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.chatTimeline,
    PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.chatComposer,
    PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.agents,
    PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.mcp,
    PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.settings,
];
export const PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION = definition({
    id: PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
    displayName: "Agent Workspace",
    contributions: [{
            contractVersion: 1,
            data: {
                contract: PIARIUM_WORKBENCH_SHELL_DATA_CONTRACT,
                seams: {
                    web: {
                        replacementTargets: [
                            ...AGENT_FEATURE_TARGETS,
                            PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.workspaceExplorer,
                        ],
                        slots: [],
                    },
                    desktop: {
                        replacementTargets: [
                            ...AGENT_FEATURE_TARGETS,
                            PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.workspaceExplorer,
                        ],
                        slots: [],
                    },
                    mobile: {
                        replacementTargets: AGENT_FEATURE_TARGETS,
                        slots: [],
                    },
                },
            },
            entrypoint: PIARIUM_INTEGRATION_ENTRYPOINT_ID,
            id: PIARIUM_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID,
            kind: "shell",
            replacement: { target: PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell },
            supports: PIARIUM_BUILTIN_AGENT_WORKSPACE_SURFACES,
        }],
});
const IDE_FEATURE_TARGETS = [
    PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator,
    PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.chatTimeline,
    PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.chatComposer,
    PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.agents,
    PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.mcp,
    PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.settings,
];
const IDE_STRUCTURE_TARGETS = [
    PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.activity,
    PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.primarySidebar,
    PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.editor,
    PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.secondarySidebar,
    PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.panel,
    PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.status,
];
const IDE_SLOTS = [
    PIARIUM_WORKBENCH_SLOTS.activityItems,
    PIARIUM_WORKBENCH_SLOTS.primarySidebarViews,
    PIARIUM_WORKBENCH_SLOTS.editorActions,
    PIARIUM_WORKBENCH_SLOTS.secondarySidebarViews,
    PIARIUM_WORKBENCH_SLOTS.panelViews,
    PIARIUM_WORKBENCH_SLOTS.statusItems,
];
const ideSeams = () => ({
    replacementTargets: [...IDE_FEATURE_TARGETS, ...IDE_STRUCTURE_TARGETS],
    slots: IDE_SLOTS,
});
export const PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION = definition({
    id: PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
    displayName: "IDE Workbench",
    supports: PIARIUM_BUILTIN_IDE_WORKBENCH_SURFACES,
    provides: {
        services: [{
                id: PIARIUM_WORKBENCH_LAYOUT_SERVICE_ID,
                multiple: true,
                version: PIARIUM_CORE_SERVICE_VERSION,
            }],
    },
    contributions: [{
            contractVersion: 1,
            data: {
                contract: PIARIUM_WORKBENCH_SHELL_DATA_CONTRACT,
                seams: Object.fromEntries(PIARIUM_BUILTIN_IDE_WORKBENCH_SURFACES.map((surface) => [surface, ideSeams()])),
            },
            entrypoint: PIARIUM_INTEGRATION_ENTRYPOINT_ID,
            id: PIARIUM_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID,
            kind: "shell",
            replacement: { target: PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell },
            supports: PIARIUM_BUILTIN_IDE_WORKBENCH_SURFACES,
        }],
});
export const PIARIUM_BUILTIN_TRANSITION_SCENE_EXTENSION = definition({
    id: PIARIUM_BUILTIN_TRANSITION_SCENE_EXTENSION_ID,
    displayName: "Piarium Transition Scene",
    supports: PIARIUM_BUILTIN_AGENT_WORKSPACE_SURFACES,
    contributions: [{
            contractVersion: 1,
            data: {
                contract: PIARIUM_TRANSITION_SCENE_DATA_CONTRACT,
                durations: {
                    [PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE]: {
                        covering: { quick: 1_040, reduced: 260, standard: 1_900 },
                        revealing: { quick: 1_040, reduced: 260, standard: 1_900 },
                    },
                },
                fallback: true,
                scenes: [PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE],
            },
            entrypoint: PIARIUM_INTEGRATION_ENTRYPOINT_ID,
            id: PIARIUM_BUILTIN_TRANSITION_SCENE_CONTRIBUTION_ID,
            kind: "transition-scene",
            replacement: { target: PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.transition },
            supports: PIARIUM_BUILTIN_AGENT_WORKSPACE_SURFACES,
        }],
});
export const PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION = {
    enabledByDefault: true,
    manifest: {
        capabilities: { host: ["workspace.language"] },
        displayName: "TypeScript and JavaScript Language Service",
        engines: { piarium: "*" },
        entrypoints: {
            host: {
                activation: ["workspace-match"],
                file: "host.cjs",
                mode: "brokered",
            },
        },
        id: PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID,
        schemaVersion: 1,
        version: PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_VERSION,
    },
};
export const PIARIUM_BUILTIN_WORKSPACE_RECOVERY_EXTENSION = {
    enabledByDefault: true,
    manifest: {
        capabilities: { host: ["workspace.recovery-primitives"] },
        displayName: "Piarium Workspace Recovery",
        engines: { piarium: "*" },
        entrypoints: {
            host: {
                activation: ["service-request"],
                file: "host.cjs",
                mode: "brokered",
            },
        },
        id: PIARIUM_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_ID,
        provides: {
            services: [{
                    id: PIARIUM_WORKSPACE_RECOVERY_SERVICE_ID,
                    multiple: true,
                    version: PIARIUM_WORKSPACE_RECOVERY_SERVICE_VERSION,
                }],
        },
        schemaVersion: 1,
        storage: { schemaVersion: 1 },
        version: PIARIUM_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_VERSION,
    },
};
const pluginAdapter = (suffix, displayName, adapterId, icon, packageNames) => {
    const id = `piarium.builtin.plugin-adapter.${suffix}`;
    return definition({
        id,
        displayName,
        piPackages: packageNames,
        contributions: [pluginAdapterContribution(id, adapterId, icon, packageNames)],
    });
};
const permissionSystemAdapterExtension = () => {
    const id = "piarium.builtin.plugin-adapter.permission-system";
    return definition({
        id,
        displayName: "Permission System Adapter",
        piPackages: ["@gotgenes/pi-permission-system"],
        contributions: [
            pluginAdapterContribution(id, "permission-system", "shield-keyhole", ["@gotgenes/pi-permission-system"]),
            {
                contractVersion: 1,
                data: { contract: "pi-permission-system-composer/v1" },
                entrypoint: PIARIUM_INTEGRATION_ENTRYPOINT_ID,
                id: `${id}.composer`,
                kind: "composer-action",
                placement: { order: 20, slot: "chat.composer.actions.leading" },
                supports: PIARIUM_INTEGRATION_SURFACES,
            },
        ],
    });
};
export const PIARIUM_BUILTIN_PLUGIN_ADAPTER_EXTENSIONS = [
    pluginAdapter("mcp", "pi-mcp-adapter Settings Adapter", "mcp", "server", ["pi-mcp-adapter"]),
    pluginAdapter("subagents", "pi-subagents Settings Adapter", "subagents", "robot-2", ["pi-subagents"]),
    pluginAdapter("magic-context", "Magic Context Settings Adapter", "magic-context", "brain", ["@cortexkit/pi-magic-context"]),
    pluginAdapter("web-access", "Web Access Settings Adapter", "web-access", "global", ["pi-web-access"]),
    pluginAdapter("openai-codex-compat", "OpenAI Codex Compatibility Settings Adapter", "openai-codex-compat", "code-box", ["pi-openai-codex-compat"]),
    pluginAdapter("observational-memory", "Observational Memory Settings Adapter", "observational-memory", "brain", ["pi-observational-memory"]),
    pluginAdapter("context-mode", "Context Mode Integration Adapter", "context-mode", "database-2", ["context-mode"]),
    pluginAdapter("aft", "AFT Settings Adapter", "aft", "tools", ["@cortexkit/aft-pi"]),
    pluginAdapter("pi-lens", "pi-lens Settings Adapter", "pi-lens", "pulse", ["pi-lens"]),
    permissionSystemAdapterExtension(),
    pluginAdapter("hermes-memory", "Hermes Memory Settings Adapter", "hermes-memory", "brain", ["pi-hermes-memory"]),
    pluginAdapter("rtk", "RTK Optimizer Settings Adapter", "rtk", "terminal-box", ["pi-rtk-optimizer"]),
];
export const PIARIUM_BUILTIN_EXTENSION_DEFINITIONS = [
    PIARIUM_BUILTIN_TRANSITION_SCENE_EXTENSION,
    PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION,
    PIARIUM_BUILTIN_WORKSPACE_RECOVERY_EXTENSION,
    PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION,
    PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION,
    PIARIUM_BUILTIN_AGENTS_EXTENSION,
    PIARIUM_BUILTIN_FLEET_EXTENSION,
    PIARIUM_BUILTIN_MCP_EXTENSION,
    PIARIUM_BUILTIN_PLUGIN_SETTINGS_EXTENSION,
    PIARIUM_BUILTIN_RECOVERY_EXTENSION,
    ...PIARIUM_BUILTIN_PLUGIN_ADAPTER_EXTENSIONS,
];
export const piariumBuiltinDefinition = (extensionId) => (PIARIUM_BUILTIN_EXTENSION_DEFINITIONS.find((definition) => definition.manifest.id === extensionId));
//# sourceMappingURL=index.js.map