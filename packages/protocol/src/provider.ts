import { THINKING_LEVELS, type ThinkingLevel } from "./types.js";

export const PROVIDER_CONFIG_SCOPES = ["user", "project", "custom"] as const;

export type ProviderConfigScope = (typeof PROVIDER_CONFIG_SCOPES)[number];

export type ProviderConfigDeleteScope = ProviderConfigScope | "auth" | "all";

export const DISCOVERABLE_PROVIDER_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

export type DiscoverableProviderApi = (typeof DISCOVERABLE_PROVIDER_APIS)[number];

export interface ProviderModelCostInput {
  cacheRead?: number;
  cacheWrite?: number;
  input?: number;
  output?: number;
}

export interface ProviderModelConfigInput {
  api?: string;
  baseUrl?: string;
  contextWindow?: number;
  cost?: ProviderModelCostInput;
  id: string;
  input?: Array<"text" | "image">;
  maxTokens?: number;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

/**
 * Browser-safe subset of Pi's native models.json provider definition.
 * Dedicated Pi credentials and arbitrary headers deliberately never cross this boundary. An
 * explicitly configured URL remains intact, including optional URL basic-auth information.
 */
export interface ProviderConfigInput {
  api?: string;
  authHeader?: boolean;
  baseUrl?: string;
  id: string;
  models?: ProviderModelConfigInput[];
  name?: string;
}

export interface ProviderConfigLocation {
  available: boolean;
  exists: boolean;
  path?: string;
  scope: ProviderConfigScope;
  writable: boolean;
}

export interface ProviderConfigDetails {
  auth: {
    configured: boolean;
    label?: string;
    source?: string;
  };
  config?: ProviderConfigInput;
  effectiveScope?: ProviderConfigScope;
  locations: Record<ProviderConfigScope, ProviderConfigLocation>;
  providerId: string;
}

export interface ProviderModelDiscoveryResult {
  api: DiscoverableProviderApi;
  baseUrl: string;
  models: ProviderModelConfigInput[];
  providerId: string;
}

export class ProviderConfigValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ProviderConfigValidationError";
    this.path = path;
  }
}

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderConfigValidationError(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  path: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProviderConfigValidationError(path, "must be a non-empty string");
  }
  const normalized = value.trim();
  return normalized;
}

function optionalString(
  value: unknown,
  path: string,
): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, path);
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ProviderConfigValidationError(path, "must be a boolean");
  }
  return value;
}

function optionalFiniteNumber(
  value: unknown,
  path: string,
  options: { positive?: boolean } = {},
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (options.positive ? value <= 0 : value < 0)
  ) {
    throw new ProviderConfigValidationError(
      path,
      options.positive ? "must be a positive finite number" : "must be a non-negative finite number",
    );
  }
  return value;
}

function parseThinkingLevelMap(
  value: unknown,
  path: string,
): ProviderModelConfigInput["thinkingLevelMap"] {
  if (value === undefined) return undefined;
  const input = recordAt(value, path);
  const result: Partial<Record<ThinkingLevel, string | null>> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (!THINKING_LEVELS.includes(key as ThinkingLevel)) {
      throw new ProviderConfigValidationError(`${path}.${key}`, "is not a supported thinking level");
    }
    if (entry !== null && typeof entry !== "string") {
      throw new ProviderConfigValidationError(`${path}.${key}`, "must be a string or null");
    }
    result[key as ThinkingLevel] = entry;
  }
  return result;
}

function parseModel(value: unknown, index: number): ProviderModelConfigInput {
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
  let modelInput: Array<"text" | "image"> | undefined;
  if (input.input !== undefined) {
    if (!Array.isArray(input.input) || input.input.length === 0) {
      throw new ProviderConfigValidationError(`${path}.input`, "must be a non-empty array");
    }
    modelInput = [...new Set(input.input.map((entry, inputIndex) => {
      if (entry !== "text" && entry !== "image") {
        throw new ProviderConfigValidationError(
          `${path}.input[${inputIndex}]`,
          "must be text or image",
        );
      }
      return entry;
    }))];
  }
  let cost: ProviderModelCostInput | undefined;
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

export function parseProviderConfigInput(value: unknown): ProviderConfigInput {
  const input = recordAt(value, "config");
  const id = requiredString(input.id, "config.id");
  const name = optionalString(input.name, "config.name");
  const rawBaseUrl = optionalString(input.baseUrl, "config.baseUrl");
  let baseUrl: string | undefined;
  if (rawBaseUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(rawBaseUrl);
    } catch {
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
  const ids = new Set<string>();
  for (const model of models ?? []) {
    if (ids.has(model.id)) {
      throw new ProviderConfigValidationError("config.models", `contains duplicate model id ${model.id}`);
    }
    ids.add(model.id);
  }
  if (
    api === undefined &&
    authHeader === undefined &&
    baseUrl === undefined &&
    models === undefined &&
    name === undefined
  ) {
    throw new ProviderConfigValidationError(
      "config",
      "must define at least one provider setting",
    );
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
