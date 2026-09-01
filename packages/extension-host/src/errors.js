export class ExtensionCatalogStorageError extends Error {
    code;
    retryable;
    constructor(code, message, options) {
        super(message, options);
        this.name = "ExtensionCatalogStorageError";
        this.code = code;
        this.retryable = code.endsWith("read_failed");
    }
}
export class ExtensionCatalogRevisionConflictError extends Error {
    actualRevision;
    expectedRevision;
    constructor(expectedRevision, actualRevision) {
        super(`Piarium extension catalog changed: expected revision ${expectedRevision}, actual revision ${actualRevision}`);
        this.name = "ExtensionCatalogRevisionConflictError";
        this.actualRevision = actualRevision;
        this.expectedRevision = expectedRevision;
    }
}
export class ExtensionCatalogStaleStateError extends Error {
    constructor(message) {
        super(message);
        this.name = "ExtensionCatalogStaleStateError";
    }
}
export class ExtensionStorageError extends Error {
    code;
    retryable;
    constructor(code, message, options) {
        super(message, options);
        this.name = "ExtensionStorageError";
        this.code = code;
        this.retryable = code === "storage_read_failed" || code === "storage_write_failed";
    }
}
export class ExtensionStorageRevisionConflictError extends Error {
    actualRevision;
    expectedRevision;
    constructor(expectedRevision, actualRevision) {
        super(`Piarium extension storage changed: expected revision ${expectedRevision}, actual revision ${actualRevision}`);
        this.name = "ExtensionStorageRevisionConflictError";
        this.actualRevision = actualRevision;
        this.expectedRevision = expectedRevision;
    }
}
//# sourceMappingURL=errors.js.map