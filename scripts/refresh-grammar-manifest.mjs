#!/usr/bin/env node
/**
 * Publish-time grammar pack manifest (D-117).
 *
 * Packs each candidate from npm, extracts the published wasm, hashes it
 * ourselves, and records ABI via web-tree-sitter. The committed JSON is the
 * authority — runtime does not trust a network-supplied digest.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const webRoot = path.join(repoRoot, "packages", "web");
const require = createRequire(path.join(webRoot, "package.json"));
const destPath = path.join(
  webRoot,
  "application-host",
  "lib",
  "structure",
  "grammar-packs.json",
);

/** Plan 3.11 coverage targets, keyed by protocol language ids (D-119). */
const CANDIDATES = [
  { languageId: "python", packages: ["tree-sitter-python"] },
  { languageId: "go", packages: ["tree-sitter-go"] },
  { languageId: "rust", packages: ["tree-sitter-rust"] },
  { languageId: "java", packages: ["tree-sitter-java"] },
  { languageId: "c", packages: ["tree-sitter-c"] },
  { languageId: "cpp", packages: ["tree-sitter-cpp"] },
  { languageId: "csharp", packages: ["tree-sitter-c-sharp"] },
  { languageId: "kotlin", packages: ["tree-sitter-kotlin", "@tree-sitter-grammars/tree-sitter-kotlin"] },
  { languageId: "swift", packages: ["tree-sitter-swift"] },
  { languageId: "ruby", packages: ["tree-sitter-ruby"] },
  { languageId: "php", packages: ["tree-sitter-php"] },
  { languageId: "shellscript", packages: ["tree-sitter-bash"] },
  { languageId: "css", packages: ["tree-sitter-css"] },
  { languageId: "html", packages: ["tree-sitter-html"] },
  { languageId: "yaml", packages: ["tree-sitter-yaml", "@tree-sitter-grammars/tree-sitter-yaml"] },
  { languageId: "toml", packages: ["tree-sitter-toml", "@tree-sitter-grammars/tree-sitter-toml"] },
  { languageId: "markdown", packages: ["tree-sitter-markdown", "@tree-sitter-grammars/tree-sitter-markdown"] },
  { languageId: "xml", packages: ["tree-sitter-xml", "@tree-sitter-grammars/tree-sitter-xml"] },
];

const log = (message) => process.stdout.write(`[refresh-grammar-manifest] ${message}\n`);

const integrityOf = (bytes) => `sha256-${createHash("sha256").update(bytes).digest("hex")}`;

const registryUrl = (packageName) => (
  `https://registry.npmjs.org/${packageName.replace("/", "%2f")}`
);

const fetchJson = async (url) => {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
};

const downloadTo = async (url, dest) => {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`download ${url}: ${response.status} ${response.statusText}`);
  }
  await pipeline(response.body, createWriteStream(dest));
};

const preferredWasm = (languageId, files) => {
  const names = files.filter((file) => file.endsWith(".wasm"));
  if (names.length === 0) return null;
  const exact = names.find((file) => file.endsWith(`tree-sitter-${languageId}.wasm`))
    ?? names.find((file) => /tree-sitter-[^/]+\.wasm$/.test(file) && !file.includes("_"));
  return exact ?? names[0];
};

const licenseFile = (files) => (
  files.find((file) => /(?:^|\/)(?:license|copying|licence)(?:\.[^/]+)?$/i.test(file)) ?? null
);

const inspectPackage = async (languageId, packageName, workDir, loadAbi) => {
  let metadata;
  try {
    metadata = await fetchJson(registryUrl(packageName));
  } catch (error) {
    return { skip: `${packageName}: registry lookup failed (${error instanceof Error ? error.message : error})` };
  }
  const version = metadata["dist-tags"]?.latest;
  const versionMeta = version ? metadata.versions?.[version] : null;
  if (!version || !versionMeta?.dist?.tarball) {
    return { skip: `${packageName}: no latest tarball on npm` };
  }
  const tarballPath = path.join(workDir, `${packageName.replace(/[\\/@]/g, "_")}-${version}.tgz`);
  await downloadTo(versionMeta.dist.tarball, tarballPath);
  const extractDir = path.join(workDir, `${packageName.replace(/[\\/@]/g, "_")}-${version}`);
  await fs.mkdir(extractDir, { recursive: true });
  const { extract } = require("tar");
  await extract({ file: tarballPath, cwd: extractDir });
  const files = [];
  const walk = async (dir, prefix) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative);
      else files.push(relative);
    }
  };
  await walk(extractDir);
  const wasmRelative = preferredWasm(languageId, files);
  if (!wasmRelative) {
    return { skip: `${packageName}@${version}: tarball has no .wasm` };
  }
  const wasmBytes = await fs.readFile(path.join(extractDir, wasmRelative));
  const abi = await loadAbi(path.join(extractDir, wasmRelative));
  return {
    pack: {
      languageId,
      packageName,
      version,
      tarballUrl: versionMeta.dist.tarball,
      wasmPath: wasmRelative.replace(/\\/g, "/"),
      grammarFile: path.posix.basename(wasmRelative.replace(/\\/g, "/")),
      integrity: integrityOf(wasmBytes),
      bytes: wasmBytes.byteLength,
      abi,
      licensePath: licenseFile(files)?.replace(/\\/g, "/") ?? null,
    },
  };
};

const loadWebTreeSitter = async () => {
  const { Parser, Language, MIN_COMPATIBLE_VERSION, LANGUAGE_VERSION } = await import(
    pathToFileURL(require.resolve("web-tree-sitter")).href
  );
  const wasm = require.resolve("web-tree-sitter/web-tree-sitter.wasm");
  await Parser.init({ locateFile: () => wasm });
  return {
    // web-tree-sitter 0.27 window. Named exports are missing from some builds.
    min: typeof MIN_COMPATIBLE_VERSION === "number" ? MIN_COMPATIBLE_VERSION : 13,
    max: typeof LANGUAGE_VERSION === "number" ? LANGUAGE_VERSION : 15,
    loadAbi: async (grammarPath) => {
      const language = await Language.load(grammarPath);
      return language.abiVersion;
    },
  };
};

const main = async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-grammar-manifest-"));
  const runtime = await loadWebTreeSitter();
  const packs = {};
  const skipped = {};
  try {
    for (const candidate of CANDIDATES) {
      let recorded = false;
      const reasons = [];
      for (const packageName of candidate.packages) {
        try {
          const result = await inspectPackage(candidate.languageId, packageName, workDir, runtime.loadAbi);
          if (result.skip) {
            reasons.push(result.skip);
            continue;
          }
          if (result.pack.abi < runtime.min || result.pack.abi > runtime.max) {
            reasons.push(
              `${packageName}@${result.pack.version}: wasm ABI ${result.pack.abi} outside ${runtime.min}-${runtime.max}`,
            );
            continue;
          }
          packs[candidate.languageId] = result.pack;
          recorded = true;
          log(`${candidate.languageId}: ${packageName}@${result.pack.version} abi=${result.pack.abi} ${result.pack.bytes}B`);
          break;
        } catch (error) {
          reasons.push(`${packageName}: ${error instanceof Error ? error.message : error}`);
        }
      }
      if (!recorded) {
        skipped[candidate.languageId] = reasons.join("; ") || "no candidate package succeeded";
        log(`skip ${candidate.languageId}: ${skipped[candidate.languageId]}`);
      }
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }

  const manifest = {
    generatedAt: "2026-09-07",
    minCompatibleAbi: runtime.min,
    maxCompatibleAbi: runtime.max,
    packs,
    skipped,
  };
  await fs.writeFile(destPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  log(`wrote ${destPath} (${Object.keys(packs).length} packs, ${Object.keys(skipped).length} skipped)`);
};

await main();
