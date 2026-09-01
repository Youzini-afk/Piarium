import { type ThinkingLevel } from "./types.js";
export declare const PROVIDER_CONFIG_SCOPES: readonly ["user", "project", "custom"];
export type ProviderConfigScope = (typeof PROVIDER_CONFIG_SCOPES)[number];
export type ProviderConfigDeleteScope = ProviderConfigScope | "auth" | "all";
export declare const DISCOVERABLE_PROVIDER_APIS: readonly ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];
export type DiscoverableProviderApi = (typeof DISCOVERABLE_PROVIDER_APIS)[number];
export interface ProviderModelCostInput {
    cacheRead?: number;
    cacheWrite?: number;
    input?: number;
    output?: number;
}
export interface ProviderModelConfigInput {
    api?: string;
    baseUrl?: string;
    contextWindow?: number;
    cost?: ProviderModelCostInput;
    id: string;
    input?: Array<"text" | "image">;
    maxTokens?: number;
    name?: string;
    reasoning?: boolean;
    thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}
/**
 * Browser-safe subset of Pi's native models.json provider definition.
 * Dedicated Pi credentials and arbitrary headers deliberately never cross this boundary. An
 * explicitly configured URL remains intact, including optional URL basic-auth information.
 */
export interface ProviderConfigInput {
    api?: string;
    authHeader?: boolean;
    baseUrl?: string;
    id: string;
    models?: ProviderModelConfigInput[];
    name?: string;
}
export interface ProviderConfigLocation {
    available: boolean;
    exists: boolean;
    path?: string;
    scope: ProviderConfigScope;
    writable: boolean;
}
export interface ProviderConfigDetails {
    auth: {
        configured: boolean;
        label?: string;
        source?: string;
    };
    config?: ProviderConfigInput;
    effectiveScope?: ProviderConfigScope;
    locations: Record<ProviderConfigScope, ProviderConfigLocation>;
    providerId: string;
}
export interface ProviderModelDiscoveryResult {
    api: DiscoverableProviderApi;
    baseUrl: string;
    models: ProviderModelConfigInput[];
    providerId: string;
}
export declare class ProviderConfigValidationError extends Error {
    readonly path: string;
    constructor(path: string, message: string);
}
export declare function parseProviderConfigInput(value: unknown): ProviderConfigInput;
//# sourceMappingURL=provider.d.ts.map