import { type JsonValue, type PiariumExtensionServiceCatalogSnapshot, type PiariumExtensionServiceInvocationRequest, type PiariumExtensionServiceProviderSnapshot, type PiariumExtensionServiceProvision, type PiariumExtensionServiceRequirement } from "@piarium/extension-contract";
export interface HostServiceOwnerIdentity {
    entrypointId: string;
    extensionId: string;
    extensionVersion: string;
    generation: number;
}
export interface HostServiceInvocationContext {
    readonly signal: AbortSignal;
}
export type HostServiceHandler = (method: string, args: JsonValue[], context: HostServiceInvocationContext) => JsonValue | Promise<JsonValue>;
export interface HostServiceProvision {
    descriptor: PiariumExtensionServiceProvision;
    handler: HostServiceHandler;
}
export declare class HostServiceRegistry {
    #private;
    readonly hostId: string;
    constructor(hostId: string);
    getSnapshot: () => PiariumExtensionServiceCatalogSnapshot;
    subscribe(listener: () => void): () => void;
    prepareOwnerReplacement(owner: HostServiceOwnerIdentity, provisions: readonly HostServiceProvision[]): {
        commit(): void;
        finalize(): Promise<void>;
        rollback(): Promise<void>;
    };
    replaceOwner(owner: HostServiceOwnerIdentity, provisions: readonly HostServiceProvision[]): Promise<void>;
    drainOwner(owner: HostServiceOwnerIdentity): Promise<void>;
    removeOwner(owner: HostServiceOwnerIdentity): void;
    setSelection(id: string, version: number, providerId: string | null): void;
    providersFor(requirement: PiariumExtensionServiceRequirement): PiariumExtensionServiceProviderSnapshot[];
    invoke(requestValue: PiariumExtensionServiceInvocationRequest | unknown, signal?: AbortSignal): Promise<JsonValue>;
}
//# sourceMappingURL=service-registry.d.ts.map