export const PIARIUM_SESSION_FEATURES_SCHEMA_VERSION = 1;
export class PiSessionFeatureValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "PiSessionFeatureValidationError";
    }
}
const GOAL_STATUSES = [
    "active",
    "paused",
    "blocked",
    "budgetLimited",
    "complete",
];
function record(value, label) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new PiSessionFeatureValidationError(`${label} must be an object`);
    }
    return value;
}
function stringValue(source, key, options = {}) {
    const value = source[key];
    if (value === undefined && options.optional)
        return undefined;
    if (typeof value !== "string" || (!options.allowEmpty && value.trim().length === 0)) {
        throw new PiSessionFeatureValidationError(`${key} must be a string`);
    }
    return value;
}
function integerValue(source, key, options = {}) {
    const value = source[key];
    if (value === undefined && options.optional)
        return undefined;
    if (!Number.isSafeInteger(value)
        || (options.positive ? Number(value) <= 0 : Number(value) < 0)) {
        throw new PiSessionFeatureValidationError(`${key} must be a ${options.positive ? "positive" : "non-negative"} integer`);
    }
    return value;
}
function optionalStringField(source, key) {
    const value = stringValue(source, key, { allowEmpty: true, optional: true });
    return value === undefined ? {} : { [key]: value };
}
function optionalIntegerField(source, key) {
    const value = integerValue(source, key, { optional: true });
    return value === undefined ? {} : { [key]: value };
}
export function parsePiSessionFeatureMutation(value) {
    const source = record(value, "mutation");
    const type = stringValue(source, "type");
    switch (type) {
        case "goal.start": {
            const tokenBudget = integerValue(source, "tokenBudget", { optional: true, positive: true });
            return {
                objective: stringValue(source, "objective"),
                ...(tokenBudget === undefined ? {} : { tokenBudget }),
                type,
            };
        }
        case "goal.update": {
            const statusValue = stringValue(source, "status", { optional: true });
            if (statusValue !== undefined && !GOAL_STATUSES.includes(statusValue)) {
                throw new PiSessionFeatureValidationError(`status must be one of: ${GOAL_STATUSES.join(", ")}`);
            }
            const mutation = {
                ...optionalIntegerField(source, "auditFailStreak"),
                ...optionalIntegerField(source, "blockedStreak"),
                ...optionalStringField(source, "evaluationModel"),
                ...optionalStringField(source, "evaluationProvider"),
                goalId: stringValue(source, "goalId"),
                ...optionalStringField(source, "lastEvaluatedEntryId"),
                ...optionalStringField(source, "note"),
                ...(statusValue === undefined ? {} : { status: statusValue }),
                ...optionalStringField(source, "statusReason"),
                ...optionalIntegerField(source, "tokensUsed"),
                ...optionalIntegerField(source, "turnsUsed"),
                type,
            };
            if (Object.keys(mutation).length === 2) {
                throw new PiSessionFeatureValidationError("goal.update requires at least one field to update");
            }
            return mutation;
        }
        case "goal.clear": {
            const goalId = stringValue(source, "goalId", { optional: true });
            return { ...(goalId === undefined ? {} : { goalId }), type };
        }
        case "assist.set": {
            const generatedAt = integerValue(source, "generatedAt", { optional: true });
            const recap = stringValue(source, "recap", { allowEmpty: true, optional: true });
            const suggestion = stringValue(source, "suggestion", { allowEmpty: true, optional: true });
            if (!recap?.trim() && !suggestion?.trim()) {
                throw new PiSessionFeatureValidationError("assist.set requires a recap or suggestion");
            }
            return {
                ...optionalStringField(source, "evaluationModel"),
                ...optionalStringField(source, "evaluationProvider"),
                forEntryId: stringValue(source, "forEntryId"),
                ...(generatedAt === undefined ? {} : { generatedAt }),
                ...(recap === undefined ? {} : { recap }),
                ...(suggestion === undefined ? {} : { suggestion }),
                type,
            };
        }
        case "assist.clear": {
            const fieldValue = stringValue(source, "field", { optional: true });
            if (fieldValue !== undefined
                && fieldValue !== "all"
                && fieldValue !== "recap"
                && fieldValue !== "suggestion") {
                throw new PiSessionFeatureValidationError("field must be all, recap, or suggestion");
            }
            const forEntryId = stringValue(source, "forEntryId", { optional: true });
            return {
                ...(fieldValue === undefined ? {} : { field: fieldValue }),
                ...(forEntryId === undefined ? {} : { forEntryId }),
                type,
            };
        }
        default:
            throw new PiSessionFeatureValidationError(`Unsupported session feature mutation: ${String(type)}`);
    }
}
//# sourceMappingURL=session-features.js.map