import { type PiariumWorkbenchLayoutUpdateRequest, type PiariumWorkbenchProfileDocument, type PiariumWorkbenchProfileRemoveRequest, type PiariumWorkbenchProfileSelectionRequest, type PiariumWorkbenchProfileSnapshot, type PiariumWorkbenchProfileUpsertRequest } from "@piarium/extension-contract";
import { ExtensionStorageStore } from "./storage-store.js";
export type WorkspaceScopeResolver = (scopeId: string) => Promise<string | null>;
export declare class WorkbenchProfileStore {
    #private;
    readonly hostId: string;
    readonly storage: ExtensionStorageStore;
    constructor(options: {
        hostId: string;
        storage: ExtensionStorageStore;
    });
    setWorkspaceScopeResolver(resolver: WorkspaceScopeResolver | null): void;
    read(): Promise<PiariumWorkbenchProfileSnapshot>;
    updateLayout(requestValue: PiariumWorkbenchLayoutUpdateRequest | unknown): Promise<PiariumWorkbenchProfileSnapshot>;
    selectProfile(requestValue: PiariumWorkbenchProfileSelectionRequest | unknown): Promise<PiariumWorkbenchProfileSnapshot>;
    upsertProfile(requestValue: PiariumWorkbenchProfileUpsertRequest | unknown): Promise<PiariumWorkbenchProfileSnapshot>;
    removeProfile(requestValue: PiariumWorkbenchProfileRemoveRequest | unknown): Promise<PiariumWorkbenchProfileSnapshot>;
}
export declare const emptyWorkbenchProfileDocument: () => PiariumWorkbenchProfileDocument;
//# sourceMappingURL=workbench-profile-store.d.ts.map