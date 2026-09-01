import { type JsonObject, type PiariumExtensionStorageAddress, type PiariumExtensionStorageSnapshot } from "@piarium/extension-contract";
declare const transactionState: unique symbol;
declare const transactionSetCommitted: unique symbol;
interface ExtensionStorageTransactionState {
    address: PiariumExtensionStorageAddress;
    committed: PiariumExtensionStorageSnapshot | null;
    data: JsonObject;
    previous: PiariumExtensionStorageSnapshot;
    schemaVersion: number;
    store: ExtensionStorageStore;
}
export interface ExtensionStorageMigrationInput {
    data: JsonObject;
    fromSchemaVersion: number;
    toSchemaVersion: number;
}
export type ExtensionStorageMigrator = (input: ExtensionStorageMigrationInput) => JsonObject | Promise<JsonObject>;
export declare class ExtensionStorageMigrationTransaction {
    #private;
    readonly address: PiariumExtensionStorageAddress;
    readonly previous: PiariumExtensionStorageSnapshot;
    readonly targetSchemaVersion: number;
    constructor(options: {
        address: PiariumExtensionStorageAddress;
        previous: PiariumExtensionStorageSnapshot;
        store: ExtensionStorageStore;
        targetData: JsonObject;
        targetSchemaVersion: number;
    });
    get targetData(): JsonObject;
    stageData(data: JsonObject): void;
    commit(): Promise<PiariumExtensionStorageSnapshot>;
    rollbackCommitted(): Promise<void>;
    [transactionState](): ExtensionStorageTransactionState;
    [transactionSetCommitted](snapshot: PiariumExtensionStorageSnapshot | null): void;
}
export declare class ExtensionStorageStore {
    #private;
    readonly dataDir: string;
    readonly directory: string;
    constructor(dataDir: string);
    read(addressValue: PiariumExtensionStorageAddress | unknown): Promise<PiariumExtensionStorageSnapshot>;
    update(addressValue: PiariumExtensionStorageAddress | unknown, expectedRevision: number, schemaVersion: number, dataValue: JsonObject): Promise<PiariumExtensionStorageSnapshot>;
    deleteExtensionData(extensionId: string): Promise<void>;
    commitPrepared(transactions: readonly ExtensionStorageMigrationTransaction[]): Promise<PiariumExtensionStorageSnapshot[]>;
    rollbackPrepared(transactions: readonly ExtensionStorageMigrationTransaction[]): Promise<void>;
    restore(addressValue: PiariumExtensionStorageAddress | unknown, expectedRevision: number, previousValue: PiariumExtensionStorageSnapshot | unknown): Promise<PiariumExtensionStorageSnapshot>;
    prepareMigration(addressValue: PiariumExtensionStorageAddress | unknown, targetSchemaVersion: number, migrate: ExtensionStorageMigrator): Promise<ExtensionStorageMigrationTransaction | null>;
    prepareWrite(addressValue: PiariumExtensionStorageAddress | unknown, schemaVersion: number, dataValue: JsonObject): Promise<ExtensionStorageMigrationTransaction>;
}
export {};
//# sourceMappingURL=storage-store.d.ts.map