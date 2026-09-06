import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { languageIdForPath } from "@piarium/protocol";
import { LANGUAGE_VERSION, Language, MIN_COMPATIBLE_VERSION, Parser, Query, type Node } from "web-tree-sitter";
import { STRUCTURE_PARSE_BUDGET_MS } from "./constants.js";
import {
  TYPESCRIPT_DEFINITION_QUERY,
  TYPESCRIPT_IMPORT_QUERY,
  TYPESCRIPT_LITERAL_CALL_QUERY,
} from "./queries.js";
import { resolveStructureRuntimeFile } from "./runtime-path.js";
import {
  NO_STRUCTURE_CAPABILITIES,
  type StructureCapabilities,
  type StructureClassifyRequest,
  type StructureClassifyResult,
  type StructureHitClass,
  type StructureImport,
  type StructureImportsResult,
  type StructureLiteralCall,
  type StructureLiteralCallsResult,
  type StructureOutlineRequest,
  type StructureOutlineResult,
  type StructureProvider,
  type StructureSymbol,
} from "./types.js";

export interface TreeSitterStructureProviderOptions {
  runtimeFromUrl?: string;
  parseBudgetMs?: number;
  pathExists?: (candidate: string) => boolean;
}

const TREE_SITTER_LANGUAGES = new Set(["typescript", "typescriptreact"]);

const GRAMMAR_FILE: Record<string, string> = {
  typescript: "tree-sitter-typescript.wasm",
  typescriptreact: "tree-sitter-tsx.wasm",
};

const kindForType = (type: string): string => {
  if (type.includes("function") || type === "method_definition" || type === "method_signature") return "function";
  if (type.includes("class")) return "class";
  if (type.includes("interface")) return "interface";
  if (type.includes("enum")) return "enum";
  if (type.includes("type_alias")) return "type";
  return "variable";
};

const contentHash = (text: string): string => createHash("sha256").update(text).digest("hex");

const pointToLines = (start: { row: number; column: number }, end: { row: number; column: number }) => {
  const startLine = start.row + 1;
  const endLine = end.column === 0 && end.row > start.row ? end.row : end.row + 1;
  return { startLine, endLine: Math.max(startLine, endLine) };
};

const capabilitiesFor = (languageId: string | null): StructureCapabilities => (
  languageId && TREE_SITTER_LANGUAGES.has(languageId)
    ? { outline: true, classifyHits: true, literalCalls: true, imports: true }
    : NO_STRUCTURE_CAPABILITIES
);

interface ParsedCache {
  hash: string;
  languageId: string;
  tree: import("web-tree-sitter").Tree;
  language: Language;
  symbols: StructureSymbol[];
  nameLines: Set<number>;
}

const COMMENT_TYPES = new Set(["comment", "html_comment"]);
const STRING_TYPES = new Set(["string", "template_string", "string_fragment", "escape_sequence"]);

export function createTreeSitterStructureProvider(
  options: TreeSitterStructureProviderOptions = {},
): StructureProvider {
  const parseBudgetMs = options.parseBudgetMs ?? STRUCTURE_PARSE_BUDGET_MS;
  const pathExists = options.pathExists ?? existsSync;
  const fromUrl = options.runtimeFromUrl;
  const cache = new Map<string, ParsedCache>();
  let initPromise: Promise<void> | null = null;
  const languages = new Map<string, Promise<Language>>();

  const runtimeFile = (name: string): string => (
    resolveStructureRuntimeFile(name, fromUrl ?? import.meta.url, pathExists)
  );

  const ensureRuntime = (): { status: "ok" } | { status: "unavailable"; message: string } => {
    const runtime = runtimeFile("web-tree-sitter.wasm");
    if (!pathExists(runtime)) {
      return { status: "unavailable", message: "tree-sitter runtime wasm is not readable." };
    }
    return { status: "ok" };
  };

  const initParser = async (): Promise<void> => {
    if (!initPromise) {
      initPromise = Parser.init({
        locateFile: (scriptName: string) => runtimeFile(scriptName.endsWith(".wasm") ? scriptName : "web-tree-sitter.wasm"),
      }).catch((error: unknown) => {
        initPromise = null;
        throw error;
      });
    }
    await initPromise;
  };

  const loadLanguage = (languageId: string): Promise<Language> => {
    const existing = languages.get(languageId);
    if (existing) return existing;
    const fileName = GRAMMAR_FILE[languageId];
    const loading = (async () => {
      const grammarPath = runtimeFile(fileName!);
      if (!pathExists(grammarPath)) {
        throw new Error(`Grammar wasm is not readable: ${fileName}`);
      }
      const language = await Language.load(grammarPath);
      if (language.abiVersion < MIN_COMPATIBLE_VERSION || language.abiVersion > LANGUAGE_VERSION) {
        throw new Error(
          `Grammar ABI ${language.abiVersion} is locked out of this application (compatible ${MIN_COMPATIBLE_VERSION}-${LANGUAGE_VERSION}).`,
        );
      }
      return language;
    })();
    languages.set(languageId, loading);
    void loading.catch(() => {
      if (languages.get(languageId) === loading) languages.delete(languageId);
    });
    return loading;
  };

  const parseDocument = async (
    request: StructureOutlineRequest,
    languageId: string,
  ): Promise<
    | { status: "ready"; entry: ParsedCache }
    | { status: "cancelled" | "failed" | "unavailable"; message: string }
  > => {
    if (request.signal?.aborted) return { status: "cancelled", message: "Structure request was cancelled." };
    try {
    const runtime = ensureRuntime();
    if (runtime.status !== "ok") return runtime;
    const hash = contentHash(request.text);
    const cacheKey = `${languageId}:${hash}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.languageId === languageId) {
      if (!pathExists(runtimeFile("web-tree-sitter.wasm")) || !pathExists(runtimeFile(GRAMMAR_FILE[languageId]!))) {
        return { status: "unavailable", message: "Grammar wasm is not readable." };
      }
      return { status: "ready", entry: cached };
    }
      await initParser();
      if (request.signal?.aborted) return { status: "cancelled", message: "Structure request was cancelled." };
      const language = await loadLanguage(languageId);
      if (request.signal?.aborted) return { status: "cancelled", message: "Structure request was cancelled." };
      const started = performance.now();
      const parser = new Parser();
      parser.setLanguage(language);
      let stopReason: "cancelled" | "budget" | undefined;
      const tree = parser.parse(request.text, undefined, {
        progressCallback: () => {
          if (request.signal?.aborted) {
            stopReason = "cancelled";
            return true;
          }
          if (performance.now() - started > parseBudgetMs) {
            stopReason = "budget";
            return true;
          }
          return false;
        },
      });
      parser.delete();
      if (!tree) {
        if (stopReason === "cancelled" || request.signal?.aborted) {
          return { status: "cancelled", message: "Structure request was cancelled." };
        }
        if (stopReason === "budget") {
          return { status: "failed", message: "Parse budget exhausted before the file was finished." };
        }
        return { status: "failed", message: "tree-sitter returned no tree." };
      }
      if (request.signal?.aborted) {
        tree.delete();
        return { status: "cancelled", message: "Structure request was cancelled." };
      }
      if (performance.now() - started > parseBudgetMs) {
        tree.delete();
        return { status: "failed", message: "Parse budget exhausted before the file was finished." };
      }
      const definitionQuery = new Query(language, TYPESCRIPT_DEFINITION_QUERY);
      const matches = definitionQuery.matches(tree.rootNode);
      definitionQuery.delete();
      if (request.signal?.aborted) {
        tree.delete();
        return { status: "cancelled", message: "Structure request was cancelled." };
      }
      if (performance.now() - started > parseBudgetMs) {
        tree.delete();
        return { status: "failed", message: "Parse budget exhausted before the file was finished." };
      }
      const symbols: StructureSymbol[] = [];
      const nameLines = new Set<number>();
      for (const match of matches) {
        const unit = match.captures.find((capture) => capture.name === "unit")?.node;
        const name = match.captures.find((capture) => capture.name === "name")?.node;
        if (!unit || !name) continue;
        const range = pointToLines(unit.startPosition, unit.endPosition);
        const signature = pointToLines(name.startPosition, name.endPosition);
        nameLines.add(signature.startLine);
        symbols.push({
          name: name.text,
          kind: kindForType(unit.type),
          range,
          signature: {
            startLine: Math.max(range.startLine, signature.startLine),
            endLine: Math.min(range.endLine, signature.endLine),
          },
        });
      }
      const entry: ParsedCache = { hash, languageId, tree, language, symbols, nameLines };
      cache.set(cacheKey, entry);
      if (cache.size > 32) {
        const first = cache.keys().next().value;
        if (first && first !== cacheKey) {
          cache.get(first)?.tree.delete();
          cache.delete(first);
        }
      }
      return { status: "ready", entry };
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : error instanceof Error
          ? (error.stack ?? "tree-sitter failed to load.")
          : String(error);
      if (message === "cancelled" || request.signal?.aborted) {
        return { status: "cancelled", message: "Structure request was cancelled." };
      }
      if (message === "budget" || message.includes("budget")) {
        return { status: "failed", message: "Parse budget exhausted before the file was finished." };
      }
      return { status: "unavailable", message: message || "tree-sitter failed to load." };
    }
  };

  const nodeTouchesLine = (node: Node, zeroLine: number): boolean => (
    node.startPosition.row <= zeroLine && node.endPosition.row >= zeroLine
  );

  const lineHasType = (node: Node, zeroLine: number, types: Set<string>): boolean => {
    if (!nodeTouchesLine(node, zeroLine)) return false;
    if (types.has(node.type)) return true;
    return node.children.some((child) => lineHasType(child, zeroLine, types));
  };

  const classifyLine = (entry: ParsedCache, line: number): StructureHitClass => {
    const zeroLine = line - 1;
    const root = entry.tree.rootNode;
    if (lineHasType(root, zeroLine, COMMENT_TYPES)) return "comment";
    if (entry.nameLines.has(line)) return "name";
    if (lineHasType(root, zeroLine, STRING_TYPES)) return "string";
    return "body";
  };

  return {
    id: "tree-sitter",
    capabilities(languageId) {
      return capabilitiesFor(languageId);
    },
    async outline(request): Promise<StructureOutlineResult> {
      const languageId = request.languageId ?? languageIdForPath(request.path);
      if (!languageId || !TREE_SITTER_LANGUAGES.has(languageId)) {
        return { status: "unsupported", provider: "tree-sitter", revision: request.revision, symbols: [], message: "tree-sitter outline is only wired for typescript/tsx." };
      }
      const parsed = await parseDocument(request, languageId);
      if (parsed.status !== "ready") {
        return { status: parsed.status, provider: "tree-sitter", revision: request.revision, symbols: [], message: parsed.message };
      }
      return {
        status: parsed.entry.symbols.length > 0 ? "ready" : "empty",
        provider: "tree-sitter",
        revision: request.revision,
        symbols: parsed.entry.symbols,
      };
    },
    async classifyHits(request: StructureClassifyRequest): Promise<StructureClassifyResult> {
      const languageId = request.languageId ?? languageIdForPath(request.path);
      if (!languageId || !TREE_SITTER_LANGUAGES.has(languageId)) {
        return { status: "unsupported", provider: "tree-sitter", revision: request.revision, hits: [], message: "Hit classification is only wired for typescript/tsx." };
      }
      const parsed = await parseDocument(request, languageId);
      if (parsed.status !== "ready") {
        return { status: parsed.status, provider: "tree-sitter", revision: request.revision, hits: [], message: parsed.message };
      }
      return {
        status: "ready",
        provider: "tree-sitter",
        revision: request.revision,
        hits: request.lines.map((line) => ({ line, class: classifyLine(parsed.entry, line) })),
      };
    },
    async literalCalls(request: StructureOutlineRequest): Promise<StructureLiteralCallsResult> {
      const languageId = request.languageId ?? languageIdForPath(request.path);
      if (!languageId || !TREE_SITTER_LANGUAGES.has(languageId)) {
        return { status: "unsupported", provider: "tree-sitter", revision: request.revision, calls: [], message: "Literal-call extraction is only wired for typescript/tsx." };
      }
      const parsed = await parseDocument(request, languageId);
      if (parsed.status !== "ready") {
        return { status: parsed.status, provider: "tree-sitter", revision: request.revision, calls: [], message: parsed.message };
      }
      const query = new Query(parsed.entry.language, TYPESCRIPT_LITERAL_CALL_QUERY);
      const calls: StructureLiteralCall[] = [];
      for (const match of query.matches(parsed.entry.tree.rootNode)) {
        const fn = match.captures.find((capture) => capture.name === "fn")?.node;
        const literal = match.captures.find((capture) => capture.name === "literal")?.node;
        if (!fn || !literal) continue;
        calls.push({ name: fn.text, literal: literal.text.slice(1, -1), line: literal.startPosition.row + 1 });
      }
      query.delete();
      return { status: "ready", provider: "tree-sitter", revision: request.revision, calls };
    },
    async imports(request: StructureOutlineRequest): Promise<StructureImportsResult> {
      const languageId = request.languageId ?? languageIdForPath(request.path);
      if (!languageId || !TREE_SITTER_LANGUAGES.has(languageId)) {
        return { status: "unsupported", provider: "tree-sitter", revision: request.revision, imports: [], message: "Import extraction is only wired for typescript/tsx." };
      }
      const parsed = await parseDocument(request, languageId);
      if (parsed.status !== "ready") {
        return { status: parsed.status, provider: "tree-sitter", revision: request.revision, imports: [], message: parsed.message };
      }
      const query = new Query(parsed.entry.language, TYPESCRIPT_IMPORT_QUERY);
      const imports: StructureImport[] = [];
      for (const match of query.matches(parsed.entry.tree.rootNode)) {
        const source = match.captures.find((capture) => capture.name === "source")?.node;
        if (!source) continue;
        imports.push({ source: source.text.slice(1, -1), line: source.startPosition.row + 1 });
      }
      query.delete();
      return { status: "ready", provider: "tree-sitter", revision: request.revision, imports };
    },
  };
}
