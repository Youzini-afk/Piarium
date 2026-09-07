#!/usr/bin/env node
/**
 * Place the pinned tree-sitter runtime and grammar wasm next to the Host
 * structure module. Grammars come from the pinned npm packages (ABI-compatible
 * with web-tree-sitter 0.27). Do not pull the tree-sitter-wasms 0.1.13 pack —
 * those artifacts lack dylink.0.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destDir = path.join(webRoot, "application-host", "lib", "structure", "runtime");
const force = process.argv.includes("--force");
// Checked-in wasm in destDir is the source of truth (D-101). This script
// skips existing files larger than 1 KiB; pass --force to refresh from npm.

const log = (message) => process.stdout.write(`[copy-structure-runtime] ${message}\n`);

fs.mkdirSync(destDir, { recursive: true });

const copyIfNeeded = (source, destName) => {
  const dest = path.join(destDir, destName);
  if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
    log(`keep ${destName}`);
    return;
  }
  if (!fs.existsSync(source)) {
    throw new Error(`Missing structure runtime source: ${source}`);
  }
  fs.copyFileSync(source, dest);
  log(`copied ${destName} from ${source} (${fs.statSync(dest).size} bytes)`);
};

const packageRoot = (name) => path.dirname(require.resolve(`${name}/package.json`));

const webTreeSitterWasm = fileURLToPath(import.meta.resolve("web-tree-sitter/web-tree-sitter.wasm"));
copyIfNeeded(webTreeSitterWasm, "web-tree-sitter.wasm");

const typescriptRoot = packageRoot("tree-sitter-typescript");
copyIfNeeded(path.join(typescriptRoot, "tree-sitter-typescript.wasm"), "tree-sitter-typescript.wasm");
copyIfNeeded(path.join(typescriptRoot, "tree-sitter-tsx.wasm"), "tree-sitter-tsx.wasm");

const javascriptRoot = packageRoot("tree-sitter-javascript");
copyIfNeeded(path.join(javascriptRoot, "tree-sitter-javascript.wasm"), "tree-sitter-javascript.wasm");

const jsonRoot = packageRoot("tree-sitter-json");
copyIfNeeded(path.join(jsonRoot, "tree-sitter-json.wasm"), "tree-sitter-json.wasm");

log(`runtime assets ready in ${destDir}`);
