/**
 * Inclusive line count at or below which a syntax unit is emitted in full.
 *
 * 24 is one typical editor viewport: enough for a short function plus a few
 * locals, not enough to swallow a page-long handler. It is a working slice
 * threshold, not a hard reject and not a measured product limit (D-093).
 */
export const SMALL_STRUCTURE_SPAN_LINES = 24;
