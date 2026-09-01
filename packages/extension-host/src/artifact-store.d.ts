import type { BuildOptions, Metafile } from "esbuild";
import { type PiariumExtensionAssetPayload, type PiariumExtensionPreparedArtifact, type PiariumExtensionManagedEntrypointPayload, type PiariumExtensionManifest, type PiariumExtensionPackageSource } from "@piarium/extension-contract";
import { type ExtensionSourceCommandRunner, type PiariumExtensionPackageSourceRegistry } from "./package-sources.js";
export interface BrokeredHostEntrypointArtifact {
    artifactIntegrity: string;
    integrity: string;
    modulePath: string;
    packageRoot: string;
}
export interface ExtensionArtifactStoreOptions {
    builtinRoots?: ReadonlyMap<string, string> | Record<string, string>;
    buildModule?: ExtensionModuleBuilder;
    dataDir: string;
    packageSources?: PiariumExtensionPackageSourceRegistry;
    piariumVersion: string;
    run?: ExtensionSourceCommandRunner;
}
export type ExtensionModuleBuilder = (options: BuildOptions) => Promise<{
    metafile: Metafile | undefined;
}>;
export declare class ExtensionArtifactStore {
    #private;
    readonly dataDir: string;
    readonly directory: string;
    readonly piariumVersion: string;
    constructor(options: ExtensionArtifactStoreOptions);
    builtinDistributionFingerprint(extensionId: string, fingerprintFile: string): Promise<string | null>;
    builtinArtifactMatchesDistribution(input: {
        artifactIntegrity: string;
        artifactRoot: string;
        distributionFingerprint: string;
        fingerprintFile: string;
        manifest: PiariumExtensionManifest;
    }): Promise<boolean>;
    prepare(source: PiariumExtensionPackageSource, signal?: AbortSignal): Promise<PiariumExtensionPreparedArtifact>;
    readAsset(artifactRoot: string, artifactIntegrity: string, logicalPath: string, expectedManifest?: PiariumExtensionManifest): Promise<PiariumExtensionAssetPayload>;
    readManagedEntrypoint(artifactRoot: string, artifactIntegrity: string, entrypointId: string, expectedManifest?: PiariumExtensionManifest): Promise<PiariumExtensionManagedEntrypointPayload>;
    resolveBrokeredHostEntrypoint(artifactRoot: string, artifactIntegrity: string, expectedManifest?: PiariumExtensionManifest): Promise<BrokeredHostEntrypointArtifact>;
}
//# sourceMappingURL=artifact-store.d.ts.map