import { type PiariumExtensionActualState, type PiariumExtensionAssetPayload, type PiariumExtensionAssetRequest, type PiariumExtensionCandidateSelectionRequest, type PiariumExtensionCatalogSnapshot, type PiariumExtensionManagedEntrypointPayload, type PiariumExtensionManagedEntrypointRequest, type PiariumExtensionLocalSourceReloadRequest, type PiariumExtensionLocalSourceReloadResult, type PiariumExtensionPackageSource } from "@piarium/extension-contract";
import { ApplicationExtensionCatalog } from "./application-catalog.js";
import type { PiariumBuiltinExtensionDefinition } from "@piarium/extension-builtins";
import { ExtensionArtifactStore } from "./artifact-store.js";
import type { BrokeredHostEntrypointArtifact } from "./artifact-store.js";
export interface ExtensionPackageManagerOptions {
    artifacts?: ExtensionArtifactStore;
    catalog: ApplicationExtensionCatalog;
    dataDir: string;
    piariumVersion: string;
}
export declare class ExtensionPackageManager {
    #private;
    readonly artifacts: ExtensionArtifactStore;
    readonly catalog: ApplicationExtensionCatalog;
    readonly piariumVersion: string;
    constructor(options: ExtensionPackageManagerOptions);
    installOrStage(source: PiariumExtensionPackageSource, expectedRevision: number, signal?: AbortSignal): Promise<PiariumExtensionCatalogSnapshot>;
    reconcileBuiltinArtifacts(definitions: readonly PiariumBuiltinExtensionDefinition[], snapshot: PiariumExtensionCatalogSnapshot): Promise<PiariumExtensionCatalogSnapshot>;
    reloadLocalSource(request: PiariumExtensionLocalSourceReloadRequest, signal?: AbortSignal): Promise<PiariumExtensionLocalSourceReloadResult>;
    selectCandidate(requestValue: PiariumExtensionCandidateSelectionRequest | unknown): Promise<PiariumExtensionCatalogSnapshot>;
    readAsset(requestValue: PiariumExtensionAssetRequest | unknown): Promise<PiariumExtensionAssetPayload>;
    readManagedEntrypoint(requestValue: PiariumExtensionManagedEntrypointRequest | unknown): Promise<PiariumExtensionManagedEntrypointPayload>;
    reportActualState(extensionId: string, state: PiariumExtensionActualState): Promise<void>;
    resolveBrokeredHostEntrypoint(extensionId: string, slot: "candidate" | "selected", integrity: string): Promise<BrokeredHostEntrypointArtifact>;
}
//# sourceMappingURL=package-manager.d.ts.map