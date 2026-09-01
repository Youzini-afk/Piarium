import type { PiariumExtensionPackageSource } from "./types.js";
export declare const PIARIUM_EXTENSION_DISCOVERY_SCHEMA_VERSION: 1;
export interface PiariumExtensionDiscoveryEntry {
    description?: string;
    displayName?: string;
    homepage?: string;
    icon?: string;
    id: string;
    keywords?: string[];
    source: PiariumExtensionPackageSource;
}
export interface PiariumExtensionDiscoveryDocument {
    entries: PiariumExtensionDiscoveryEntry[];
    schemaVersion: typeof PIARIUM_EXTENSION_DISCOVERY_SCHEMA_VERSION;
}
export declare const parsePiariumExtensionDiscoveryDocument: (value: unknown) => PiariumExtensionDiscoveryDocument;
//# sourceMappingURL=discovery.d.ts.map