import type {
  PiariumApplicationSurface,
  PiariumContextValue,
  PiariumExtensionActualState,
  PiariumExtensionServiceProvision,
  PiariumExtensionServiceRequirement,
  PiariumExtensionStaticContribution,
} from "@piarium/extension-contract";

export interface SurfaceOwnerIdentity {
  desiredRevision: number;
  entrypointId: string;
  extensionId: string;
  extensionVersion: string;
  generation: number;
  hostId: string;
  realmId: string;
}

export interface SurfaceContribution<TImplementation = unknown> {
  descriptor: PiariumExtensionStaticContribution;
  implementation: TImplementation;
  owner: SurfaceOwnerIdentity;
}

export interface SurfaceService<TImplementation = unknown> {
  descriptor: PiariumExtensionServiceProvision;
  implementation: TImplementation;
  owner: SurfaceOwnerIdentity;
}

export interface SurfaceExternalService<TImplementation = unknown> {
  descriptor: PiariumExtensionServiceProvision;
  /** Cleanup owned by the consumer activation scope, for Surface-local service instances. */
  dispose?: SurfaceDisposer;
  implementation: TImplementation;
  providerId: string;
}

export interface SurfaceActualState extends PiariumExtensionActualState {
  extensionId: string;
  extensionVersion: string;
}

export interface SurfaceLayoutReference {
  contributionId: string;
  order?: number;
  region?: string;
  size?: number;
  visible?: boolean;
}

export interface SurfaceRegistrySnapshot {
  actual: SurfaceActualState[];
  contributions: readonly SurfaceContribution[];
  layoutReferences: readonly SurfaceLayoutReference[];
  replacementSelections: Readonly<Record<string, string>>;
  revision: number;
  serviceSelections: Readonly<Record<string, string>>;
  services: readonly SurfaceService[];
  visibleContributions: readonly SurfaceContribution[];
}

export interface SurfaceActivationOptions {
  externalServices?: readonly SurfaceExternalService[];
  grantedCapabilities?: Iterable<string>;
  owner: SurfaceOwnerIdentity;
  requirements?: PiariumExtensionServiceRequirement[];
}

export interface SurfaceActivationContext {
  contribute<TImplementation>(
    descriptor: PiariumExtensionStaticContribution,
    implementation: TImplementation,
  ): void;
  onDispose(disposer: SurfaceDisposer): void;
  provide<TImplementation>(
    descriptor: PiariumExtensionServiceProvision,
    implementation: TImplementation,
  ): void;
  readonly signal: AbortSignal;
  useService<TImplementation = unknown>(id: string, version: number): TImplementation | undefined;
  useServices<TImplementation = unknown>(id: string, version: number): TImplementation[];
  /**
   * Owner-scoped context key writer. Keys written through this writer are
   * namespaced by owner identity and fenced by generation — writes from a
   * stale generation are silently rejected. All keys are cleaned up when
   * the owner scope is disposed.
   */
  readonly context: SurfaceContextWriter;
}

export type SurfaceDisposer = () => void | Promise<void>;
export type SurfaceActivation = (context: SurfaceActivationContext) => void | Promise<void>;

export interface SurfaceOwnerHandle {
  readonly owner: SurfaceOwnerIdentity;
  deactivate(nextDesiredRevision: number, nextGeneration: number): Promise<void>;
}

export interface SurfaceExtensionRuntimeOptions {
  surface: PiariumApplicationSurface;
  /**
   * Optional provider for evaluating `when` context expressions on
   * contributions. When provided, contributions whose `when` expression
   * evaluates to false are excluded from visibleContributions (but remain
   * in the registry). When not provided, `when` expressions are ignored
   * (all compatible contributions are visible).
   */
  contextProvider?: SurfaceContextProvider;
}

/**
 * Provides context key values for evaluating contribution `when` expressions.
 * The Surface runtime calls this during visibility projection. Also
 * creates owner-scoped writers that namespace keys and fence by generation.
 */
export interface SurfaceContextProvider {
  getContext(): ReadonlyMap<string, PiariumContextValue>;
  subscribe(keys: readonly string[], listener: () => void): () => void;
  /**
   * Create an owner-scoped context writer. Keys written through the
   * returned writer are namespaced by owner identity and fenced by
   * generation. The writer is invalidated when the returned disposer
   * is called (which happens during owner scope disposal).
   */
  createWriter(owner: SurfaceOwnerIdentity): { writer: SurfaceContextWriter; dispose: () => void };
}

/**
 * Owner-scoped writer for context key values. Each owner's keys are
 * namespaced (the provider implementation decides the prefix scheme) and
 * fenced by generation — writes from a stale generation are rejected.
 * The writer is single-use: once the owner scope is disposed, further
 * writes throw.
 */
export interface SurfaceContextWriter {
  /**
   * Set a context key value. The key is namespaced by owner identity.
   * Returns true if the write was accepted, false if the writer's
   * generation is stale.
   */
  set(key: string, value: PiariumContextValue): boolean;
  /**
   * Delete a context key value. Returns true if the key was removed.
   */
  delete(key: string): boolean;
}
