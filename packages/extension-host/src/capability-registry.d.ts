import { type JsonValue, type PiariumExtensionCapabilityGrant } from "@piarium/extension-contract";
import type { HostServiceOwnerIdentity } from "./service-registry.js";
export interface HostCapabilityCallContext {
    owner: HostServiceOwnerIdentity;
    signal: AbortSignal;
}
export type HostCapabilityHandler = (method: string, params: JsonValue, context: HostCapabilityCallContext) => JsonValue | Promise<JsonValue>;
export declare class HostCapabilityRegistry {
    #private;
    register(capability: string, handler: HostCapabilityHandler): () => void;
    invoke(owner: HostServiceOwnerIdentity, grants: readonly PiariumExtensionCapabilityGrant[], capability: string, method: string, params: JsonValue, signal: AbortSignal): Promise<JsonValue>;
}
//# sourceMappingURL=capability-registry.d.ts.map