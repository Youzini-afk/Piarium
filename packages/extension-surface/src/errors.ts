export class SurfaceActivationStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SurfaceActivationStaleError";
  }
}

export class SurfaceRegistryConflictError extends Error {
  readonly conflicts: string[];

  constructor(message: string, conflicts: string[]) {
    super(message);
    this.name = "SurfaceRegistryConflictError";
    this.conflicts = conflicts;
  }
}
