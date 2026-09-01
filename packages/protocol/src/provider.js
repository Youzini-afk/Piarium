import { THINKING_LEVELS } from "./types.js";
export const PROVIDER_CONFIG_SCOPES = ["user", "project", "custom"];
export const DISCOVERABLE_PROVIDER_APIS = [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
];
export class ProviderConfigValidationError extends Error {
    path;
    constructor(path, message) {
        super(`${path}: ${message}`);
        this.name = "ProviderConfigValidationError";
        this.path = path;
    }
}
function recordAt(value, path) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ProviderConfigValidationError(path, "must be an object");
    }
    return value;
}
function requiredString(value, path) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new ProviderConfigValidationError(path, "must be a non-empty string");
    }
    const normalized = value.trim();
    return normalized;
}
function optionalString(value, path) {
    if (value === undefined)
        return undefined;
    return requiredString(value, path);
}
function optionalBoolean(value, path) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "boolean") {
        throw new ProviderConfigValidationError(path, "must be a boolean");
    }
    return value;
}
function optionalFiniteNumber(value, path, options = {}) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "number" ||
        !Number.isFinite(value) ||
        (options.positive ? value <= 0 : value < 0)) {
        throw new ProviderConfigValidationError(path, options.positive ? "must be a positive finite number" : "must be a non-negative finite number");
    }
    return value;
}
function parseThinkingLevelMap(value, path) {
    if (value === undefined)
        return undefined;
    const input = recordAt(value, path);
    const result = {};
    for (const [key, entry] of Object.entries(input)) {
        if (!THINKING_LEVELS.includes(key)) {
            throw new ProviderConfigValidationError(`${path}.${key}`, "is not a supported thinking level");
        }
        if (entry !== null && typeof entry !== "string") {
            throw new ProviderConfigValidationError(`${path}.${key}`, "must be a string or null");
        }
        result[key] = entry;
    }
    return result;
}
function parseModel(value, index) {
    const path = `config.models[${index}]`;
    const input = recordAt(value, path);
    const id = requiredString(input.id, `${path}.id`);
    const name = optionalString(input.name, `${path}.name`);
    const api = optionalString(input.api, `${path}.api`);
    const baseUrl = optionalString(input.baseUrl, `${path}.baseUrl`);
    const reasoning = optionalBoolean(input.reasoning, `${path}.reasoning`);
    const contextWindow = optionalFiniteNumber(input.contextWindow, `${path}.contextWindow`, {
        positive: true,
    });
    const maxTokens = optionalFiniteNumber(input.maxTokens, `${path}.maxTokens`, {
        positive: true,
    });
    let modelInput;
    if (input.input !== undefined) {
        if (!Array.isArray(input.input) || input.input.length === 0) {
            throw new ProviderConfigValidationError(`${path}.input`, "must be a non-empty array");
        }
        modelInput = [...new Set(input.input.map((entry, inputIndex) => {
                if (entry !== "text" && entry !== "image") {
                    throw new ProviderConfigValidationError(`${path}.input[${inputIndex}]`, "must be text or image");
                }
                return entry;
            }))];
    }
    let cost;
    if (input.cost !== undefined) {
        const rawCost = recordAt(input.cost, `${path}.cost`);
        const cacheRead = optionalFiniteNumber(rawCost.cacheRead, `${path}.cost.cacheRead`);
        const cacheWrite = optionalFiniteNumber(rawCost.cacheWrite, `${path}.cost.cacheWrite`);
        const costInput = optionalFiniteNumber(rawCost.input, `${path}.cost.input`);
        const output = optionalFiniteNumber(rawCost.output, `${path}.cost.output`);
        cost = {
            ...(cacheRead === undefined ? {} : { cacheRead }),
            ...(cacheWrite === undefined ? {} : { cacheWrite }),
            ...(costInput === undefined ? {} : { input: costInput }),
            ...(output === undefined ? {} : { output }),
        };
    }
    const thinkingLevelMap = parseThinkingLevelMap(input.thinkingLevelMap, `${path}.thinkingLevelMap`);
    return {
        ...(api === undefined ? {} : { api }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(cost === undefined ? {} : { cost }),
        id,
        ...(modelInput === undefined ? {} : { input: modelInput }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(name === undefined ? {} : { name }),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    };
}
export function parseProviderConfigInput(value) {
    const input = recordAt(value, "config");
    const id = requiredString(input.id, "config.id");
    const name = optionalString(input.name, "config.name");
    const rawBaseUrl = optionalString(input.baseUrl, "config.baseUrl");
    let baseUrl;
    if (rawBaseUrl !== undefined) {
        let url;
        try {
            url = new URL(rawBaseUrl);
        }
        catch {
            throw new ProviderConfigValidationError("config.baseUrl", "must be a valid URL");
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new ProviderConfigValidationError("config.baseUrl", "must use http or https");
        }
        baseUrl = url.toString().replace(/\/+$/u, "");
    }
    const api = optionalString(input.api, "config.api");
    const authHeader = optionalBoolean(input.authHeader, "config.authHeader");
    if (input.models !== undefined && !Array.isArray(input.models)) {
        throw new ProviderConfigValidationError("config.models", "must be an array");
    }
    const models = input.models?.map(parseModel);
    const ids = new Set();
    for (const model of models ?? []) {
        if (ids.has(model.id)) {
            throw new ProviderConfigValidationError("config.models", `contains duplicate model id ${model.id}`);
        }
        ids.add(model.id);
    }
    if (api === undefined &&
        authHeader === undefined &&
        baseUrl === undefined &&
        models === undefined &&
        name === undefined) {
        throw new ProviderConfigValidationError("config", "must define at least one provider setting");
    }
    return {
        ...(api === undefined ? {} : { api }),
        ...(authHeader === undefined ? {} : { authHeader }),
        ...(baseUrl === undefined ? {} : { baseUrl }),
        id,
        ...(models === undefined ? {} : { models }),
        ...(name === undefined ? {} : { name }),
    };
}
//# sourceMappingURL=provider.js.map