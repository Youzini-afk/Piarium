import { type JsonValue, type PiariumExtensionCapabilityGrant, type PiariumExtensionCatalogSnapshot, type PiariumExtensionCandidatePreparationResult, type PiariumExtensionServiceInvocationRequest } from "@piarium/extension-contract";
import { ApplicationExtensionCatalog } from "./application-catalog.js";
import type { HostCapabilityRegistry } from "./capability-registry.js";
import { ExtensionPackageManager } from "./package-manager.js";
import { HostServiceRegistry, type HostServiceOwnerIdentity } from "./service-registry.js";
import { ExtensionStorageStore } from "./storage-store.js";
export interface BrokeredHostTransport {
    forceTerminate(): void;
    request(method: string, params?: unknown): Promise<unknown>;
    terminate(): Promise<void>;
}
export interface BrokeredHostTransportOptions {
    grants: PiariumExtensionCapabilityGrant[];
    onCrash(error: Error): void;
    owner: HostServiceOwnerIdentity;
}
export type BrokeredHostTransportFactory = (options: BrokeredHostTransportOptions) => BrokeredHostTransport;
export interface BrokeredHostSupervisorOptions {
    brokerScript: string;
    capabilities: HostCapabilityRegistry;
    catalog: ApplicationExtensionCatalog;
    onStateChange?: () => void;
    packages: ExtensionPackageManager;
    services: HostServiceRegistry;
    storage: ExtensionStorageStore;
    transportFactory?: BrokeredHostTransportFactory;
    invokeService?(request: PiariumExtensionServiceInvocationRequest | unknown, signal?: AbortSignal): Promise<JsonValue>;
}
export declare class BrokeredHostSupervisor {
    #private;
    constructor(options: BrokeredHostSupervisorOptions);
    reconcile(snapshot?: PiariumExtensionCatalogSnapshot): Promise<void>;
    prepareCandidate(extensionId: string, integrity: string): Promise<PiariumExtensionCandidatePreparationResult>;
    selectCandidate(extensionId: string, integrity: string, expectedRevision: number): Promise<PiariumExtensionCatalogSnapshot>;
    discardPreparedCandidate(extensionId: string, integrity: string): Promise<void>;
    forceTerminate(extensionId: string): void;
    activeExtensions(): string[];
    activateExtension(extensionId: string): Promise<void>;
    deactivateExtension(extensionId: string): Promise<void>;
    activateForService(requestValue: PiariumExtensionServiceInvocationRequest | unknown): Promise<void>;
    hasStagedProvider(providerId: string): boolean;
    invokeStagedService(requestValue: PiariumExtensionServiceInvocationRequest | unknown, signal?: AbortSignal): Promise<JsonValue>;
    shutdown(): Promise<void>;
}
//# sourceMappingURL=broker-supervisor.d.ts.map