import { type PiariumExtensionServiceRoutingDocument, type PiariumExtensionServiceRoutingRuleRemoveRequest, type PiariumExtensionServiceRoutingRuleUpdateRequest, type PiariumExtensionServiceRoutingSnapshot } from "@piarium/extension-contract";
import { ExtensionStorageStore } from "./storage-store.js";
export declare class ServiceRoutingStore {
    #private;
    readonly hostId: string;
    readonly storage: ExtensionStorageStore;
    constructor(options: {
        hostId: string;
        storage: ExtensionStorageStore;
    });
    read(): Promise<PiariumExtensionServiceRoutingSnapshot>;
    upsertRule(requestValue: PiariumExtensionServiceRoutingRuleUpdateRequest | unknown): Promise<PiariumExtensionServiceRoutingSnapshot>;
    removeRule(requestValue: PiariumExtensionServiceRoutingRuleRemoveRequest | unknown): Promise<PiariumExtensionServiceRoutingSnapshot>;
}
export declare const emptyServiceRoutingDocument: () => PiariumExtensionServiceRoutingDocument;
//# sourceMappingURL=service-routing-store.d.ts.map