import type { PiConfigTextFormat, PiConfigTextRoot } from "./types.js";
export declare const PI_MCP_CONFIG_CATALOG_VERSION: 1;
export type PiMcpConfigProviderState = "active" | "degraded" | "incompatible" | "unavailable";
export interface PiMcpConfigProviderSnapshot {
    bridgeVersion?: number;
    issue?: string;
    state: PiMcpConfigProviderState;
}
export interface PiMcpConfigSourceTarget {
    format: PiConfigTextFormat;
    path: string;
    root: PiConfigTextRoot;
}
export interface PiMcpConfigSource {
    displayPath: string;
    id: string;
    order: number;
    scope: "project" | "user";
    serverNames: string[];
    target: PiMcpConfigSourceTarget;
}
export interface PiMcpConfigTransport {
    command?: string;
    kind: "http" | "inherited" | "socket" | "stdio";
    socket?: string;
    url?: string;
}
export interface PiMcpConfigServer {
    disabled: boolean;
    name: string;
    sourceIds: string[];
    transport: PiMcpConfigTransport;
}
export interface PiMcpConfigCatalogSnapshot {
    servers: PiMcpConfigServer[];
    sources: PiMcpConfigSource[];
    version: typeof PI_MCP_CONFIG_CATALOG_VERSION;
}
export interface PiMcpConfigSnapshot {
    catalog?: PiMcpConfigCatalogSnapshot;
    provider: PiMcpConfigProviderSnapshot;
}
export declare class PiMcpConfigValidationError extends Error {
    constructor(message: string);
}
/**
 * Validate the adapter-owned configCatalog/v1 projection before it crosses the
 * trusted Pi host boundary. The parser intentionally projects only documented
 * fields so credentials and future private fields cannot reach a renderer.
 */
export declare function parsePiMcpConfigCatalog(value: unknown): PiMcpConfigCatalogSnapshot;
//# sourceMappingURL=mcp.d.ts.map