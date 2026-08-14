import type {
  PiariumApplicationSurface,
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
}

export type SurfaceDisposer = () => void | Promise<void>;
export type SurfaceActivation = (context: SurfaceActivationContext) => void | Promise<void>;

export interface SurfaceOwnerHandle {
  readonly owner: SurfaceOwnerIdentity;
  deactivate(nextDesiredRevision: number, nextGeneration: number): Promise<void>;
}

export interface SurfaceExtensionRuntimeOptions {
  surface: PiariumApplicationSurface;
}
