/**
 * LSP navigation tools — symbols, definition, references, hover.
 *
 * Design: agent-harness.md §5.7
 * Plan: agent-harness-plan.md §3.8
 *
 * Four tools, each with three states: ready / empty / unavailable.
 * hover returns signature + documentation (cheapest path to check
 * a type/parameter).
 */

// ── Types ──────────────────────────────────────────────────────────

export type LspState = "ready" | "empty" | "unavailable";

export interface LspResult<T> {
  state: LspState;
  data?: T;
  message: string;
}

export interface SymbolEntry {
  name: string;
  kind: string;
  path: string;
  range: { startLine: number; startCharacter: number; endLine: number; endCharacter: number };
}

export interface DefinitionEntry {
  path: string;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface ReferenceEntry {
  path: string;
  line: number;
  character: number;
}

export interface HoverResult {
  signature: string;
  documentation?: string;
}

export interface LspNavDeps {
  /** Get workspace symbols matching query */
  symbols: (query: string) => Promise<SymbolEntry[] | null>;
  /** Get definition at position */
  definition: (path: string, line: number, character: number) => Promise<DefinitionEntry[] | null>;
  /** Get references at position */
  references: (path: string, line: number, character: number) => Promise<ReferenceEntry[] | null>;
  /** Get hover at position */
  hover: (path: string, line: number, character: number) => Promise<HoverResult | null>;
  /** Get language for a file path */
  getLanguage: (path: string) => string | null;
  /** Check if a language server is running for a language */
  isServerRunning: (language: string) => boolean;
}

// ── Tool implementations ───────────────────────────────────────────

export async function executeSymbols(
  query: string,
  deps: LspNavDeps,
): Promise<LspResult<SymbolEntry[]>> {
  const result = await deps.symbols(query);
  if (result === null) {
    return { state: "unavailable", message: "unavailable (no language server)" };
  }
  if (result.length === 0) {
    return { state: "empty", message: "no symbols found" };
  }
  const text = result.map((s) => `${s.path}:${s.range.startLine} — ${s.name} (${s.kind})`).join("\n");
  return { state: "ready", data: result, message: `${result.length} symbols\n${text}` };
}

export async function executeDefinition(
  path: string,
  line: number,
  character: number,
  deps: LspNavDeps,
): Promise<LspResult<DefinitionEntry[]>> {
  const lang = deps.getLanguage(path);
  if (!lang || !deps.isServerRunning(lang)) {
    return { state: "unavailable", message: `unavailable (no language server for ${lang ?? "unknown"})` };
  }
  const result = await deps.definition(path, line, character);
  if (result === null) {
    return { state: "unavailable", message: `unavailable (no language server for ${lang})` };
  }
  if (result.length === 0) {
    return { state: "empty", message: "no definition found" };
  }
  const text = result.map((d) => `${d.path}:${d.startLine}:${d.startCharacter}`).join("\n");
  return { state: "ready", data: result, message: text };
}

export async function executeReferences(
  path: string,
  line: number,
  character: number,
  deps: LspNavDeps,
): Promise<LspResult<ReferenceEntry[]>> {
  const lang = deps.getLanguage(path);
  if (!lang || !deps.isServerRunning(lang)) {
    return { state: "unavailable", message: `unavailable (no language server for ${lang ?? "unknown"})` };
  }
  const result = await deps.references(path, line, character);
  if (result === null) {
    return { state: "unavailable", message: `unavailable (no language server for ${lang})` };
  }
  if (result.length === 0) {
    return { state: "empty", message: "no references found" };
  }
  const text = result.map((r) => `${r.path}:${r.line}:${r.character}`).join("\n");
  return { state: "ready", data: result, message: `${result.length} references\n${text}` };
}

export async function executeHover(
  path: string,
  line: number,
  character: number,
  deps: LspNavDeps,
): Promise<LspResult<HoverResult>> {
  const lang = deps.getLanguage(path);
  if (!lang || !deps.isServerRunning(lang)) {
    return { state: "unavailable", message: `unavailable (no language server for ${lang ?? "unknown"})` };
  }
  const result = await deps.hover(path, line, character);
  if (result === null) {
    return { state: "unavailable", message: `unavailable (no language server for ${lang})` };
  }
  if (!result.signature) {
    return { state: "empty", message: "no hover information" };
  }
  const text = result.documentation
    ? `${result.signature}\n\n${result.documentation}`
    : result.signature;
  return { state: "ready", data: result, message: text };
}

export const HOVER_PROMPT_GUIDELINES = [
  "Use hover to check a signature or type before reading the whole definition file.",
];
