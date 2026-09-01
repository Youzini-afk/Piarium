import { type PiariumExtensionCatalogDocument, type PiariumExtensionCapabilityDecision, type PiariumExtensionCapabilityGrant, type PiariumExtensionDiagnostic, type PiariumExtensionHostIdentityDocument, type PiariumExtensionInstallationRecord, type PiariumExtensionPreparedArtifact } from "@piarium/extension-contract";
import type { PiariumBuiltinExtensionDefinition } from "@piarium/extension-builtins";
interface CatalogReadState {
    authoritative: boolean;
    diagnostics: PiariumExtensionDiagnostic[];
    document: PiariumExtensionCatalogDocument;
    storageState: "missing" | "ready" | "stale";
}
export declare class ExtensionCatalogStore {
    #private;
    readonly dataDir: string;
    readonly directory: string;
    readonly catalogPath: string;
    readonly identityPath: string;
    constructor(dataDir: string);
    getHostIdentity(): Promise<PiariumExtensionHostIdentityDocument>;
    read(): Promise<CatalogReadState>;
    upsert(recordValue: PiariumExtensionInstallationRecord, expectedRevision: number): Promise<CatalogReadState>;
    remove(extensionId: string, expectedRevision: number): Promise<CatalogReadState>;
    setEnabled(extensionId: string, enabled: boolean, expectedRevision: number): Promise<CatalogReadState>;
    setAllEnabled(enabled: boolean, expectedRevision: number): Promise<CatalogReadState>;
    setEnabledSet(extensionIds: readonly string[], expectedRevision: number): Promise<CatalogReadState>;
    reconcileBuiltins(definitions: readonly PiariumBuiltinExtensionDefinition[], ownedPrefix: string): Promise<CatalogReadState>;
    selectBuiltinArtifact(candidate: PiariumExtensionPreparedArtifact): Promise<CatalogReadState>;
    setCapabilityGrant(extensionId: string, grant: PiariumExtensionCapabilityGrant, expectedRevision: number): Promise<CatalogReadState>;
    reviewCapabilities(extensionId: string, decisions: readonly PiariumExtensionCapabilityDecision[], expectedRevision: number): Promise<CatalogReadState>;
    stageCandidate(candidate: PiariumExtensionPreparedArtifact, expectedRevision: number): Promise<CatalogReadState>;
    reviewCandidateCapabilities(extensionId: string, candidateIntegrity: string, decisions: readonly PiariumExtensionCapabilityDecision[], expectedRevision: number): Promise<CatalogReadState>;
    selectCandidate(extensionId: string, candidateIntegrity: string, expectedRevision: number): Promise<CatalogReadState>;
    requestCandidateApplication(extensionId: string, candidateIntegrity: string, expectedRevision: number): Promise<CatalogReadState>;
    discardCandidate(extensionId: string, candidateIntegrity: string, expectedRevision: number): Promise<CatalogReadState>;
}
export type { CatalogReadState };
//# sourceMappingURL=catalog-store.d.ts.map