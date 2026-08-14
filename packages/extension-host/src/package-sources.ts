import type {
  PiariumExtensionPackageCandidate,
  PiariumExtensionPackageSource,
  PiariumExtensionPackageSourceKind,
} from "@piarium/extension-contract";

export interface PiariumExtensionPackageSourceResolver {
  readonly kind: PiariumExtensionPackageSourceKind;
  inspect(source: PiariumExtensionPackageSource, signal?: AbortSignal): Promise<PiariumExtensionPackageCandidate>;
}

export class PiariumExtensionPackageSourceRegistry {
  readonly #resolvers = new Map<PiariumExtensionPackageSourceKind, PiariumExtensionPackageSourceResolver>();

  register(resolver: PiariumExtensionPackageSourceResolver): () => void {
    if (this.#resolvers.has(resolver.kind)) {
      throw new Error(`Piarium extension package source resolver already registered: ${resolver.kind}`);
    }
    this.#resolvers.set(resolver.kind, resolver);
    return () => {
      if (this.#resolvers.get(resolver.kind) === resolver) this.#resolvers.delete(resolver.kind);
    };
  }

  inspect(source: PiariumExtensionPackageSource, signal?: AbortSignal): Promise<PiariumExtensionPackageCandidate> {
    const resolver = this.#resolvers.get(source.kind);
    if (!resolver) throw new Error(`Piarium extension package source is not supported by this host: ${source.kind}`);
    return resolver.inspect(source, signal);
  }

  supportedKinds(): PiariumExtensionPackageSourceKind[] {
    return [...this.#resolvers.keys()].sort();
  }
}
