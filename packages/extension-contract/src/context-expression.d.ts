import type { PiariumContextExpressionV1, PiariumContextValue } from "./types.js";
export type { PiariumContextExpressionV1, PiariumContextValue };
export declare class PiariumContextExpressionError extends Error {
    readonly issues: string[];
    constructor(message: string, issues: string[]);
}
/**
 * Parse a raw JSON value into a PiariumContextExpressionV1.
 * Throws PiariumContextExpressionError on invalid structure.
 */
export declare const parsePiariumContextExpression: (value: unknown) => PiariumContextExpressionV1;
/**
 * Evaluate a context expression against a context key-value map.
 * Pure function — does not throw.
 *
 * Semantics:
 * - defined: true when the key exists in the context
 * - equals: true when the key exists and its value strictly equals the declared value
 * - not: negation of the inner expression
 * - all: true when every expression is true (empty array is true)
 * - any: true when at least one expression is true (empty array is false)
 */
export declare const evaluatePiariumContextExpression: (expression: PiariumContextExpressionV1, context: ReadonlyMap<string, PiariumContextValue>) => boolean;
/**
 * Collect all context keys referenced by an expression.
 * Useful for selective subscription notifications.
 */
export declare const collectPiariumContextExpressionKeys: (expression: PiariumContextExpressionV1) => string[];
//# sourceMappingURL=context-expression.d.ts.map