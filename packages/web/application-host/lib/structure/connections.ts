/**
 * Connection-edge shape recognition for literal-call captures (plan 3.11 step 4).
 *
 * A confirmed connection is a callee on the allowlist plus a string literal.
 * Any other same-string call is an association candidate, not a fact. Consumers
 * must keep those two classes distinct (plan 0.4).
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
