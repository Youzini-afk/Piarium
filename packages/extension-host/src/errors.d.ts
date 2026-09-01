export declare class ExtensionCatalogStorageError extends Error {
    readonly code: "catalog_invalid" | "catalog_read_failed" | "identity_invalid" | "identity_read_failed";
    readonly retryable: boolean;
    constructor(code: ExtensionCatalogStorageError["code"], message: string, options?: ErrorOptions);
}
export declare class ExtensionCatalogRevisionConflictError extends Error {
    readonly actualRevision: number;
    readonly expectedRevision: number;
    constructor(expectedRevision: number, actualRevision: number);
}
export declare class ExtensionCatalogStaleStateError extends Error {
    constructor(message: string);
}
export declare class ExtensionStorageError extends Error {
    readonly code: "storage_invalid" | "storage_read_failed" | "storage_write_failed";
    readonly retryable: boolean;
    constructor(code: ExtensionStorageError["code"], message: string, options?: ErrorOptions);
}
export declare class ExtensionStorageRevisionConflictError extends Error {
    readonly actualRevision: number;
    readonly expectedRevision: number;
    constructor(expectedRevision: number, actualRevision: number);
}
//# sourceMappingURL=errors.d.ts.map