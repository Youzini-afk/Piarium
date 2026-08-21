import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import test from "node:test";
import {
  ApplicationExtensionCatalog,
  ExtensionPackageManager,
  LocalExtensionPackageSourceResolver,
  resolveNpmLaunchTarget,
} from "../src/index.js";
import {
  PIARIUM_BUILTIN_EXTENSION_DEFINITIONS,
  PIARIUM_BUILTIN_EXTENSION_PREFIX,
} from "@piarium/extension-builtins";

const exec = promisify(execFile);
const temporaryDirectories: string[] = [];
const PIARIUM_VERSION = "1.2.3";

const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const writeExtension = async (
  directory: string,
  id: string,
  version: string,
  mode: "isolated" | "managed" | "native" = "managed",
  piariumRange = "*",
): Promise<void> => {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "piarium.extension.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    version,
    engines: { piarium: piariumRange },
    entrypoints: {
      surfaces: [{ id: "main", file: "surface.js", mode, supports: ["web", "desktop", "vscode"] }],
    },
  }), "utf8");
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: id, version, type: "module" }), "utf8");
  await writeFile(join(directory, "surface.js"), [
    "import './theme.css';",
    `export default { activate(context) { context.contribute({ id: '${id}.page', kind: 'page', contractVersion: 1, supports: ['web', 'desktop', 'vscode'], data: {} }, { version: '${version}' }); } };`,
  ].join("\n"), "utf8");
  await writeFile(join(directory, "theme.css"), `.extension-${version.replaceAll(".", "-")} { color: green; }`, "utf8");
  await writeFile(join(directory, "icon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", "utf8");
};

const snapshotDirectory = async (directory: string): Promise<Record<string, string>> => {
  const snapshot: Record<string, string> = {};
  const visit = async (current: string, prefix = ""): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path, relativePath);
      else snapshot[relativePath] = (await readFile(path)).toString("base64");
    }
  };
  await visit(directory);
  return snapshot;
};

test.after(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

test("resolves npm from PATH when the embedding executable is Bun or Electron", async () => {
  const runtime = await temporaryDirectory("piarium-npm-runtime-");
  const nodePath = join(runtime, "node.exe");
  const npmCli = join(runtime, "node_modules", "npm", "bin", "npm-cli.js");
  await mkdir(join(runtime, "node_modules", "npm", "bin"), { recursive: true });
  await writeFile(nodePath, "fixture", "utf8");
  await writeFile(npmCli, "fixture", "utf8");
  const canonicalNodePath = await realpath(nodePath);
  const canonicalNpmCli = await realpath(npmCli);

  for (const executable of ["bun.exe", "electron.exe"]) {
    const resolved = await resolveNpmLaunchTarget({
      env: { PATH: runtime },
      execPath: join(runtime, executable),
      platform: "win32",
    });
    assert.equal(resolved.executable, canonicalNodePath);
    assert.deepEqual(resolved.argsPrefix, [canonicalNpmCli]);
  }
});

test("resolves local sources in place without copying the working tree", async () => {
  const source = await temporaryDirectory("piarium-local-resolver-source-");
  const materializationRoot = await temporaryDirectory("piarium-local-resolver-materialization-");
  const destination = join(materializationRoot, "source");
  await writeExtension(source, "dev.example.in-place", "1.0.0");

  const resolved = await new LocalExtensionPackageSourceResolver().materialize(
    { kind: "local", specifier: source, display: "In place" },
    destination,
  );

  assert.equal(resolved, await realpath(source));
  await assert.rejects(access(destination), { code: "ENOENT" });
});

test("refuses to install missing local dependencies without modifying the working tree", async () => {
  const dataDir = await temporaryDirectory("piarium-local-dependencies-data-");
  const source = await temporaryDirectory("piarium-local-dependencies-source-");
  await writeExtension(source, "dev.example.dependencies", "1.0.0");
  await writeFile(join(source, "package.json"), JSON.stringify({
    dependencies: { "fixture-dependency": "1.0.0" },
    name: "dev.example.dependencies",
    version: "1.0.0",
  }), "utf8");
  const before = await snapshotDirectory(source);
  const catalog = new ApplicationExtensionCatalog({ dataDir });
  const packages = new ExtensionPackageManager({ catalog, dataDir, piariumVersion: PIARIUM_VERSION });

  await assert.rejects(
    packages.installOrStage({ kind: "local", specifier: source, display: "Dependencies" }, 0),
    /Run npm install in the extension project before reloading it.*will not modify the working tree/,
  );

  assert.deepEqual(await snapshotDirectory(source), before);
  await assert.rejects(access(join(source, "node_modules")), { code: "ENOENT" });
  assert.deepEqual((await catalog.snapshot()).extensions, []);
});

test("builds isolated Surface artifacts as self-contained realm scripts", async () => {
  const dataDir = await temporaryDirectory("piarium-isolated-artifact-data-");
  const source = await temporaryDirectory("piarium-isolated-artifact-source-");
  await writeExtension(source, "dev.example.isolated", "1.0.0", "isolated");
  const catalog = new ApplicationExtensionCatalog({ dataDir });
  const packages = new ExtensionPackageManager({ catalog, dataDir, piariumVersion: PIARIUM_VERSION });
  const installed = await packages.installOrStage({ kind: "local", specifier: source, display: "Isolated" }, 0);
  const selected = installed.extensions[0];
  const payload = await packages.readManagedEntrypoint({
    entrypointId: "main",
    extensionId: "dev.example.isolated",
    integrity: selected?.integrity ?? "",
    slot: "selected",
  });
  assert.match(payload.module.path, /module\.js$/);
  assert.match(Buffer.from(payload.module.bytesBase64, "base64").toString("utf8"), /PiariumIsolatedModule/);
  assert.equal(payload.styles.length, 1);
});

test("materializes a published CommonJS isolated module into one usable realm bundle", async () => {
  const dataDir = await temporaryDirectory("piarium-isolated-cjs-data-");
  const source = await temporaryDirectory("piarium-isolated-cjs-source-");
  await writeExtension(source, "dev.example.isolated-cjs", "1.0.0", "isolated");
  await writeFile(join(source, "piarium.extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "dev.example.isolated-cjs",
    version: "1.0.0",
    engines: { piarium: "*" },
    entrypoints: {
      surfaces: [{ id: "main", file: "surface.cjs", mode: "isolated", supports: ["web"] }],
    },
  }), "utf8");
  await writeFile(join(source, "surface.cjs"), [
    "module.exports = {",
    "  activate(context) {",
    "    context.effect(() => undefined);",
    "  },",
    "};",
  ].join("\n"), "utf8");
  const catalog = new ApplicationExtensionCatalog({ dataDir });
  const packages = new ExtensionPackageManager({ catalog, dataDir, piariumVersion: PIARIUM_VERSION });
  const installed = await packages.installOrStage({ kind: "local", specifier: source, display: "Isolated CJS" }, 0);
  const selected = installed.extensions[0];
  const payload = await packages.readManagedEntrypoint({
    entrypointId: "main",
    extensionId: "dev.example.isolated-cjs",
    integrity: selected?.integrity ?? "",
    slot: "selected",
  });
  const realm: Record<string, unknown> = {};
  runInNewContext(Buffer.from(payload.module.bytesBase64, "base64").toString("utf8"), realm);
  const module = realm.PiariumIsolatedModule as { activate?: unknown; default?: { activate?: unknown } };
  assert.equal(typeof (module.default ?? module).activate, "function");
});

test("installs immutable local artifacts and stages an update without selecting it", async () => {
  const dataDir = await temporaryDirectory("piarium-artifact-data-");
  const source = await temporaryDirectory("piarium-artifact-source-");
  await writeExtension(source, "dev.example.local", "1.0.0");
  const catalog = new ApplicationExtensionCatalog({ dataDir });
  const packages = new ExtensionPackageManager({ catalog, dataDir, piariumVersion: PIARIUM_VERSION });
  const beforeInstall = await snapshotDirectory(source);
  const installed = await packages.installOrStage({ kind: "local", specifier: source, display: "Local" }, 0);
  assert.deepEqual(await snapshotDirectory(source), beforeInstall);
  const selected = installed.extensions[0];
  assert.equal(selected?.selectedVersion, "1.0.0");
  assert.match(selected?.integrity ?? "", /^sha256-[0-9a-f]{64}$/);
  const payload = await packages.readManagedEntrypoint({
    entrypointId: "main",
    extensionId: "dev.example.local",
    integrity: selected?.integrity ?? "",
    slot: "selected",
  });
  assert.equal(payload.styles.length, 1);
  assert.match(Buffer.from(payload.module.bytesBase64, "base64").toString("utf8"), /1\.0\.0/);

  const unchanged = await packages.reloadLocalSource({
    expectedRevision: installed.revision,
    extensionId: "dev.example.local",
  });
  assert.equal(unchanged.outcome, "unchanged");
  assert.equal(unchanged.snapshot.revision, installed.revision);

  await writeExtension(source, "dev.example.local", "2.0.0");
  const stagedResult = await packages.reloadLocalSource({
    expectedRevision: installed.revision,
    extensionId: "dev.example.local",
  });
  assert.equal(stagedResult.outcome, "staged");
  const staged = stagedResult.snapshot;
  assert.equal(staged.extensions[0]?.selectedVersion, "1.0.0");
  assert.equal(staged.extensions[0]?.candidate?.resolvedVersion, "2.0.0");
  const requested = await catalog.requestCandidateApplication(
    "dev.example.local",
    staged.extensions[0]?.candidate?.integrity ?? "",
    staged.revision,
  );
  const selectedUpdate = await packages.selectCandidate({
    candidateIntegrity: staged.extensions[0]?.candidate?.integrity,
    expectedRevision: requested.revision,
    extensionId: "dev.example.local",
  });
  assert.equal(selectedUpdate.extensions[0]?.selectedVersion, "2.0.0");
  assert.equal(selectedUpdate.extensions[0]?.candidate, undefined);
});

test("local reload stages added capabilities for review without selecting the candidate", async () => {
  const dataDir = await temporaryDirectory("piarium-local-capability-data-");
  const source = await temporaryDirectory("piarium-local-capability-source-");
  const id = "dev.example.local-capability";
  await writeExtension(source, id, "1.0.0");
  const catalog = new ApplicationExtensionCatalog({ dataDir });
  const packages = new ExtensionPackageManager({ catalog, dataDir, piariumVersion: PIARIUM_VERSION });
  const installed = await packages.installOrStage({ kind: "local", specifier: source, display: "Capability reload" }, 0);
  const manifestPath = join(source, "piarium.extension.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.version = "2.0.0";
  manifest.capabilities = { surface: ["desktop.clipboard"] };
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

  const result = await packages.reloadLocalSource({ expectedRevision: installed.revision, extensionId: id });

  assert.equal(result.outcome, "staged");
  assert.equal(result.snapshot.extensions[0]?.selectedVersion, "1.0.0");
  assert.equal(result.snapshot.extensions[0]?.candidate?.resolvedVersion, "2.0.0");
  assert.equal(result.snapshot.extensions[0]?.candidate?.capabilitiesReviewed, false);
  assert.equal(result.snapshot.extensions[0]?.candidate?.applyRequested, false);
});

test("rejects incompatible first installs and candidates without changing the selected version", async () => {
  const dataDir = await temporaryDirectory("piarium-engine-data-");
  const incompatibleFirst = await temporaryDirectory("piarium-engine-first-");
  await writeExtension(incompatibleFirst, "dev.example.incompatible-first", "1.0.0", "managed", ">=2.0.0");
  const catalog = new ApplicationExtensionCatalog({ dataDir });
  const packages = new ExtensionPackageManager({ catalog, dataDir, piariumVersion: PIARIUM_VERSION });
  await assert.rejects(
    packages.installOrStage({ kind: "local", specifier: incompatibleFirst, display: "Incompatible first" }, 0),
    /requires Piarium >=2\.0\.0; current version is 1\.2\.3/,
  );
  assert.deepEqual((await catalog.snapshot()).extensions, []);

  const source = await temporaryDirectory("piarium-engine-candidate-");
  await writeExtension(source, "dev.example.engine", "1.0.0", "managed", ">=1.2.3 <1.3.0");
  const installed = await packages.installOrStage({ kind: "local", specifier: source, display: "Compatible" }, 0);
  assert.equal(installed.extensions[0]?.selectedVersion, "1.0.0");
  await writeExtension(source, "dev.example.engine", "2.0.0", "managed", ">=1.2.4 <2.0.0");
  await assert.rejects(
    packages.installOrStage({ kind: "local", specifier: source, display: "Incompatible candidate" }, installed.revision),
    /requires Piarium >=1\.2\.4 <2\.0\.0; current version is 1\.2\.3/,
  );
  const after = await catalog.snapshot();
  assert.equal(after.extensions[0]?.selectedVersion, "1.0.0");
  assert.equal(after.extensions[0]?.candidate, undefined);
});

test("authenticates the complete artifact index and rejects corrupt cache reuse", async () => {
  const dataDir = await temporaryDirectory("piarium-index-auth-data-");
  const source = await temporaryDirectory("piarium-index-auth-source-");
  const id = "dev.example.index-auth";
  await writeExtension(source, id, "1.0.0");
  const manifestPath = join(source, "piarium.extension.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.entrypoints = {
    host: { activation: ["service-request"], file: "host.cjs", mode: "brokered" },
    surfaces: [{ id: "main", file: "surface.js", mode: "managed", supports: ["web"] }],
  };
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  await writeFile(join(source, "host.cjs"), "module.exports = { activate() {} };", "utf8");

  const catalog = new ApplicationExtensionCatalog({ dataDir });
  const packages = new ExtensionPackageManager({ catalog, dataDir, piariumVersion: PIARIUM_VERSION });
  const installed = await packages.installOrStage({ kind: "local", specifier: source, display: "Index auth" }, 0);
  const integrity = installed.extensions[0]?.integrity;
  assert.ok(integrity);
  const persisted = await catalog.store.read();
  const artifactRoot = persisted.document.extensions[id]?.resolvedPath;
  assert.ok(artifactRoot);
  const indexPath = join(artifactRoot, "artifact-index.json");
  const originalIndexText = await readFile(indexPath, "utf8");
  const originalIndex = JSON.parse(originalIndexText) as {
    entrypoints: Record<string, { module: string; styles: string[] }>;
    files: Record<string, { contentType: string; integrity: string }>;
    host: { module: string };
    manifest: Record<string, unknown>;
  };
  const readSurface = () => packages.readManagedEntrypoint({
    entrypointId: "main",
    extensionId: id,
    integrity,
    slot: "selected",
  });
  const hostArtifact = await packages.resolveBrokeredHostEntrypoint(id, "selected", integrity);
  assert.equal(await realpath(hostArtifact.packageRoot), await realpath(join(artifactRoot, "package")));

  const manifestTamper = structuredClone(originalIndex);
  manifestTamper.manifest.displayName = "Tampered snapshot";
  await writeFile(indexPath, JSON.stringify(manifestTamper), "utf8");
  await assert.rejects(readSurface(), /canonical index integrity/);

  const surfaceMappingTamper = structuredClone(originalIndex);
  surfaceMappingTamper.entrypoints.main!.module = "package/icon.svg";
  await writeFile(indexPath, JSON.stringify(surfaceMappingTamper), "utf8");
  await assert.rejects(readSurface(), /canonical index integrity/);

  const hostMappingTamper = structuredClone(originalIndex);
  hostMappingTamper.host.module = "package/icon.svg";
  await writeFile(indexPath, JSON.stringify(hostMappingTamper), "utf8");
  await assert.rejects(
    packages.resolveBrokeredHostEntrypoint(id, "selected", integrity),
    /canonical index integrity/,
  );

  const fileRecordTamper = structuredClone(originalIndex);
  fileRecordTamper.files["package/icon.svg"]!.contentType = "text/plain";
  await writeFile(indexPath, JSON.stringify(fileRecordTamper), "utf8");
  await assert.rejects(
    packages.readAsset({ extensionId: id, integrity, path: "package/icon.svg", slot: "selected" }),
    /canonical index integrity/,
  );

  await writeFile(indexPath, originalIndexText, "utf8");
  const modulePath = join(artifactRoot, ...originalIndex.entrypoints.main!.module.split("/"));
  const originalModule = await readFile(modulePath);
  await writeFile(modulePath, "tampered module", "utf8");
  await assert.rejects(readSurface(), /asset integrity failed/);
  await writeFile(modulePath, originalModule);

  await writeFile(indexPath, JSON.stringify(surfaceMappingTamper), "utf8");
  await assert.rejects(
    packages.installOrStage({ kind: "local", specifier: source, display: "Index auth" }, installed.revision),
    /canonical index integrity/,
  );
  const after = await catalog.snapshot();
  assert.equal(after.extensions[0]?.selectedVersion, "1.0.0");
  assert.equal(after.extensions[0]?.candidate, undefined);
});

test("a first install that requests capabilities remains disabled for explicit review", async () => {
  const dataDir = await temporaryDirectory("piarium-capability-install-data-");
  const source = await temporaryDirectory("piarium-capability-install-source-");
  await writeExtension(source, "dev.example.capability-install", "1.0.0");
  await writeFile(join(source, "piarium.extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "dev.example.capability-install",
    version: "1.0.0",
    engines: { piarium: "*" },
    capabilities: { surface: ["desktop.clipboard"] },
    entrypoints: {
      surfaces: [{ id: "main", file: "surface.js", mode: "managed", supports: ["web"] }],
    },
  }), "utf8");
  const catalog = new ApplicationExtensionCatalog({ dataDir });
  const packages = new ExtensionPackageManager({ catalog, dataDir, piariumVersion: PIARIUM_VERSION });
  const installed = await packages.installOrStage({ kind: "local", specifier: source, display: "Capability" }, 0);
  assert.equal(installed.extensions[0]?.desired.enabled, false);
  assert.deepEqual(installed.extensions[0]?.capabilityGrants, []);
});

test("external sources cannot replace a distribution-owned built-in record", async () => {
  const dataDir = await temporaryDirectory("piarium-builtin-ownership-data-");
  const source = await temporaryDirectory("piarium-builtin-ownership-source-");
  const builtinId = PIARIUM_BUILTIN_EXTENSION_DEFINITIONS[0]?.manifest.id;
  assert.ok(builtinId);
  await writeExtension(source, builtinId, "99.0.0");
  const catalog = new ApplicationExtensionCatalog({ dataDir });
  const builtins = await catalog.reconcileBuiltins(
    PIARIUM_BUILTIN_EXTENSION_DEFINITIONS,
    PIARIUM_BUILTIN_EXTENSION_PREFIX,
  );
  const packages = new ExtensionPackageManager({ catalog, dataDir, piariumVersion: PIARIUM_VERSION });
  await assert.rejects(
    packages.installOrStage({ kind: "local", specifier: source, display: "External replacement" }, builtins.revision),
    /managed by the distribution/,
  );
  const after = await catalog.snapshot();
  assert.equal(after.extensions.find((entry) => entry.manifest.id === builtinId)?.source.kind, "builtin");
});

test("materializes npm and Git sources through argument-safe source resolvers", async () => {
  const npmSource = await temporaryDirectory("piarium-npm-source-");
  await writeExtension(npmSource, "dev.example.npm", "1.0.0");
  const npmData = await temporaryDirectory("piarium-npm-data-");
  const npmCatalog = new ApplicationExtensionCatalog({ dataDir: npmData });
  const npmPackages = new ExtensionPackageManager({
    catalog: npmCatalog,
    dataDir: npmData,
    piariumVersion: PIARIUM_VERSION,
  });
  const npmInstalled = await npmPackages.installOrStage({ kind: "npm", specifier: npmSource, display: "npm fixture" }, 0);
  assert.equal(npmInstalled.extensions[0]?.manifest.id, "dev.example.npm");

  const gitSource = await temporaryDirectory("piarium-git-source-");
  await writeExtension(gitSource, "dev.example.git", "1.0.0");
  await exec("git", ["init"], { cwd: gitSource });
  await exec("git", ["config", "user.email", "piarium@example.invalid"], { cwd: gitSource });
  await exec("git", ["config", "user.name", "Piarium Test"], { cwd: gitSource });
  await exec("git", ["add", "."], { cwd: gitSource });
  await exec("git", ["commit", "-m", "fixture"], { cwd: gitSource });
  const gitData = await temporaryDirectory("piarium-git-data-");
  const gitCatalog = new ApplicationExtensionCatalog({ dataDir: gitData });
  const gitPackages = new ExtensionPackageManager({
    catalog: gitCatalog,
    dataDir: gitData,
    piariumVersion: PIARIUM_VERSION,
  });
  const gitInstalled = await gitPackages.installOrStage({ kind: "git", specifier: gitSource, display: "Git fixture" }, 0);
  assert.equal(gitInstalled.extensions[0]?.manifest.id, "dev.example.git");
});
