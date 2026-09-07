/**
 * Repeatable catalog-query measurement for the symbol graph.
 *
 * Not part of the default test suite. Run with:
 *
 *   bun run --cwd packages/web symbol-graph-query
 *
 * Prints one JSON object to stdout. Progress goes to stderr. Does not claim a
 * speedup. Uses `git ls-files` plus the same tree-sitter queries and
 * `replaceFileSymbols` path as the collector. It does not walk the tree with
 * `searchFilesystemFiles` (that path spawns `git check-ignore` per directory
 * and stalled for 11+ minutes at ~0 CPU on this machine).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { languageIdForPath } from "../application-host/lib/harness/language-id.js";
import { openWorkspaceKnowledge, type SymbolGraphLinkInput } from "../application-host/lib/knowledge/store.js";
import { classifyLiteralCall } from "../application-host/lib/structure/connections.js";
import { CATALOG_SCAN_LANGUAGES } from "../application-host/lib/structure/languages.js";
import { createStructureSource } from "../application-host/lib/structure/source.js";
import { createTreeSitterStructureProvider } from "../application-host/lib/structure/tree-sitter-provider.js";
import type { StructureSymbol } from "../application-host/lib/structure/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

const flattenOutline = (symbols: readonly StructureSymbol[], lineLengths: readonly number[]) => {
  const result: Array<{ name: string; kind: string; range: { startLine: number; startCharacter: number; endLine: number; endCharacter: number } }> = [];
  const visit = (symbol: StructureSymbol): void => {
    if (symbol.name.trim()) {
      const startLine = Math.max(0, symbol.range.startLine - 1);
      const endLine = Math.max(startLine, symbol.range.endLine - 1);
      result.push({
        name: symbol.name,
        kind: symbol.kind,
        range: {
          startLine,
          startCharacter: 0,
          endLine,
          endCharacter: lineLengths[endLine] ?? 0,
        },
      });
    }
    for (const child of symbol.children ?? []) visit(child);
  };
  for (const symbol of symbols) visit(symbol);
  return result;
};

const catalogFiles = (): string[] => {
  const listed = spawnSync("git", ["ls-files", "--", "*.ts", "*.tsx", "*.js", "*.jsx", "*.mts", "*.cts", "*.mjs", "*.cjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr || listed.status}`);
  }
  return listed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, "/"))
    .filter((line) => line.length > 0 && CATALOG_SCAN_LANGUAGES.has(languageIdForPath(line) ?? ""));
};

const main = async (): Promise<void> => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-symbol-graph-query-"));
  const store = await openWorkspaceKnowledge({
    dataDir,
    hostId: "symbol-graph-query-host",
    workspaceId: "measurement",
    embedding: null,
  });
  const source = createStructureSource([createTreeSitterStructureProvider()]);
  const files = catalogFiles();
  process.stderr.write(`catalog files (git ls-files ∩ CATALOG_SCAN_LANGUAGES): ${files.length}\n`);
  const scanStarted = performance.now();
  let parsed = 0;
  let parseFailed = 0;
  const revisit: string[] = [];
  const collect = async (relativePath: string, pass: "first" | "revisit"): Promise<void> => {
    const languageId = languageIdForPath(relativePath);
    if (!languageId) return;
    const absolute = path.join(repoRoot, relativePath);
    let text: string;
    try {
      text = await fs.readFile(absolute, "utf8");
    } catch {
      parseFailed += 1;
      return;
    }
    const revision = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const request = { path: relativePath, languageId, text, revision };
    const [outline, importsResult, callsResult] = await Promise.all([
      source.outline(request),
      source.imports(request),
      source.literalCalls(request),
    ]);
    if (outline.status !== "ready" && outline.status !== "empty") {
      parseFailed += 1;
      return;
    }
    const lineLengths = text.split(/\r\n|\n|\r/).map((line) => line.length);
    const symbols = flattenOutline(outline.symbols, lineLengths);
    const links: SymbolGraphLinkInput[] = [];
    if (importsResult.status === "ready") {
      for (const item of importsResult.imports) {
        if (item.source.trim() && Number.isSafeInteger(item.line) && item.line >= 1) {
          links.push({ kind: "import", value: item.source, line: item.line });
        }
      }
    }
    let suppressed = false;
    if (callsResult.status === "ready") {
      const usable = callsResult.calls.filter((call) => (
        classifyLiteralCall(call) !== null && Number.isSafeInteger(call.line) && call.line >= 1
      ));
      const localConnections = new Set(usable
        .filter((call) => classifyLiteralCall(call) === "connects")
        .map((call) => call.literal));
      const unresolved = [...new Set(usable
        .filter((call) => classifyLiteralCall(call) === "associates")
        .map((call) => call.literal)
        .filter((literal) => !localConnections.has(literal)))];
      const known = unresolved.length > 0 ? await store.connectionLiterals(unresolved) : new Set<string>();
      for (const call of usable) {
        const classified = classifyLiteralCall(call)!;
        if (classified === "associates" && !localConnections.has(call.literal) && !known.has(call.literal)) {
          suppressed = true;
          continue;
        }
        links.push({ kind: classified, value: call.literal, line: call.line, callee: call.name });
      }
    }
    if (suppressed && pass === "first") revisit.push(relativePath);
    const linksIncomplete = !(
      (importsResult.status === "ready" || importsResult.status === "empty" || importsResult.status === "unsupported")
      && (callsResult.status === "ready" || callsResult.status === "empty" || callsResult.status === "unsupported")
    );
    await store.replaceFileSymbols(
      relativePath,
      languageId,
      symbols,
      revision,
      links,
      { ...(linksIncomplete ? { linksIncomplete: true } : {}) },
    );
    parsed += 1;
    if (parsed % 50 === 0) {
      process.stderr.write(`parsed ${parsed}/${files.length} (failed ${parseFailed}, revisit ${revisit.length})\n`);
    }
  };
  for (const relativePath of files) await collect(relativePath, "first");
  const uniqueRevisit = [...new Set(revisit)];
  process.stderr.write(`first pass done; revisiting ${uniqueRevisit.length} gated files\n`);
  for (const relativePath of uniqueRevisit) await collect(relativePath, "revisit");
  const catalogBuildMs = performance.now() - scanStarted;
  const stats = await store.catalogStats();
  const searchStarted = performance.now();
  const symbols = await store.searchSymbols("explore", 20);
  const searchSymbolsMs = performance.now() - searchStarted;
  const linksStarted = performance.now();
  const links = await store.findLinks("explore.search");
  const findLinksMs = performance.now() - linksStarted;
  const explorePath = stats.paths.find((item) => item.endsWith("explore.ts") && item.includes("harness")) ?? stats.paths[0] ?? "";
  const importersStarted = performance.now();
  const importers = explorePath ? await store.findImporters(explorePath) : { resolved: [] };
  const findImportersMs = performance.now() - importersStarted;
  process.stdout.write(`${JSON.stringify({
    catalogBuildMs: Number(catalogBuildMs.toFixed(1)),
    searchSymbolsMs: Number(searchSymbolsMs.toFixed(3)),
    findLinksMs: Number(findLinksMs.toFixed(3)),
    findImportersMs: Number(findImportersMs.toFixed(3)),
    catalogFileCount: files.length,
    parsedFileCount: parsed,
    parseFailed,
    revisitCount: uniqueRevisit.length,
    symbolCount: stats.symbolCount,
    fileCount: stats.fileCount,
    linkCount: stats.linkCount,
    languages: stats.languages,
    searchHitCount: symbols.length,
    searchMatchTiers: Object.fromEntries(
      ["exact", "name-contains", "path-contains"].map((tier) => [tier, symbols.filter((item) => item.match === tier).length]),
    ),
    linkHitCount: links.length,
    importerCount: importers.resolved.length,
    explorePath,
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      model: os.cpus()[0]?.model ?? null,
      totalmemMiB: Math.round(os.totalmem() / (1024 * 1024)),
      node: process.version,
    },
    method: "git ls-files of this repository ∩ CATALOG_SCAN_LANGUAGES, then tree-sitter outline/imports/literalCalls + replaceFileSymbols (same associate gate and one revisit pass as the collector). Queries: one searchSymbols('explore', 20), one findLinks('explore.search'), one findImporters of harness explore.ts. Clock is process performance.now(). Not a speedup claim. Did not use scanWorkspace/searchFilesystemFiles: that walk spawns git check-ignore per directory and stalled here for 11+ minutes at ~0 CPU.",
  }, null, 2)}\n`);
  await store.close();
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }).catch(() => undefined);
};

await main();
