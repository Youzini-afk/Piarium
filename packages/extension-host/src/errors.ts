export class ExtensionCatalogStorageError extends Error {
  readonly code: "catalog_invalid" | "catalog_read_failed" | "identity_invalid" | "identity_read_failed";
  readonly retryable: boolean;

  constructor(
    code: ExtensionCatalogStorageError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExtensionCatalogStorageError";
    this.code = code;
    this.retryable = code.endsWith("read_failed");
  }
}

export class ExtensionCatalogRevisionConflictError extends Error {
  readonly actualRevision: number;
  readonly expectedRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(`Piarium extension catalog changed: expected revision ${expectedRevision}, actual revision ${actualRevision}`);
    this.name = "ExtensionCatalogRevisionConflictError";
    this.actualRevision = actualRevision;
    this.expectedRevision = expectedRevision;
  }
}

export class ExtensionCatalogStaleStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionCatalogStaleStateError";
  }
}
