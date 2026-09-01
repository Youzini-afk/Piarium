import type { PiariumExtensionDiagnostic, PiariumExtensionStorageSnapshot } from "./types.js";
export declare const PIARIUM_SERVICE_ROUTING_SCHEMA_VERSION: 1;
export interface PiariumExtensionServiceRoutingContext {
    agentId?: string;
    distributionId?: string;
    invocationId?: string;
    modelId?: string;
    modelProviderId?: string;
    profileId?: string;
    projectId?: string;
    runtimeId?: string;
    sessionId?: string;
    userId?: string;
    workspaceId?: string;
}
export interface PiariumExtensionServiceRoutingRule {
    allowFallback: boolean;
    providerKey: string;
    scope: PiariumExtensionServiceRoutingContext;
    serviceId: string;
    version: number;
}
export interface PiariumExtensionServiceRoutingDocument {
    revision: number;
    rules: PiariumExtensionServiceRoutingRule[];
    schemaVersion: typeof PIARIUM_SERVICE_ROUTING_SCHEMA_VERSION;
    updatedAt: string;
}
export interface PiariumExtensionServiceRoutingSnapshot {
    authoritative: boolean;
    diagnostics: PiariumExtensionDiagnostic[];
    document: PiariumExtensionServiceRoutingDocument;
    hostId: string;
    storageState: "missing" | "ready" | "stale";
}
export interface PiariumExtensionServiceRoutingRuleUpdateRequest {
    expectedRevision: number;
    rule: PiariumExtensionServiceRoutingRule;
}
export interface PiariumExtensionServiceRoutingRuleRemoveRequest {
    expectedRevision: number;
    scope: PiariumExtensionServiceRoutingContext;
    serviceId: string;
    version: number;
}
export interface PiariumExtensionServiceRoutingCandidate {
    providerId: string;
    providerKey: string;
}
export interface PiariumExtensionServiceRoutingResolution {
    diagnostics: PiariumExtensionDiagnostic[];
    matchedRule?: PiariumExtensionServiceRoutingRule;
    providerId?: string;
    providerKey?: string;
    status: "ambiguous" | "resolved" | "unavailable";
}
export declare const parsePiariumExtensionServiceRoutingContext: (value: unknown, options?: {
    allowEmpty?: boolean;
}) => PiariumExtensionServiceRoutingContext;
export declare const parsePiariumExtensionServiceRoutingRule: (value: unknown) => PiariumExtensionServiceRoutingRule;
export declare const serviceRoutingScopeKey: (scopeValue: PiariumExtensionServiceRoutingContext | unknown) => string;
export declare const serviceRoutingRuleKey: (rule: Pick<PiariumExtensionServiceRoutingRule, "scope" | "serviceId" | "version">) => string;
export declare const parsePiariumExtensionServiceRoutingDocument: (value: unknown) => PiariumExtensionServiceRoutingDocument;
export declare const parsePiariumExtensionServiceRoutingSnapshot: (value: unknown) => PiariumExtensionServiceRoutingSnapshot;
export declare const parsePiariumExtensionServiceRoutingRuleUpdateRequest: (value: unknown) => PiariumExtensionServiceRoutingRuleUpdateRequest;
export declare const parsePiariumExtensionServiceRoutingRuleRemoveRequest: (value: unknown) => PiariumExtensionServiceRoutingRuleRemoveRequest;
export declare const defaultPiariumExtensionServiceRoutingDocument: () => PiariumExtensionServiceRoutingDocument;
export declare const serviceRoutingDocumentFromStorage: (snapshot: PiariumExtensionStorageSnapshot) => PiariumExtensionServiceRoutingDocument;
export declare const resolvePiariumExtensionServiceRouting: (options: {
    candidates: readonly PiariumExtensionServiceRoutingCandidate[];
    context?: PiariumExtensionServiceRoutingContext;
    document: PiariumExtensionServiceRoutingDocument | unknown;
    serviceId: string;
    version: number;
}) => PiariumExtensionServiceRoutingResolution;
//# sourceMappingURL=service-routing.d.ts.map