import type {
  JsonObject,
  PiariumApplicationSurface,
  PiariumExtensionManifest,
  PiariumExtensionStaticContribution,
} from "@piarium/extension-contract";
import {
  PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
  PIARIUM_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID,
  PIARIUM_BUILTIN_AGENT_WORKSPACE_SURFACES,
  PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION_ID,
  PIARIUM_BUILTIN_IDE_WORKBENCH_SHELL_CONTRIBUTION_ID,
  PIARIUM_BUILTIN_IDE_WORKBENCH_SURFACES,
  PIARIUM_BUILTIN_TRANSITION_SCENE_CONTRIBUTION_ID,
  PIARIUM_BUILTIN_TRANSITION_SCENE_EXTENSION_ID,
  PIARIUM_TRANSITION_SCENE_DATA_CONTRACT,
  PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE,
  PIARIUM_CORE_SERVICE_VERSION,
  PIARIUM_WORKBENCH_LAYOUT_SERVICE_ID,
  PIARIUM_WORKBENCH_REPLACEMENT_TARGETS,
} from "@piarium/extension-contract";

export interface PiariumBuiltinExtensionDefinition {
  enabledByDefault: boolean;
  manifest: PiariumExtensionManifest;
}

export interface PiariumBuiltinPluginAdapterData {
  adapterId: string;
  contract: "pi-plugin-settings-adapter/v1";
  icon: string;
  packageNames: string[];
}

export const PIARIUM_BUILTIN_EXTENSION_VERSION = "0.1.0";
export const PIARIUM_BUILTIN_EXTENSION_PREFIX = "piarium.builtin.";
export const PIARIUM_INTEGRATION_ENTRYPOINT_ID = "main";
export const PIARIUM_INTEGRATION_SURFACES: PiariumApplicationSurface[] = ["web", "desktop", "mobile", "vscode"];
export const PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID = "piarium.builtin.typescript-language";
export const PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_VERSION = "5.3.0+typescript.5.9.3";

const pageContribution = (input: {
  group: "pi";
  icon: string;
  id: string;
  keywords: string[];
  kind: "single" | "split";
  order: number;
  slug: string;
  title: string;
  titleKey: string;
}): PiariumExtensionStaticContribution => ({
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

const pluginAdapterContribution = (
  extensionId: string,
  adapterId: string,
  icon: string,
  packageNames: string[],
): PiariumExtensionStaticContribution => ({
  contractVersion: 1,
  data: {
    adapterId,
    contract: "pi-plugin-settings-adapter/v1",
    icon,
    packageNames,
      } satisfies PiariumBuiltinPluginAdapterData & JsonObject,
  entrypoint: PIARIUM_INTEGRATION_ENTRYPOINT_ID,
  id: `${extensionId}.adapter`,
  kind: "panel",
  placement: { slot: "pi.plugin-settings.adapters" },
  supports: PIARIUM_INTEGRATION_SURFACES,
});

const definition = (input: {
  contributions: PiariumExtensionStaticContribution[];
  displayName: string;
  id: string;
  piPackages?: string[];
  provides?: PiariumExtensionManifest['provides'];
  supports?: PiariumApplicationSurface[];
}): PiariumBuiltinExtensionDefinition => {
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
  displayName: "Pi Recovery Integration",
  piPackages: ["pi-workspace-history", "pi-wtf"],
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

export const PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION = definition({
  id: PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION_ID,
  displayName: "Agent Workspace",
  contributions: [{
    contractVersion: 1,
    data: {},
    entrypoint: PIARIUM_INTEGRATION_ENTRYPOINT_ID,
    id: PIARIUM_BUILTIN_AGENT_WORKSPACE_SHELL_CONTRIBUTION_ID,
    kind: "shell",
    replacement: { target: PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell },
    supports: PIARIUM_BUILTIN_AGENT_WORKSPACE_SURFACES,
  }],
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
    data: {},
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

export const PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION: PiariumBuiltinExtensionDefinition = {
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

const pluginAdapter = (
  suffix: string,
  displayName: string,
  adapterId: string,
  icon: string,
  packageNames: string[],
): PiariumBuiltinExtensionDefinition => {
  const id = `piarium.builtin.plugin-adapter.${suffix}`;
  return definition({
    id,
    displayName,
    piPackages: packageNames,
    contributions: [pluginAdapterContribution(id, adapterId, icon, packageNames)],
  });
};

export const PIARIUM_BUILTIN_PLUGIN_ADAPTER_EXTENSIONS = [
  pluginAdapter("mcp", "pi-mcp-adapter Settings Adapter", "mcp", "server", ["pi-mcp-adapter"]),
  pluginAdapter("subagents", "pi-subagents Settings Adapter", "subagents", "robot-2", ["pi-subagents"]),
  pluginAdapter("magic-context", "Magic Context Settings Adapter", "magic-context", "brain", ["@cortexkit/pi-magic-context"]),
  pluginAdapter("web-access", "Web Access Settings Adapter", "web-access", "global", ["pi-web-access"]),
  pluginAdapter("workspace-history", "Workspace History Settings Adapter", "workspace-history", "history", ["pi-workspace-history"]),
  pluginAdapter("wtf", "pi-wtf Settings Adapter", "wtf", "arrow-go-back", ["pi-wtf"]),
  pluginAdapter("openai-codex-compat", "OpenAI Codex Compatibility Settings Adapter", "openai-codex-compat", "code-box", ["pi-openai-codex-compat"]),
  pluginAdapter("observational-memory", "Observational Memory Settings Adapter", "observational-memory", "brain", ["pi-observational-memory"]),
  pluginAdapter("context-mode", "Context Mode Integration Adapter", "context-mode", "database-2", ["context-mode"]),
  pluginAdapter("aft", "AFT Settings Adapter", "aft", "tools", ["@cortexkit/aft-pi"]),
  pluginAdapter("pi-lens", "pi-lens Settings Adapter", "pi-lens", "pulse", ["pi-lens"]),
  pluginAdapter("permission-system", "Permission System Settings Adapter", "permission-system", "shield-keyhole", ["@gotgenes/pi-permission-system"]),
  pluginAdapter("hermes-memory", "Hermes Memory Settings Adapter", "hermes-memory", "brain", ["pi-hermes-memory"]),
  pluginAdapter("rtk", "RTK Optimizer Settings Adapter", "rtk", "terminal-box", ["pi-rtk-optimizer"]),
] as const;

export const PIARIUM_BUILTIN_EXTENSION_DEFINITIONS: readonly PiariumBuiltinExtensionDefinition[] = [
  PIARIUM_BUILTIN_TRANSITION_SCENE_EXTENSION,
  PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION,
  PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION,
  PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION,
  PIARIUM_BUILTIN_AGENTS_EXTENSION,
  PIARIUM_BUILTIN_FLEET_EXTENSION,
  PIARIUM_BUILTIN_MCP_EXTENSION,
  PIARIUM_BUILTIN_PLUGIN_SETTINGS_EXTENSION,
  PIARIUM_BUILTIN_RECOVERY_EXTENSION,
  ...PIARIUM_BUILTIN_PLUGIN_ADAPTER_EXTENSIONS,
];

export const piariumBuiltinDefinition = (extensionId: string): PiariumBuiltinExtensionDefinition | undefined => (
  PIARIUM_BUILTIN_EXTENSION_DEFINITIONS.find((definition) => definition.manifest.id === extensionId)
);
