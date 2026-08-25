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
  assertPiariumApplicationVersion,
  assertPiariumExtensionManifestCompatibility,
  isPiariumExtensionId,
  parsePiariumExtensionManifest,
  type PiariumExtensionAssetPayload,
  type PiariumExtensionPreparedArtifact,
  type PiariumExtensionManagedEntrypointPayload,
  type PiariumExtensionManifest,
  type PiariumExtensionPackageSource,
} from "@piarium/extension-contract";
import {
  createDefaultExtensionPackageSourceRegistry,
  resolveNpmLaunchTarget,
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
  manifest: PiariumExtensionManifest;
  schemaVersion: 1;
}

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

export type ExtensionModuleBuilder = (options: BuildOptions) => Promise<{ metafile: Metafile | undefined }>;

const buildModuleWithEsbuild: ExtensionModuleBuilder = async (options) => {
  const { build } = await import("esbuild");
  const result = await build(options);
  return { metafile: result.metafile };
};

const sha256 = (value: Uint8Array | string): string => `sha256-${createHash("sha256").update(value).digest("hex")}`;

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new Error("Piarium extension artifact index contains a non-JSON value");
};

const artifactIntegrityForIndex = (index: Omit<ArtifactIndex, "artifactIntegrity">): string => sha256(canonicalJson(index));

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

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const INTEGRITY_PATTERN = /^sha256-[0-9a-f]{64}$/;
const LOGICAL_PATH_PATTERN = /^(?!\/)(?![A-Za-z]:[\\/])(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*\0).+$/;

const assertExactKeys = (record: Record<string, unknown>, expected: readonly string[], label: string): void => {
  const actual = Object.keys(record).sort();
  const canonicalExpected = [...expected].sort();
  if (actual.length !== canonicalExpected.length || actual.some((key, index) => key !== canonicalExpected[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
};

const parseIndex = (value: unknown): ArtifactIndex => {
  if (!isRecord(value)) throw new Error("Piarium extension artifact index is invalid");
  const hasHost = value.host !== undefined;
  assertExactKeys(
    value,
    hasHost
      ? ["artifactIntegrity", "entrypoints", "files", "host", "manifest", "schemaVersion"]
      : ["artifactIntegrity", "entrypoints", "files", "manifest", "schemaVersion"],
    "Piarium extension artifact index",
  );
  if (value.schemaVersion !== 1 || typeof value.artifactIntegrity !== "string" || !INTEGRITY_PATTERN.test(value.artifactIntegrity)) {
    throw new Error("Piarium extension artifact index header is invalid");
  }
  const manifest = parsePiariumExtensionManifest(value.manifest);
  if (!isRecord(value.files) || !isRecord(value.entrypoints)) {
    throw new Error("Piarium extension artifact index contents are invalid");
  }

  const files: Record<string, ArtifactFileRecord> = {};
  for (const [logicalPath, rawFile] of Object.entries(value.files)) {
    if (!LOGICAL_PATH_PATTERN.test(logicalPath) || logicalPath === INDEX_FILE || !isRecord(rawFile)) {
      throw new Error(`Piarium extension artifact file record is invalid: ${logicalPath}`);
    }
    assertExactKeys(rawFile, ["contentType", "integrity"], `Piarium extension artifact file record ${logicalPath}`);
    if (typeof rawFile.contentType !== "string" || rawFile.contentType.trim().length === 0
      || typeof rawFile.integrity !== "string" || !INTEGRITY_PATTERN.test(rawFile.integrity)) {
      throw new Error(`Piarium extension artifact file record is invalid: ${logicalPath}`);
    }
    files[logicalPath] = { contentType: rawFile.contentType, integrity: rawFile.integrity };
  }

  const entrypoints: Record<string, ArtifactEntrypointRecord> = {};
  for (const [entrypointId, rawEntrypoint] of Object.entries(value.entrypoints)) {
    if (!isPiariumExtensionId(entrypointId) || !isRecord(rawEntrypoint)) {
      throw new Error(`Piarium extension artifact Surface entrypoint record is invalid: ${entrypointId}`);
    }
    assertExactKeys(rawEntrypoint, ["module", "styles"], `Piarium extension artifact Surface entrypoint ${entrypointId}`);
    if (typeof rawEntrypoint.module !== "string" || !LOGICAL_PATH_PATTERN.test(rawEntrypoint.module)
      || !Array.isArray(rawEntrypoint.styles)
      || rawEntrypoint.styles.some((style) => typeof style !== "string" || !LOGICAL_PATH_PATTERN.test(style))) {
      throw new Error(`Piarium extension artifact Surface entrypoint record is invalid: ${entrypointId}`);
    }
    const styles = rawEntrypoint.styles as string[];
    if (new Set(styles).size !== styles.length || !files[rawEntrypoint.module]
      || styles.some((style) => !files[style])) {
      throw new Error(`Piarium extension artifact Surface entrypoint files are invalid: ${entrypointId}`);
    }
    entrypoints[entrypointId] = { module: rawEntrypoint.module, styles: [...styles] };
  }
  const executableEntrypoints = (manifest.entrypoints?.surfaces ?? [])
    .filter((entrypoint) => entrypoint.mode !== "declarative")
    .map((entrypoint) => entrypoint.id)
    .sort();
  if (JSON.stringify(Object.keys(entrypoints).sort()) !== JSON.stringify(executableEntrypoints)) {
    throw new Error("Piarium extension artifact Surface entrypoint mapping does not match its manifest snapshot");
  }

  let host: ArtifactIndex["host"];
  if (hasHost) {
    if (!isRecord(value.host)) throw new Error("Piarium extension artifact Host entrypoint record is invalid");
    assertExactKeys(value.host, ["module"], "Piarium extension artifact Host entrypoint");
    if (typeof value.host.module !== "string" || !LOGICAL_PATH_PATTERN.test(value.host.module) || !files[value.host.module]) {
      throw new Error("Piarium extension artifact Host entrypoint file is invalid");
    }
    host = { module: value.host.module };
  }
  if (Boolean(host) !== Boolean(manifest.entrypoints?.host)) {
    throw new Error("Piarium extension artifact Host entrypoint mapping does not match its manifest snapshot");
  }
  if (!files[`package/${PIARIUM_EXTENSION_MANIFEST_FILE}`]) {
    throw new Error("Piarium extension artifact manifest file is missing from its index");
  }
  return {
    artifactIntegrity: value.artifactIntegrity,
    entrypoints,
    files,
    ...(host ? { host } : {}),
    manifest,
    schemaVersion: 1,
  };
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
  readonly piariumVersion: string;
  readonly #build: ExtensionModuleBuilder;
  readonly #packageSources: PiariumExtensionPackageSourceRegistry;
  readonly #run: ExtensionSourceCommandRunner;

  constructor(options: ExtensionArtifactStoreOptions) {
    this.dataDir = resolve(options.dataDir);
    this.directory = join(this.dataDir, "extensions", "artifacts", "sha256");
    this.piariumVersion = options.piariumVersion;
    assertPiariumApplicationVersion(this.piariumVersion);
    this.#build = options.buildModule ?? buildModuleWithEsbuild;
    this.#run = options.run ?? runExtensionSourceCommand;
    this.#packageSources = options.packageSources ?? createDefaultExtensionPackageSourceRegistry({
      ...(options.builtinRoots ? { builtinRoots: options.builtinRoots } : {}),
      run: this.#run,
    });
  }

  async prepare(source: PiariumExtensionPackageSource, signal?: AbortSignal): Promise<PiariumExtensionPreparedArtifact> {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "piarium-extension-"));
    const materializedSourceRoot = join(temporaryRoot, "source");
    const artifactRoot = join(temporaryRoot, "artifact");
    try {
      const sourceRoot = await this.#packageSources.materialize(source, materializedSourceRoot, signal);
      await assertSafeTree(sourceRoot);
      const manifest = await readManifest(sourceRoot);
      assertPiariumExtensionManifestCompatibility(manifest, this.piariumVersion);
      if (!(await exists(join(sourceRoot, "node_modules"))) && await hasDependencies(sourceRoot)) {
        if (source.kind === "local") {
          throw new Error(
            `Local Piarium extension dependencies are not installed: ${source.display}. Run npm install in the extension project before reloading it. Piarium will not modify the working tree.`,
          );
        }
        const npm = await resolveNpmLaunchTarget();
        await this.#run(npm.executable, [...npm.argsPrefix, "install", "--ignore-scripts", "--no-audit", "--no-fund"], {
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
      const indexContent: Omit<ArtifactIndex, "artifactIntegrity"> = {
        entrypoints,
        files,
        ...(host ? { host } : {}),
        manifest,
        schemaVersion: 1,
      };
      const artifactIntegrity = artifactIntegrityForIndex(indexContent);
      const index: ArtifactIndex = { artifactIntegrity, ...indexContent };
      await writeFile(join(artifactRoot, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

      const finalPath = join(this.directory, artifactIntegrity.slice("sha256-".length));
      await mkdir(dirname(finalPath), { recursive: true });
      try {
        await rename(artifactRoot, finalPath);
      } catch (error) {
        if (!(await exists(finalPath))) throw error;
      }
      await this.#readVerifiedIndex(finalPath, artifactIntegrity, manifest, true);
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
    expectedManifest?: PiariumExtensionManifest,
  ): Promise<PiariumExtensionAssetPayload> {
    const { index, root } = await this.#readVerifiedIndex(artifactRoot, artifactIntegrity, expectedManifest);
    const { bytes, record } = await this.#readVerifiedFile(root, index, logicalPath);
    return {
      artifactIntegrity,
      bytesBase64: bytes.toString("base64"),
      contentType: record.contentType,
      integrity: record.integrity,
      path: logicalPath,
    };
  }

  async readManagedEntrypoint(
    artifactRoot: string,
    artifactIntegrity: string,
    entrypointId: string,
    expectedManifest?: PiariumExtensionManifest,
  ): Promise<PiariumExtensionManagedEntrypointPayload> {
    const { index, root } = await this.#readVerifiedIndex(artifactRoot, artifactIntegrity, expectedManifest);
    const entrypoint = index.entrypoints[entrypointId];
    if (!entrypoint) throw new Error(`Managed Surface entrypoint is not present in the artifact: ${entrypointId}`);
    const readPayload = async (logicalPath: string): Promise<PiariumExtensionAssetPayload> => {
      const { bytes, record } = await this.#readVerifiedFile(root, index, logicalPath);
      return {
        artifactIntegrity,
        bytesBase64: bytes.toString("base64"),
        contentType: record.contentType,
        integrity: record.integrity,
        path: logicalPath,
      };
    };
    const [module, styles] = await Promise.all([
      readPayload(entrypoint.module),
      Promise.all(entrypoint.styles.map(readPayload)),
    ]);
    return { artifactIntegrity, entrypointId, module, styles };
  }

  async resolveBrokeredHostEntrypoint(
    artifactRoot: string,
    artifactIntegrity: string,
    expectedManifest?: PiariumExtensionManifest,
  ): Promise<BrokeredHostEntrypointArtifact> {
    const { index, root } = await this.#readVerifiedIndex(artifactRoot, artifactIntegrity, expectedManifest);
    if (!index.host) throw new Error("Host entrypoint is not present in the artifact");
    const { path, record } = await this.#readVerifiedFile(root, index, index.host.module);
    return {
      artifactIntegrity,
      integrity: record.integrity,
      modulePath: path,
      packageRoot: join(root, "package"),
    };
  }

  async #readVerifiedIndex(
    artifactRoot: string,
    artifactIntegrity: string,
    expectedManifest?: PiariumExtensionManifest,
    verifyAllFiles = false,
  ): Promise<{ index: ArtifactIndex; root: string }> {
    const root = await this.#assertArtifactRoot(artifactRoot, artifactIntegrity);
    const index = parseIndex(JSON.parse(await readFile(join(root, INDEX_FILE), "utf8")) as unknown);
    const indexContent: Omit<ArtifactIndex, "artifactIntegrity"> = {
      entrypoints: index.entrypoints,
      files: index.files,
      ...(index.host ? { host: index.host } : {}),
      manifest: index.manifest,
      schemaVersion: 1,
    };
    const canonicalIntegrity = artifactIntegrityForIndex(indexContent);
    if (canonicalIntegrity !== index.artifactIntegrity || index.artifactIntegrity !== artifactIntegrity) {
      throw new Error("Piarium extension artifact canonical index integrity no longer matches its content address");
    }
    const manifestLogicalPath = `package/${PIARIUM_EXTENSION_MANIFEST_FILE}`;
    const { bytes: manifestBytes } = await this.#readVerifiedFile(root, index, manifestLogicalPath);
    const artifactManifest = parsePiariumExtensionManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown);
    if (canonicalJson(artifactManifest) !== canonicalJson(index.manifest)) {
      throw new Error("Piarium extension artifact manifest file does not match its authenticated index snapshot");
    }
    if (expectedManifest && canonicalJson(expectedManifest) !== canonicalJson(index.manifest)) {
      throw new Error("Piarium extension artifact manifest snapshot no longer matches the catalog record");
    }
    if (verifyAllFiles) {
      const actualFiles = (await walkFiles(root)).filter((logicalPath) => logicalPath !== INDEX_FILE);
      const indexedFiles = Object.keys(index.files).sort();
      if (JSON.stringify(actualFiles) !== JSON.stringify(indexedFiles)) {
        throw new Error("Piarium extension artifact files do not match its authenticated index");
      }
      await Promise.all(indexedFiles.map((logicalPath) => this.#readVerifiedFile(root, index, logicalPath)));
    }
    return { index, root };
  }

  async #readVerifiedFile(
    root: string,
    index: ArtifactIndex,
    logicalPath: string,
  ): Promise<{ bytes: Buffer; path: string; record: ArtifactFileRecord }> {
    const record = index.files[logicalPath];
    if (!record) throw new Error(`Piarium extension artifact does not contain asset: ${logicalPath}`);
    const path = resolve(root, ...logicalPath.split("/"));
    const relativePath = relative(root, path);
    if (!relativePath || relativePath.startsWith("..") || resolve(root, relativePath) !== path) {
      throw new Error("Piarium extension asset path escapes its immutable artifact");
    }
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`Piarium extension artifact asset is not an immutable file: ${logicalPath}`);
    const bytes = await readFile(path);
    if (sha256(bytes) !== record.integrity) throw new Error(`Piarium extension asset integrity failed: ${logicalPath}`);
    return { bytes, path, record };
  }

  async #assertArtifactRoot(artifactRoot: string, artifactIntegrity: string): Promise<string> {
    const expected = join(this.directory, artifactIntegrity.slice("sha256-".length));
    const [actualRoot, actualExpected] = await Promise.all([realpath(artifactRoot), realpath(expected)]);
    if (actualRoot !== actualExpected) throw new Error("Piarium extension artifact path does not match its content address");
    return actualRoot;
  }
}
