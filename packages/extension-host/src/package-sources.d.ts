import type { PiariumExtensionPackageSource, PiariumExtensionPackageSourceKind } from "@piarium/extension-contract";
export interface PiariumExtensionPackageSourceResolver {
    readonly kind: PiariumExtensionPackageSourceKind;
    materialize(source: PiariumExtensionPackageSource, destination: string, signal?: AbortSignal): Promise<string>;
}
export interface ExtensionSourceCommandResult {
    stderr: string;
    stdout: string;
}
export type ExtensionSourceCommandRunner = (executable: string, args: readonly string[], options: {
    cwd: string;
    signal?: AbortSignal;
}) => Promise<ExtensionSourceCommandResult>;
export interface NpmLaunchTarget {
    argsPrefix: string[];
    executable: string;
}
/**
 * Resolve the real Node + npm CLI pair instead of assuming the current executable is Node.
 * Piarium's host is also exercised under Bun and embedded by Electron, where process.execPath
 * points at bun.exe or electron.exe and has no adjacent npm installation.
 */
export declare const resolveNpmLaunchTarget: (options?: {
    env?: NodeJS.ProcessEnv;
    execPath?: string;
    platform?: NodeJS.Platform;
}) => Promise<NpmLaunchTarget>;
export declare const runExtensionSourceCommand: ExtensionSourceCommandRunner;
export declare class PiariumExtensionPackageSourceRegistry {
    #private;
    register(resolver: PiariumExtensionPackageSourceResolver): () => void;
    materialize(source: PiariumExtensionPackageSource, destination: string, signal?: AbortSignal): Promise<string>;
    supportedKinds(): PiariumExtensionPackageSourceKind[];
}
export declare class LocalExtensionPackageSourceResolver implements PiariumExtensionPackageSourceResolver {
    readonly kind: "local";
    materialize(source: PiariumExtensionPackageSource, destination: string, signal?: AbortSignal): Promise<string>;
}
export declare class NpmExtensionPackageSourceResolver implements PiariumExtensionPackageSourceResolver {
    #private;
    readonly kind: "npm";
    constructor(options?: {
        run?: ExtensionSourceCommandRunner;
    });
    materialize(source: PiariumExtensionPackageSource, destination: string, signal?: AbortSignal): Promise<string>;
}
export declare class GitExtensionPackageSourceResolver implements PiariumExtensionPackageSourceResolver {
    #private;
    readonly kind: "git";
    constructor(options?: {
        run?: ExtensionSourceCommandRunner;
    });
    materialize(source: PiariumExtensionPackageSource, destination: string, signal?: AbortSignal): Promise<string>;
}
export declare class BuiltinExtensionPackageSourceResolver implements PiariumExtensionPackageSourceResolver {
    #private;
    readonly kind: "builtin";
    constructor(roots: ReadonlyMap<string, string> | Record<string, string>);
    materialize(source: PiariumExtensionPackageSource, destination: string): Promise<string>;
}
export declare const createDefaultExtensionPackageSourceRegistry: (options?: {
    builtinRoots?: ReadonlyMap<string, string> | Record<string, string>;
    run?: ExtensionSourceCommandRunner;
}) => PiariumExtensionPackageSourceRegistry;
//# sourceMappingURL=package-sources.d.ts.map