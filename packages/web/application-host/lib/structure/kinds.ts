/** LSP SymbolKind numeric values, named for outline consumers. */
const LSP_SYMBOL_KIND: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum-member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type-parameter",
};

export function structureKindFromLsp(kind: unknown): string {
  if (typeof kind === "number" && LSP_SYMBOL_KIND[kind]) return LSP_SYMBOL_KIND[kind]!;
  if (typeof kind === "string" && kind.trim()) return kind.trim().toLowerCase();
  return "unknown";
}

export function structureSpanLines(startLine: number, endLine: number): number {
  return Math.max(0, endLine - startLine + 1);
}
