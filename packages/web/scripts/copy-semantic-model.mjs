#!/usr/bin/env node
/**
 * Fetch the default MiniLM pack into the Host semantic runtime directory.
 * Weights are not checked in; the recipe is. Application Host builds invoke
 * this helper, and an existing marker lets subsequent builds reuse the pack.
 *
 *   bun run --cwd packages/web semantic:copy-model
 */
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
const files = [
  "tokenizer.json",
  "tokenizer_config.json",
  "config.json",
  "special_tokens_map.json",
  "onnx/model_quantized.onnx",
];
const SOURCE_MARKER_NAME = ".source-revision.json";

const log = (message) => process.stdout.write(`[copy-semantic-model] ${message}\n`);

const destinationFor = (name) => join(destDir, ...name.split("/"));
const recipePath = destinationFor("recipe.json");
const markerPath = destinationFor(SOURCE_MARKER_NAME);
const readRecipe = async () => {
  try {
    const recipe = JSON.parse(await readFile(recipePath, "utf8"));
    if (recipe?.schemaVersion !== 1 || !/^[0-9a-f]{40}$/iu.test(recipe?.modelRevision ?? "")) {
      throw new Error(`modelRevision must be a full pinned commit hash: ${recipe?.modelRevision ?? "missing"}`);
    }
    return recipe;
  } catch (error) {
    throw new Error(`Semantic model recipe is missing or invalid at ${recipePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
};
const markerMatchesRecipe = async (modelRevision) => {
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    const markerFiles = Array.isArray(marker?.files) ? marker.files : [];
    return marker?.schemaVersion === 1
      && marker?.revision === modelRevision
      && JSON.stringify([...markerFiles].sort()) === JSON.stringify([...files].sort());
  } catch {
    return false;
  }
};
const isCompleteFile = async (name) => {
  try {
    const details = await stat(destinationFor(name));
    return details.isFile() && details.size > 0;
  } catch {
    return false;
  }
};

const recipe = await readRecipe();
const modelRevision = recipe.modelRevision;
const base = `https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/${modelRevision}`;
await mkdir(destDir, { recursive: true });
const markerMatches = await markerMatchesRecipe(modelRevision);
const filesComplete = markerMatches
  && (await Promise.all(files.map(isCompleteFile))).every(Boolean);
const refreshRequired = !filesComplete;
if (refreshRequired) log(`refreshing pack for model revision ${modelRevision}`);
for (const name of files) {
  const url = `${base}/${name}`;
  const dest = destinationFor(name);
  if (filesComplete && await isCompleteFile(name)) {
    log(`reuse ${name}`);
    continue;
  }
  // Keep the upstream layout: transformers.js resolves weights as
  // `<pack>/onnx/<file>`, so flattening the path hides them (D-172).
  await mkdir(dirname(dest), { recursive: true });
  log(`fetch ${name}`);
  const temporary = `${dest}.${process.pid}.download`;
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    await rename(temporary, dest);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new Error(`Failed to download semantic model file ${name} from ${url}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
if (!(await Promise.all(files.map(isCompleteFile))).every(Boolean)) {
  throw new Error(`Semantic model pack is incomplete after download at ${destDir}`);
}
const markerTemporary = `${markerPath}.${process.pid}.tmp`;
try {
  await writeFile(markerTemporary, `${JSON.stringify({
    schemaVersion: 1,
    revision: modelRevision,
    files: [...files].sort(),
  }, null, 2)}\n`, "utf8");
  await rename(markerTemporary, markerPath);
} catch (error) {
  await rm(markerTemporary, { force: true }).catch(() => undefined);
  throw new Error(`Failed to record semantic model source marker at ${markerPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}
await writeFile(join(destDir, ".gitkeep"), "", "utf8");
log(`pack ready in ${destDir}`);
