#!/usr/bin/env node
/**
 * Fetch the default MiniLM pack into the Host semantic runtime directory.
 * Weights are not checked in; the recipe is. Run before a desktop release.
 *
 *   bun run --cwd packages/web semantic:copy-model
 */
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const destDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "application-host",
  "lib",
  "knowledge",
  "semantic",
  "runtime",
  "all-minilm-l6-v2",
);
const base = "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main";
const files = [
  "tokenizer.json",
  "tokenizer_config.json",
  "config.json",
  "special_tokens_map.json",
  "onnx/model_quantized.onnx",
];

const log = (message) => process.stdout.write(`[copy-semantic-model] ${message}\n`);

await mkdir(destDir, { recursive: true });
for (const name of files) {
  const url = `${base}/${name}`;
  const dest = join(destDir, name === "onnx/model_quantized.onnx" ? "model_quantized.onnx" : name);
  await mkdir(dirname(dest), { recursive: true });
  log(`fetch ${name}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
}
await writeFile(join(destDir, ".gitkeep"), "", "utf8");
log(`pack ready in ${destDir}`);
