/**
 * Inclusive line count at or below which a syntax unit is emitted in full.
 *
 * 24 is one typical editor viewport: enough for a short function plus a few
 * locals, not enough to swallow a page-long handler. It is a working slice
 * threshold, not a hard reject and not a measured product limit (D-093).
 */
export const SMALL_STRUCTURE_SPAN_LINES = 24;

/**
 * After a file is materialized, window scoring may add these terms so a hit on
 * a declaration name outranks the same token in a comment or string (D-095).
 * Candidate ranking before readFile is unchanged.
 */
export const STRUCTURE_HIT_CLASS_SCORE = {
  name: 30,
  body: 8,
  string: -4,
  comment: -10,
} as const;

/**
 * Runaway guard for one tree-sitter outline or classify call after the runtime
 * wasm is already loaded. Init and grammar load are outside this window; their
 * failure is `unavailable`, not a budget miss.
 *
 * This is a wall clock, so it competes with everything else on the box. A
 * value near the parse time of an ordinary file turns a busy Host into silent
 * `failed` and drops slicing back to ±3 windows; it also makes the tests that
 * assert a real parse depend on machine load. Keep enough headroom that only a
 * pathological file trips it, and inject an explicit budget in tests that
 * assert either outcome (D-102).
 */
export const STRUCTURE_PARSE_BUDGET_MS = 250;
