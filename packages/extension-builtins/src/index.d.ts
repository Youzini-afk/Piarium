import type { PiariumApplicationSurface, PiariumExtensionManifest } from "@piarium/extension-contract";
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
export declare const PIARIUM_BUILTIN_EXTENSION_VERSION = "0.1.0";
export declare const PIARIUM_BUILTIN_EXTENSION_PREFIX = "piarium.builtin.";
export declare const PIARIUM_INTEGRATION_ENTRYPOINT_ID = "main";
export declare const PIARIUM_INTEGRATION_SURFACES: PiariumApplicationSurface[];
export declare const PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID = "piarium.builtin.typescript-language";
export declare const PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_VERSION = "5.3.0+typescript.5.9.3.piarium.1";
export declare const PIARIUM_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_ID = "piarium.builtin.recovery";
export declare const PIARIUM_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_VERSION = "0.4.0";
export declare const PIARIUM_BUILTIN_AGENTS_EXTENSION: PiariumBuiltinExtensionDefinition;
export declare const PIARIUM_BUILTIN_FLEET_EXTENSION: PiariumBuiltinExtensionDefinition;
export declare const PIARIUM_BUILTIN_MCP_EXTENSION: PiariumBuiltinExtensionDefinition;
export declare const PIARIUM_BUILTIN_PLUGIN_SETTINGS_EXTENSION: PiariumBuiltinExtensionDefinition;
export declare const PIARIUM_BUILTIN_RECOVERY_EXTENSION: PiariumBuiltinExtensionDefinition;
export declare const PIARIUM_BUILTIN_AGENT_WORKSPACE_EXTENSION: PiariumBuiltinExtensionDefinition;
export declare const PIARIUM_BUILTIN_IDE_WORKBENCH_EXTENSION: PiariumBuiltinExtensionDefinition;
export declare const PIARIUM_BUILTIN_TRANSITION_SCENE_EXTENSION: PiariumBuiltinExtensionDefinition;
export declare const PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION: PiariumBuiltinExtensionDefinition;
export declare const PIARIUM_BUILTIN_WORKSPACE_RECOVERY_EXTENSION: PiariumBuiltinExtensionDefinition;
export declare const PIARIUM_BUILTIN_PLUGIN_ADAPTER_EXTENSIONS: readonly [PiariumBuiltinExtensionDefinition, PiariumBuiltinExtensionDefinition, PiariumBuiltinExtensionDefinition, PiariumBuiltinExtensionDefinition, PiariumBuiltinExtensionDefinition, PiariumBuiltinExtensionDefinition, PiariumBuiltinExtensionDefinition, PiariumBuiltinExtensionDefinition, PiariumBuiltinExtensionDefinition, PiariumBuiltinExtensionDefinition, PiariumBuiltinExtensionDefinition, PiariumBuiltinExtensionDefinition];
export declare const PIARIUM_BUILTIN_EXTENSION_DEFINITIONS: readonly PiariumBuiltinExtensionDefinition[];
export declare const piariumBuiltinDefinition: (extensionId: string) => PiariumBuiltinExtensionDefinition | undefined;
//# sourceMappingURL=index.d.ts.map