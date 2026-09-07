import type { Node } from "web-tree-sitter";
import type { StructureLineRange, StructureSymbol } from "./types.js";

const pointToLines = (start: { row: number; column: number }, end: { row: number; column: number }): StructureLineRange => {
  const startLine = start.row + 1;
  const endLine = end.column === 0 && end.row > start.row ? end.row : end.row + 1;
  return { startLine, endLine: Math.max(startLine, endLine) };
};

const unquote = (text: string): string => (
  text.length >= 2 && (text.startsWith("\"") || text.startsWith("'")) ? text.slice(1, -1) : text
);

const isTopLevelPair = (node: Node): boolean => {
  const parent = node.parent;
  const grand = parent?.parent;
  return parent?.type === "object" && grand?.type === "document";
};

const documentValue = (root: Node): Node | null => {
  if (root.type === "object" || root.type === "array") return root;
  return root.namedChildren.find((child) => child.type === "object" || child.type === "array") ?? null;
};

export function collectJsonOutline(
  root: Node,
  limits: { maxDepth: number; maxSymbols: number },
): { symbols: StructureSymbol[]; nameLines: Set<number> } {
  const symbols: StructureSymbol[] = [];
  const nameLines = new Set<number>();
  const seen = new Set<string>();

  const push = (name: string, kind: string, unit: Node, signature: Node): boolean => {
    if (symbols.length >= limits.maxSymbols) return false;
    const range = pointToLines(unit.startPosition, unit.endPosition);
    const sig = pointToLines(signature.startPosition, signature.endPosition);
    const key = `${kind}:${name}:${range.startLine}:${range.endLine}`;
    if (seen.has(key)) return true;
    seen.add(key);
    symbols.push({
      name,
      kind,
      range,
      signature: {
        startLine: Math.max(range.startLine, sig.startLine),
        endLine: Math.min(range.endLine, sig.endLine),
      },
    });
    return symbols.length < limits.maxSymbols;
  };

  const walkValue = (node: Node, depth: number): boolean => {
    if (depth > limits.maxDepth) return true;
    if (node.type === "object") {
      for (const child of node.namedChildren) {
        if (child.type === "pair" && !walkPair(child, depth)) return false;
      }
      return true;
    }
    if (node.type === "array") {
      let index = 0;
      for (const child of node.namedChildren) {
        if (child.type === "object" || child.type === "array") {
          if (depth + 1 > limits.maxDepth) {
            index += 1;
            continue;
          }
          if (!push(`[${index}]`, child.type, child, child)) return false;
          if (!walkValue(child, depth + 1)) return false;
        }
        index += 1;
      }
    }
    return true;
  };

  const walkPair = (pair: Node, depth: number): boolean => {
    const key = pair.childForFieldName("key");
    const value = pair.childForFieldName("value");
    if (key) nameLines.add(key.startPosition.row + 1);
    const valueType = value?.type;
    const include = isTopLevelPair(pair) || valueType === "object" || valueType === "array";
    const pairName = key ? unquote(key.text) : "property";
    if (include && depth <= limits.maxDepth) {
      if (!push(pairName, "property", pair, key ?? pair)) return false;
    }
    if (value && (valueType === "object" || valueType === "array") && depth < limits.maxDepth) {
      if (!push(pairName, valueType, value, key ?? value)) return false;
      if (!walkValue(value, depth + 1)) return false;
    }
    return true;
  };

  const value = documentValue(root);
  if (!value) return { symbols, nameLines };
  if (!push("$", value.type, value, value)) return { symbols, nameLines };
  walkValue(value, 0);
  return { symbols, nameLines };
}
