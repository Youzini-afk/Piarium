import { isRecord } from "./validation.js";
export class PiariumContextExpressionError extends Error {
    issues;
    constructor(message, issues) {
        super(message);
        this.name = "PiariumContextExpressionError";
        this.issues = issues;
    }
}
const isContextValue = (value) => (typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value)));
// Reject extra fields on each expression variant (matches schema additionalProperties: false)
const checkNoExtraFields = (value, allowed, path, issues) => {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
            issues.push(`${path} has unexpected field '${key}'`);
        }
    }
};
/**
 * Parse a raw JSON value into a PiariumContextExpressionV1.
 * Throws PiariumContextExpressionError on invalid structure.
 */
export const parsePiariumContextExpression = (value) => {
    const issues = [];
    const result = parseExpression(value, "when", issues);
    if (issues.length > 0)
        throw new PiariumContextExpressionError("Invalid context expression", issues);
    return result;
};
const parseExpression = (value, path, issues) => {
    if (!isRecord(value)) {
        issues.push(`${path} must be an object with an op property`);
        return { op: "defined", key: "invalid" };
    }
    const op = typeof value.op === "string" ? value.op : undefined;
    if (!op) {
        issues.push(`${path}.op is required`);
        return { op: "defined", key: "invalid" };
    }
    switch (op) {
        case "defined": {
            checkNoExtraFields(value, ["op", "key"], path, issues);
            const key = typeof value.key === "string" ? value.key : undefined;
            if (!key) {
                issues.push(`${path}.key must be a non-empty string`);
                return { op: "defined", key: "invalid" };
            }
            return { op: "defined", key };
        }
        case "equals": {
            checkNoExtraFields(value, ["op", "key", "value"], path, issues);
            const key = typeof value.key === "string" ? value.key : undefined;
            if (!key) {
                issues.push(`${path}.key must be a non-empty string`);
                return { op: "defined", key: "invalid" };
            }
            if (!isContextValue(value.value)) {
                issues.push(`${path}.value must be a string, finite number, or boolean`);
                return { op: "defined", key };
            }
            return { op: "equals", key, value: value.value };
        }
        case "not": {
            checkNoExtraFields(value, ["op", "expression"], path, issues);
            if (value.expression === undefined) {
                issues.push(`${path}.expression is required`);
                return { op: "defined", key: "invalid" };
            }
            return { op: "not", expression: parseExpression(value.expression, `${path}.expression`, issues) };
        }
        case "all":
        case "any": {
            checkNoExtraFields(value, ["op", "expressions"], path, issues);
            if (!Array.isArray(value.expressions)) {
                issues.push(`${path}.expressions must be an array`);
                return { op, expressions: [] };
            }
            const expressions = value.expressions.map((item, index) => (parseExpression(item, `${path}.expressions[${index}]`, issues)));
            return { op, expressions };
        }
        default:
            issues.push(`${path}.op must be defined, equals, not, all, or any`);
            return { op: "defined", key: "invalid" };
    }
};
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
export const evaluatePiariumContextExpression = (expression, context) => {
    switch (expression.op) {
        case "defined":
            return context.has(expression.key);
        case "equals":
            return context.get(expression.key) === expression.value;
        case "not":
            return !evaluatePiariumContextExpression(expression.expression, context);
        case "all":
            return expression.expressions.every((inner) => evaluatePiariumContextExpression(inner, context));
        case "any":
            return expression.expressions.some((inner) => evaluatePiariumContextExpression(inner, context));
    }
};
/**
 * Collect all context keys referenced by an expression.
 * Useful for selective subscription notifications.
 */
export const collectPiariumContextExpressionKeys = (expression) => {
    const keys = new Set();
    const collect = (expr) => {
        switch (expr.op) {
            case "defined":
            case "equals":
                keys.add(expr.key);
                return;
            case "not":
                collect(expr.expression);
                return;
            case "all":
            case "any":
                for (const inner of expr.expressions)
                    collect(inner);
                return;
        }
    };
    collect(expression);
    return [...keys];
};
//# sourceMappingURL=context-expression.js.map