import { spawn } from "node:child_process";
import { access, cp, mkdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { x as extractTar } from "tar";
const pathValue = (environment) => (environment.PATH ?? environment.Path ?? environment.path ?? "");
const existingPath = async (candidate) => {
    if (!candidate)
        return null;
    try {
        await access(candidate);
        return await realpath(candidate);
    }
    catch {
        return null;
    }
};
/**
 * Resolve the real Node + npm CLI pair instead of assuming the current executable is Node.
 * Piarium's host is also exercised under Bun and embedded by Electron, where process.execPath
 * points at bun.exe or electron.exe and has no adjacent npm installation.
 */
export const resolveNpmLaunchTarget = async (options = {}) => {
    const environment = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const execPath = options.execPath ?? process.execPath;
    const pathDirectories = pathValue(environment)
        .split(platform === "win32" ? ";" : ":")
        .map((entry) => entry.trim().replace(/^"|"$/g, ""))
        .filter(Boolean);
    const nodeName = platform === "win32" ? "node.exe" : "node";
    const nodeCandidates = [
        environment.PIARIUM_NODE_PATH,
        basename(execPath).toLowerCase() === nodeName ? execPath : undefined,
        ...pathDirectories.map((directory) => join(directory, nodeName)),
    ].filter((candidate) => Boolean(candidate));
    let nodePath = null;
    for (const candidate of nodeCandidates) {
        nodePath = await existingPath(candidate);
        if (nodePath)
            break;
    }
    const npmCliCandidates = new Set();
    if (environment.npm_execpath && basename(environment.npm_execpath).toLowerCase() === "npm-cli.js") {
        npmCliCandidates.add(environment.npm_execpath);
    }
    for (const nodeCandidate of nodeCandidates) {
        const directory = dirname(nodeCandidate);
        npmCliCandidates.add(join(directory, "node_modules", "npm", "bin", "npm-cli.js"));
        npmCliCandidates.add(resolve(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
    }
    for (const directory of pathDirectories) {
        npmCliCandidates.add(join(directory, "node_modules", "npm", "bin", "npm-cli.js"));
        npmCliCandidates.add(resolve(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
    }
    let npmCli = null;
    for (const candidate of npmCliCandidates) {
        npmCli = await existingPath(candidate);
        if (npmCli)
            break;
    }
    if (nodePath && npmCli)
        return { argsPrefix: [npmCli], executable: nodePath };
    if (platform !== "win32")
        return { argsPrefix: [], executable: "npm" };
    throw new Error("npm could not be resolved. Install Node.js with npm or set PIARIUM_NODE_PATH to its node.exe executable.");
};
export const runExtensionSourceCommand = (executable, args, options) => new Promise((resolveCommand, reject) => {
    const child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: process.env,
        shell: false,
        signal: options.signal,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
        if (code === 0)
            resolveCommand({ stderr, stdout });
        else
            reject(new Error(`${executable} exited with ${code ?? signal ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
});
export class PiariumExtensionPackageSourceRegistry {
    #resolvers = new Map();
    register(resolver) {
        if (this.#resolvers.has(resolver.kind)) {
            throw new Error(`Piarium extension package source resolver already registered: ${resolver.kind}`);
        }
        this.#resolvers.set(resolver.kind, resolver);
        return () => {
            if (this.#resolvers.get(resolver.kind) === resolver)
                this.#resolvers.delete(resolver.kind);
        };
    }
    materialize(source, destination, signal) {
        const resolver = this.#resolvers.get(source.kind);
        if (!resolver)
            throw new Error(`Piarium extension package source is not supported by this host: ${source.kind}`);
        return resolver.materialize(source, destination, signal);
    }
    supportedKinds() {
        return [...this.#resolvers.keys()].sort();
    }
}
export class LocalExtensionPackageSourceResolver {
    kind = "local";
    async materialize(source, destination, signal) {
        // Local development intentionally resolves the author's real worktree in place.
        void destination;
        signal?.throwIfAborted();
        const sourcePath = await realpath(resolve(source.specifier));
        signal?.throwIfAborted();
        return sourcePath;
    }
}
export class NpmExtensionPackageSourceResolver {
    kind = "npm";
    #run;
    constructor(options = {}) {
        this.#run = options.run ?? runExtensionSourceCommand;
    }
    async materialize(source, destination, signal) {
        const staging = join(dirname(destination), ".npm-pack");
        await mkdir(staging, { recursive: true });
        const npm = await resolveNpmLaunchTarget();
        const result = await this.#run(npm.executable, [...npm.argsPrefix,
            "pack",
            source.specifier,
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            staging,
        ], { cwd: staging, ...(signal ? { signal } : {}) });
        const parsed = JSON.parse(result.stdout);
        const filename = Array.isArray(parsed) && typeof parsed[0]?.filename === "string" ? parsed[0].filename : "";
        if (!filename)
            throw new Error("npm pack did not return an archive filename");
        await mkdir(destination, { recursive: true });
        await extractTar({
            cwd: destination,
            file: join(staging, filename),
            filter: (path, entry) => {
                const entryType = "type" in entry ? entry.type : undefined;
                if (entryType === "SymbolicLink" || entryType === "Link") {
                    throw new Error(`npm Piarium extension package contains a link entry: ${path}`);
                }
                return true;
            },
            preservePaths: false,
            strict: true,
            strip: 1,
        });
        await rm(staging, { force: true, recursive: true });
        return destination;
    }
}
const splitGitSpecifier = (specifier) => {
    const hash = specifier.lastIndexOf("#");
    if (hash <= specifier.indexOf("://") + 2)
        return { url: specifier };
    const ref = specifier.slice(hash + 1).trim();
    return ref ? { ref, url: specifier.slice(0, hash) } : { url: specifier.slice(0, hash) };
};
export class GitExtensionPackageSourceResolver {
    kind = "git";
    #run;
    constructor(options = {}) {
        this.#run = options.run ?? runExtensionSourceCommand;
    }
    async materialize(source, destination, signal) {
        const { ref, url } = splitGitSpecifier(source.specifier);
        await mkdir(dirname(destination), { recursive: true });
        const args = ["clone", "--depth", "1", "--single-branch"];
        if (ref)
            args.push("--branch", ref);
        args.push("--", url, destination);
        await this.#run("git", args, { cwd: dirname(destination), ...(signal ? { signal } : {}) });
        await rm(join(destination, ".git"), { force: true, recursive: true });
        return destination;
    }
}
export class BuiltinExtensionPackageSourceResolver {
    kind = "builtin";
    #roots;
    constructor(roots) {
        this.#roots = roots instanceof Map ? roots : new Map(Object.entries(roots));
    }
    async materialize(source, destination) {
        const configured = this.#roots.get(source.specifier);
        if (!configured)
            throw new Error(`Unknown built-in Piarium extension package: ${source.specifier}`);
        const sourcePath = await realpath(configured);
        await cp(sourcePath, destination, { dereference: false, recursive: true, verbatimSymlinks: true });
        return destination;
    }
}
export const createDefaultExtensionPackageSourceRegistry = (options = {}) => {
    const registry = new PiariumExtensionPackageSourceRegistry();
    registry.register(new LocalExtensionPackageSourceResolver());
    registry.register(new NpmExtensionPackageSourceResolver(options.run ? { run: options.run } : {}));
    registry.register(new GitExtensionPackageSourceResolver(options.run ? { run: options.run } : {}));
    if (options.builtinRoots)
        registry.register(new BuiltinExtensionPackageSourceResolver(options.builtinRoots));
    return registry;
};
//# sourceMappingURL=package-sources.js.map