import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  ApplicationExtensionCatalog,
  ExtensionPackageManager,
} from "../src/index.js";

const exec = promisify(execFile);
const temporaryDirectories: string[] = [];

const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const writeExtension = async (directory: string, id: string, version: string): Promise<void> => {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "piarium.extension.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    version,
    engines: { piarium: "*" },
    entrypoints: {
      surfaces: [{ id: "main", file: "surface.js", mode: "managed", supports: ["web", "desktop", "vscode"] }],
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

test.after(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

test("installs immutable local artifacts and stages an update without selecting it", async () => {
  const dataDir = await temporaryDirectory("piarium-artifact-data-");
  const source = await temporaryDirectory("piarium-artifact-source-");
  await writeExtension(source, "dev.example.local", "1.0.0");
  const catalog = new ApplicationExtensionCatalog({ dataDir });
  const packages = new ExtensionPackageManager({ catalog, dataDir });
  const installed = await packages.installOrStage({ kind: "local", specifier: source, display: "Local" }, 0);
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

  await writeExtension(source, "dev.example.local", "2.0.0");
  const staged = await packages.installOrStage({ kind: "local", specifier: source, display: "Local" }, installed.revision);
  assert.equal(staged.extensions[0]?.selectedVersion, "1.0.0");
  assert.equal(staged.extensions[0]?.candidate?.resolvedVersion, "2.0.0");
  const selectedUpdate = await packages.selectCandidate({
    candidateIntegrity: staged.extensions[0]?.candidate?.integrity,
    expectedRevision: staged.revision,
    extensionId: "dev.example.local",
  });
  assert.equal(selectedUpdate.extensions[0]?.selectedVersion, "2.0.0");
  assert.equal(selectedUpdate.extensions[0]?.candidate, undefined);
});

test("materializes npm and Git sources through argument-safe source resolvers", async () => {
  const npmSource = await temporaryDirectory("piarium-npm-source-");
  await writeExtension(npmSource, "dev.example.npm", "1.0.0");
  const npmData = await temporaryDirectory("piarium-npm-data-");
  const npmCatalog = new ApplicationExtensionCatalog({ dataDir: npmData });
  const npmPackages = new ExtensionPackageManager({ catalog: npmCatalog, dataDir: npmData });
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
  const gitPackages = new ExtensionPackageManager({ catalog: gitCatalog, dataDir: gitData });
  const gitInstalled = await gitPackages.installOrStage({ kind: "git", specifier: gitSource, display: "Git fixture" }, 0);
  assert.equal(gitInstalled.extensions[0]?.manifest.id, "dev.example.git");
});
