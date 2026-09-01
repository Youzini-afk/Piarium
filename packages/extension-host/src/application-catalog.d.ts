import { type PiariumExtensionActualState, type PiariumExtensionCatalogSnapshot, type PiariumExtensionCandidateCapabilityReviewRequest, type PiariumExtensionCapabilityGrant, type PiariumExtensionCapabilityReviewRequest, type PiariumExtensionInstallationRecord, type PiariumExtensionPreparedArtifact } from "@piarium/extension-contract";
import type { PiariumBuiltinExtensionDefinition } from "@piarium/extension-builtins";
import { ExtensionCatalogStore } from "./catalog-store.js";
export declare class ApplicationExtensionCatalog {
    #private;
    readonly store: ExtensionCatalogStore;
    constructor(options: {
        dataDir: string;
        store?: ExtensionCatalogStore;
    });
    snapshot(): Promise<PiariumExtensionCatalogSnapshot>;
    upsert(record: PiariumExtensionInstallationRecord, expectedRevision: number): Promise<PiariumExtensionCatalogSnapshot>;
    remove(extensionId: string, expectedRevision: number): Promise<PiariumExtensionCatalogSnapshot>;
    setEnabled(extensionId: string, enabled: boolean, expectedRevision: number): Promise<PiariumExtensionCatalogSnapshot>;
    setAllEnabled(enabled: boolean, expectedRevision: number): Promise<PiariumExtensionCatalogSnapshot>;
    setEnabledSet(extensionIds: readonly string[], expectedRevision: number): Promise<PiariumExtensionCatalogSnapshot>;
    reconcileBuiltins(definitions: readonly PiariumBuiltinExtensionDefinition[], ownedPrefix: string): Promise<PiariumExtensionCatalogSnapshot>;
    setCapabilityGrant(extensionId: string, grant: PiariumExtensionCapabilityGrant, expectedRevision: number): Promise<PiariumExtensionCatalogSnapshot>;
    reviewCapabilities(request: PiariumExtensionCapabilityReviewRequest): Promise<PiariumExtensionCatalogSnapshot>;
    stageCandidate(candidate: PiariumExtensionPreparedArtifact, expectedRevision: number): Promise<PiariumExtensionCatalogSnapshot>;
    selectBuiltinArtifact(candidate: PiariumExtensionPreparedArtifact): Promise<PiariumExtensionCatalogSnapshot>;
    reviewCandidateCapabilities(request: PiariumExtensionCandidateCapabilityReviewRequest): Promise<PiariumExtensionCatalogSnapshot>;
    selectCandidate(extensionId: string, candidateIntegrity: string, expectedRevision: number): Promise<PiariumExtensionCatalogSnapshot>;
    requestCandidateApplication(extensionId: string, candidateIntegrity: string, expectedRevision: number): Promise<PiariumExtensionCatalogSnapshot>;
    discardCandidate(extensionId: string, candidateIntegrity: string, expectedRevision: number): Promise<PiariumExtensionCatalogSnapshot>;
    reportActualState(extensionId: string, state: PiariumExtensionActualState): Promise<void>;
}
//# sourceMappingURL=application-catalog.d.ts.map