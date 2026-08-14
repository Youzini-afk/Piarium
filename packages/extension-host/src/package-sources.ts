import { spawn } from "node:child_process";
import { access, cp, mkdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { x as extractTar } from "tar";
import type {
  PiariumExtensionPackageSource,
  PiariumExtensionPackageSourceKind,
} from "@piarium/extension-contract";

export interface PiariumExtensionPackageSourceResolver {
  readonly kind: PiariumExtensionPackageSourceKind;
  materialize(source: PiariumExtensionPackageSource, destination: string, signal?: AbortSignal): Promise<string>;
}

export interface ExtensionSourceCommandResult {
  stderr: string;
  stdout: string;
}

export type ExtensionSourceCommandRunner = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; signal?: AbortSignal },
) => Promise<ExtensionSourceCommandResult>;

export interface NpmLaunchTarget {
  argsPrefix: string[];
  executable: string;
}

const pathValue = (environment: NodeJS.ProcessEnv): string => (
  environment.PATH ?? environment.Path ?? environment.path ?? ""
);

const existingPath = async (candidate: string): Promise<string | null> => {
  if (!candidate) return null;
  try {
    await access(candidate);
    return await realpath(candidate);
  } catch {
    return null;
  }
};

/**
 * Resolve the real Node + npm CLI pair instead of assuming the current executable is Node.
 * Piarium's host is also exercised under Bun and embedded by Electron, where process.execPath
 * points at bun.exe or electron.exe and has no adjacent npm installation.
 */
export const resolveNpmLaunchTarget = async (options: {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  platform?: NodeJS.Platform;
} = {}): Promise<NpmLaunchTarget> => {
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
  ].filter((candidate): candidate is string => Boolean(candidate));
  let nodePath: string | null = null;
  for (const candidate of nodeCandidates) {
    nodePath = await existingPath(candidate);
    if (nodePath) break;
  }

  const npmCliCandidates = new Set<string>();
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
  let npmCli: string | null = null;
  for (const candidate of npmCliCandidates) {
    npmCli = await existingPath(candidate);
    if (npmCli) break;
  }
  if (nodePath && npmCli) return { argsPrefix: [npmCli], executable: nodePath };
  if (platform !== "win32") return { argsPrefix: [], executable: "npm" };
  throw new Error("npm could not be resolved. Install Node.js with npm or set PIARIUM_NODE_PATH to its node.exe executable.");
};

export const runExtensionSourceCommand: ExtensionSourceCommandRunner = (executable, args, options) => new Promise((resolveCommand, reject) => {
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
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (code, signal) => {
    if (code === 0) resolveCommand({ stderr, stdout });
    else reject(new Error(`${executable} exited with ${code ?? signal ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
  });
});

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

  materialize(source: PiariumExtensionPackageSource, destination: string, signal?: AbortSignal): Promise<string> {
    const resolver = this.#resolvers.get(source.kind);
    if (!resolver) throw new Error(`Piarium extension package source is not supported by this host: ${source.kind}`);
    return resolver.materialize(source, destination, signal);
  }

  supportedKinds(): PiariumExtensionPackageSourceKind[] {
    return [...this.#resolvers.keys()].sort();
  }
}

export class LocalExtensionPackageSourceResolver implements PiariumExtensionPackageSourceResolver {
  readonly kind = "local" as const;

  async materialize(
    source: PiariumExtensionPackageSource,
    destination: string,
    signal?: AbortSignal,
  ): Promise<string> {
    // Local development intentionally resolves the author's real worktree in place.
    void destination;
    signal?.throwIfAborted();
    const sourcePath = await realpath(resolve(source.specifier));
    signal?.throwIfAborted();
    return sourcePath;
  }
}

interface NpmPackResult {
  filename?: unknown;
}

export class NpmExtensionPackageSourceResolver implements PiariumExtensionPackageSourceResolver {
  readonly kind = "npm" as const;
  readonly #run: ExtensionSourceCommandRunner;

  constructor(options: { run?: ExtensionSourceCommandRunner } = {}) {
    this.#run = options.run ?? runExtensionSourceCommand;
  }

  async materialize(source: PiariumExtensionPackageSource, destination: string, signal?: AbortSignal): Promise<string> {
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
    const parsed = JSON.parse(result.stdout) as NpmPackResult[];
    const filename = Array.isArray(parsed) && typeof parsed[0]?.filename === "string" ? parsed[0].filename : "";
    if (!filename) throw new Error("npm pack did not return an archive filename");
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

const splitGitSpecifier = (specifier: string): { ref?: string; url: string } => {
  const hash = specifier.lastIndexOf("#");
  if (hash <= specifier.indexOf("://") + 2) return { url: specifier };
  const ref = specifier.slice(hash + 1).trim();
  return ref ? { ref, url: specifier.slice(0, hash) } : { url: specifier.slice(0, hash) };
};

export class GitExtensionPackageSourceResolver implements PiariumExtensionPackageSourceResolver {
  readonly kind = "git" as const;
  readonly #run: ExtensionSourceCommandRunner;

  constructor(options: { run?: ExtensionSourceCommandRunner } = {}) {
    this.#run = options.run ?? runExtensionSourceCommand;
  }

  async materialize(source: PiariumExtensionPackageSource, destination: string, signal?: AbortSignal): Promise<string> {
    const { ref, url } = splitGitSpecifier(source.specifier);
    await mkdir(dirname(destination), { recursive: true });
    const args = ["clone", "--depth", "1", "--single-branch"];
    if (ref) args.push("--branch", ref);
    args.push("--", url, destination);
    await this.#run("git", args, { cwd: dirname(destination), ...(signal ? { signal } : {}) });
    await rm(join(destination, ".git"), { force: true, recursive: true });
    return destination;
  }
}

export class BuiltinExtensionPackageSourceResolver implements PiariumExtensionPackageSourceResolver {
  readonly kind = "builtin" as const;
  readonly #roots: ReadonlyMap<string, string>;

  constructor(roots: ReadonlyMap<string, string> | Record<string, string>) {
    this.#roots = roots instanceof Map ? roots : new Map(Object.entries(roots));
  }

  async materialize(source: PiariumExtensionPackageSource, destination: string): Promise<string> {
    const configured = this.#roots.get(source.specifier);
    if (!configured) throw new Error(`Unknown built-in Piarium extension package: ${source.specifier}`);
    const sourcePath = await realpath(configured);
    await cp(sourcePath, destination, { dereference: false, recursive: true, verbatimSymlinks: true });
    return destination;
  }
}

export const createDefaultExtensionPackageSourceRegistry = (
  options: { builtinRoots?: ReadonlyMap<string, string> | Record<string, string>; run?: ExtensionSourceCommandRunner } = {},
): PiariumExtensionPackageSourceRegistry => {
  const registry = new PiariumExtensionPackageSourceRegistry();
  registry.register(new LocalExtensionPackageSourceResolver());
  registry.register(new NpmExtensionPackageSourceResolver(options.run ? { run: options.run } : {}));
  registry.register(new GitExtensionPackageSourceResolver(options.run ? { run: options.run } : {}));
  if (options.builtinRoots) registry.register(new BuiltinExtensionPackageSourceResolver(options.builtinRoots));
  return registry;
};
