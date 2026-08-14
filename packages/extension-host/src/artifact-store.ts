import { createHash } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import type { BuildOptions, Metafile } from "esbuild";
import {
  PIARIUM_EXTENSION_MANIFEST_FILE,
  parsePiariumExtensionManifest,
  type PiariumExtensionAssetPayload,
  type PiariumExtensionPreparedArtifact,
  type PiariumExtensionManagedEntrypointPayload,
  type PiariumExtensionManifest,
  type PiariumExtensionPackageSource,
} from "@piarium/extension-contract";
import {
  createDefaultExtensionPackageSourceRegistry,
  runExtensionSourceCommand,
  type ExtensionSourceCommandRunner,
  type PiariumExtensionPackageSourceRegistry,
} from "./package-sources.js";

const INDEX_FILE = "artifact-index.json";
const MANAGED_RUNTIME_DIRECTORY = "runtime/surface";

interface ArtifactFileRecord {
  contentType: string;
  integrity: string;
}

interface ArtifactEntrypointRecord {
  module: string;
  styles: string[];
}

interface ArtifactIndex {
  artifactIntegrity: string;
  entrypoints: Record<string, ArtifactEntrypointRecord>;
  files: Record<string, ArtifactFileRecord>;
  host?: { module: string };
  schemaVersion: 1;
}

export interface BrokeredHostEntrypointArtifact {
  artifactIntegrity: string;
  integrity: string;
  modulePath: string;
}

export interface ExtensionArtifactStoreOptions {
  buildModule?: ExtensionModuleBuilder;
  dataDir: string;
  packageSources?: PiariumExtensionPackageSourceRegistry;
  run?: ExtensionSourceCommandRunner;
}

export type ExtensionModuleBuilder = (options: BuildOptions) => Promise<{ metafile: Metafile | undefined }>;

const buildModuleWithEsbuild: ExtensionModuleBuilder = async (options) => {
  const { build } = await import("esbuild");
  const result = await build(options);
  return { metafile: result.metafile };
};

const sha256 = (value: Uint8Array | string): string => `sha256-${createHash("sha256").update(value).digest("hex")}`;

const toLogicalPath = (value: string): string => value.split(sep).join("/");

const contentTypeForPath = (path: string): string => {
  switch (extname(path).toLowerCase()) {
    case ".css": return "text/css; charset=utf-8";
    case ".gif": return "image/gif";
    case ".html": return "text/html; charset=utf-8";
    case ".jpeg":
    case ".jpg": return "image/jpeg";
    case ".js":
    case ".cjs":
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".png": return "image/png";
    case ".svg": return "image/svg+xml";
    case ".txt":
    case ".md": return "text/plain; charset=utf-8";
    case ".webp": return "image/webp";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
};

const isMissing = (error: unknown): boolean => (
  typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
);

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
};

const assertSafeTree = async (root: string): Promise<void> => {
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        throw new Error(`Piarium extension packages cannot contain symbolic links: ${toLogicalPath(relative(root, path))}`);
      }
      if (info.isDirectory()) await visit(path);
      else if (!info.isFile()) throw new Error(`Unsupported Piarium extension package entry: ${toLogicalPath(relative(root, path))}`);
    }
  };
  await visit(root);
};

const shouldCopyPackagePath = (sourceRoot: string, path: string): boolean => {
  const logical = toLogicalPath(relative(sourceRoot, path));
  return logical !== ".git"
    && !logical.startsWith(".git/")
    && logical !== "node_modules"
    && !logical.startsWith("node_modules/")
    && logical !== ".piarium-runtime"
    && !logical.startsWith(".piarium-runtime/");
};

const walkFiles = async (root: string): Promise<string[]> => {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(toLogicalPath(relative(root, path)));
      else throw new Error(`Immutable Piarium extension artifact contains an unsupported entry: ${path}`);
    }
  };
  await visit(root);
  return files.sort();
};

const parseIndex = (value: unknown): ArtifactIndex => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Piarium extension artifact index is invalid");
  const record = value as Partial<ArtifactIndex>;
  if (record.schemaVersion !== 1 || typeof record.artifactIntegrity !== "string" || !record.artifactIntegrity.startsWith("sha256-")) {
    throw new Error("Piarium extension artifact index header is invalid");
  }
  if (!record.files || typeof record.files !== "object" || !record.entrypoints || typeof record.entrypoints !== "object") {
    throw new Error("Piarium extension artifact index contents are invalid");
  }
  return record as ArtifactIndex;
};

const readManifest = async (sourceRoot: string): Promise<PiariumExtensionManifest> => {
  const raw = JSON.parse(await readFile(join(sourceRoot, PIARIUM_EXTENSION_MANIFEST_FILE), "utf8")) as unknown;
  return parsePiariumExtensionManifest(raw);
};

const hasDependencies = async (sourceRoot: string): Promise<boolean> => {
  try {
    const value = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8")) as Record<string, unknown>;
    return [value.dependencies, value.devDependencies, value.optionalDependencies]
      .some((item) => item && typeof item === "object" && Object.keys(item as object).length > 0);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
};

export class ExtensionArtifactStore {
  readonly dataDir: string;
  readonly directory: string;
  readonly #build: ExtensionModuleBuilder;
  readonly #packageSources: PiariumExtensionPackageSourceRegistry;
  readonly #run: ExtensionSourceCommandRunner;

  constructor(options: ExtensionArtifactStoreOptions) {
    this.dataDir = resolve(options.dataDir);
    this.directory = join(this.dataDir, "extensions", "artifacts", "sha256");
    this.#build = options.buildModule ?? buildModuleWithEsbuild;
    this.#run = options.run ?? runExtensionSourceCommand;
    this.#packageSources = options.packageSources ?? createDefaultExtensionPackageSourceRegistry({ run: this.#run });
  }

  async prepare(source: PiariumExtensionPackageSource, signal?: AbortSignal): Promise<PiariumExtensionPreparedArtifact> {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "piarium-extension-"));
    const sourceRoot = join(temporaryRoot, "source");
    const artifactRoot = join(temporaryRoot, "artifact");
    try {
      await this.#packageSources.materialize(source, sourceRoot, signal);
      await assertSafeTree(sourceRoot);
      const manifest = await readManifest(sourceRoot);
      if (!(await exists(join(sourceRoot, "node_modules"))) && await hasDependencies(sourceRoot)) {
        const npm = process.platform === "win32" ? process.execPath : "npm";
        const npmArgs = process.platform === "win32"
          ? [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
          : [];
        await this.#run(npm, [...npmArgs, "install", "--ignore-scripts", "--no-audit", "--no-fund"], {
          cwd: sourceRoot,
          ...(signal ? { signal } : {}),
        });
      }

      await mkdir(artifactRoot, { recursive: true });
      await cp(sourceRoot, join(artifactRoot, "package"), {
        dereference: false,
        filter: (path) => shouldCopyPackagePath(sourceRoot, path),
        recursive: true,
        verbatimSymlinks: true,
      });
      const entrypoints: Record<string, ArtifactEntrypointRecord> = {};
      for (const entrypoint of manifest.entrypoints?.surfaces ?? []) {
        if (entrypoint.mode === "declarative") continue;
        if (!entrypoint.file) throw new Error(`Executable Surface entrypoint has no file: ${entrypoint.id}`);
        const outputDirectory = join(artifactRoot, MANAGED_RUNTIME_DIRECTORY, entrypoint.id);
        await mkdir(outputDirectory, { recursive: true });
        const isolated = entrypoint.mode === "isolated";
        const modulePath = join(outputDirectory, isolated ? "module.js" : "module.cjs");
        if (!isolated && entrypoint.file.endsWith(".cjs")) {
          await cp(resolve(sourceRoot, entrypoint.file), modulePath);
          entrypoints[entrypoint.id] = {
            module: toLogicalPath(relative(artifactRoot, modulePath)),
            styles: [],
          };
          continue;
        }
        const options: BuildOptions = {
          absWorkingDir: sourceRoot,
          assetNames: "assets/[name]-[hash]",
          bundle: true,
          entryPoints: [resolve(sourceRoot, entrypoint.file)],
          format: isolated ? "iife" : "cjs",
          ...(isolated ? { globalName: "PiariumIsolatedModule" } : {}),
          loader: {
            ".gif": "file",
            ".jpeg": "file",
            ".jpg": "file",
            ".png": "file",
            ".svg": "file",
            ".webp": "file",
            ".woff": "file",
            ".woff2": "file",
          },
          metafile: true,
          outfile: modulePath,
          platform: "browser",
          sourcemap: "external",
          target: ["es2022"],
        };
        const result = await this.#build(options);
        if (!result.metafile) throw new Error(`Surface entrypoint build returned no metadata: ${entrypoint.id}`);
        const stylePath = join(outputDirectory, "module.css");
        entrypoints[entrypoint.id] = {
          module: toLogicalPath(relative(artifactRoot, modulePath)),
          styles: await exists(stylePath) ? [toLogicalPath(relative(artifactRoot, stylePath))] : [],
        };
      }

      let host: ArtifactIndex["host"];
      const hostEntrypoint = manifest.entrypoints?.host;
      if (hostEntrypoint?.mode === "brokered" || hostEntrypoint?.mode === "native") {
        const outputDirectory = join(artifactRoot, "runtime", "host");
        const modulePath = join(outputDirectory, "module.cjs");
        await mkdir(outputDirectory, { recursive: true });
        if (hostEntrypoint.file.endsWith(".cjs")) {
          await cp(resolve(sourceRoot, hostEntrypoint.file), modulePath);
        } else {
          const result = await this.#build({
            absWorkingDir: sourceRoot,
            bundle: true,
            entryPoints: [resolve(sourceRoot, hostEntrypoint.file)],
            format: "cjs",
            metafile: true,
            outfile: modulePath,
            platform: "node",
            sourcemap: "external",
            target: ["node22"],
          });
          if (!result.metafile) throw new Error("Host entrypoint build returned no metadata");
        }
        host = { module: toLogicalPath(relative(artifactRoot, modulePath)) };
      }

      const files: Record<string, ArtifactFileRecord> = {};
      for (const logicalPath of await walkFiles(artifactRoot)) {
        if (logicalPath === INDEX_FILE) continue;
        const bytes = await readFile(join(artifactRoot, ...logicalPath.split("/")));
        files[logicalPath] = { contentType: contentTypeForPath(logicalPath), integrity: sha256(bytes) };
      }
      const artifactIntegrity = sha256(Object.entries(files)
        .map(([path, file]) => `${path}\0${file.integrity}\0${file.contentType}\n`)
        .join(""));
      const index: ArtifactIndex = { artifactIntegrity, entrypoints, files, ...(host ? { host } : {}), schemaVersion: 1 };
      await writeFile(join(artifactRoot, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

      const finalPath = join(this.directory, artifactIntegrity.slice("sha256-".length));
      await mkdir(dirname(finalPath), { recursive: true });
      try {
        await rename(artifactRoot, finalPath);
      } catch (error) {
        if (!(await exists(finalPath))) throw error;
      }
      return {
        integrity: artifactIntegrity,
        manifest,
        preparedAt: new Date().toISOString(),
        resolvedPath: finalPath,
        resolvedVersion: manifest.version,
        source: structuredClone(source),
      };
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  }

  async readAsset(
    artifactRoot: string,
    artifactIntegrity: string,
    logicalPath: string,
  ): Promise<PiariumExtensionAssetPayload> {
    const root = await this.#assertArtifactRoot(artifactRoot, artifactIntegrity);
    const index = parseIndex(JSON.parse(await readFile(join(root, INDEX_FILE), "utf8")) as unknown);
    if (index.artifactIntegrity !== artifactIntegrity) throw new Error("Piarium extension artifact integrity no longer matches the catalog");
    const record = index.files[logicalPath];
    if (!record) throw new Error(`Piarium extension artifact does not contain asset: ${logicalPath}`);
    const path = resolve(root, ...logicalPath.split("/"));
    const relativePath = relative(root, path);
    if (!relativePath || relativePath.startsWith("..") || resolve(root, relativePath) !== path) {
      throw new Error("Piarium extension asset path escapes its immutable artifact");
    }
    const bytes = await readFile(path);
    const fileIntegrity = sha256(bytes);
    if (fileIntegrity !== record.integrity) throw new Error(`Piarium extension asset integrity failed: ${logicalPath}`);
    return {
      artifactIntegrity,
      bytesBase64: bytes.toString("base64"),
      contentType: record.contentType,
      integrity: fileIntegrity,
      path: logicalPath,
    };
  }

  async readManagedEntrypoint(
    artifactRoot: string,
    artifactIntegrity: string,
    entrypointId: string,
  ): Promise<PiariumExtensionManagedEntrypointPayload> {
    const root = await this.#assertArtifactRoot(artifactRoot, artifactIntegrity);
    const index = parseIndex(JSON.parse(await readFile(join(root, INDEX_FILE), "utf8")) as unknown);
    const entrypoint = index.entrypoints[entrypointId];
    if (!entrypoint) throw new Error(`Managed Surface entrypoint is not present in the artifact: ${entrypointId}`);
    const [module, styles] = await Promise.all([
      this.readAsset(root, artifactIntegrity, entrypoint.module),
      Promise.all(entrypoint.styles.map((path) => this.readAsset(root, artifactIntegrity, path))),
    ]);
    return { artifactIntegrity, entrypointId, module, styles };
  }

  async resolveBrokeredHostEntrypoint(
    artifactRoot: string,
    artifactIntegrity: string,
  ): Promise<BrokeredHostEntrypointArtifact> {
    const root = await this.#assertArtifactRoot(artifactRoot, artifactIntegrity);
    const index = parseIndex(JSON.parse(await readFile(join(root, INDEX_FILE), "utf8")) as unknown);
    if (!index.host) throw new Error("Host entrypoint is not present in the artifact");
    const record = index.files[index.host.module];
    if (!record) throw new Error("Host entrypoint file is missing from the artifact index");
    const modulePath = resolve(root, ...index.host.module.split("/"));
    const bytes = await readFile(modulePath);
    if (sha256(bytes) !== record.integrity) throw new Error("Host entrypoint integrity failed");
    return { artifactIntegrity, integrity: record.integrity, modulePath };
  }

  async #assertArtifactRoot(artifactRoot: string, artifactIntegrity: string): Promise<string> {
    const expected = join(this.directory, artifactIntegrity.slice("sha256-".length));
    const [actualRoot, actualExpected] = await Promise.all([realpath(artifactRoot), realpath(expected)]);
    if (actualRoot !== actualExpected) throw new Error("Piarium extension artifact path does not match its content address");
    return actualRoot;
  }
}
