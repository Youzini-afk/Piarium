/**
 * Connection-edge shape recognition for literal-call captures (plan 3.11 step 4).
 *
 * A confirmed connection is a callee on the allowlist plus a string literal.
 * Any other string-literal call is only a *potential* association candidate:
 * plan 3.11 requires the literal to be a same-name string, which this module
 * cannot know on its own. The knowledge runtime applies that second gate
 * against the graph's confirmed connection values (D-109). Consumers must keep
 * the two classes distinct (plan 0.4).
 */

export const CONFIRMED_CONNECTION_CALLEES = Object.freeze(new Set([
  "request",
  "register",
  "on",
  "once",
  "emit",
  "subscribe",
  "addEventListener",
]));

/** Owned by the import query; do not also emit as a call edge. */
const IMPORT_CALLEES = new Set(["require", "import"]);

export type LiteralCallClass = "connects" | "associates";

export function classifyLiteralCall(input: {
  name: string;
  literal: string;
}): LiteralCallClass | null {
  const name = input.name.trim();
  const literal = input.literal;
  if (!name || !literal || IMPORT_CALLEES.has(name)) return null;
  return CONFIRMED_CONNECTION_CALLEES.has(name) ? "connects" : "associates";
}
