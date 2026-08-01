import type { JsonValue } from "@piarium/protocol";

const DEFAULT_MAX_DEPTH = 20;

export function toJsonValue(value: unknown, maxDepth: number = DEFAULT_MAX_DEPTH): JsonValue {
  const seen = new WeakSet<object>();

  const visit = (current: unknown, depth: number): JsonValue => {
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "number") {
      return Number.isFinite(current) ? current : String(current);
    }
    if (typeof current === "bigint") return current.toString();
    if (current === undefined || typeof current === "function" || typeof current === "symbol") {
      return null;
    }
    if (depth >= maxDepth) return "[MaxDepth]";
    if (current instanceof Date) return current.toISOString();
    if (current instanceof Error) {
      return { message: current.message, name: current.name };
    }
    if (typeof current !== "object") return String(current);
    if (seen.has(current)) return "[Circular]";
    seen.add(current);
    try {
      if (Array.isArray(current)) return current.map((entry) => visit(entry, depth + 1));
      const result: Record<string, JsonValue> = {};
      for (const [key, entry] of Object.entries(current)) {
        if (entry !== undefined) result[key] = visit(entry, depth + 1);
      }
      return result;
    } finally {
      seen.delete(current);
    }
  };

  return visit(value, 0);
}
