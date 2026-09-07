#!/usr/bin/env node
/**
 * Place the pinned tree-sitter runtime and TS/TSX grammar wasm next to the
 * Host structure module. Grammars come from the pinned tree-sitter-typescript
 * package (ABI-compatible with web-tree-sitter 0.27). Do not pull the
 * tree-sitter-wasms 0.1.13 pack — those artifacts lack dylink.0.
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

const webTreeSitterWasm = fileURLToPath(import.meta.resolve("web-tree-sitter/web-tree-sitter.wasm"));
copyIfNeeded(webTreeSitterWasm, "web-tree-sitter.wasm");

const grammarRoot = path.dirname(require.resolve("tree-sitter-typescript/package.json"));
copyIfNeeded(path.join(grammarRoot, "tree-sitter-typescript.wasm"), "tree-sitter-typescript.wasm");
copyIfNeeded(path.join(grammarRoot, "tree-sitter-tsx.wasm"), "tree-sitter-tsx.wasm");

log(`runtime assets ready in ${destDir}`);
