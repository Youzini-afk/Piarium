import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  DISCOVERABLE_PROVIDER_APIS,
  type DiscoverableProviderApi,
  type ProviderConfigInput,
  type ProviderModelConfigInput,
  type ProviderModelDiscoveryResult,
} from "@piarium/protocol";
import { HostError } from "./errors.js";
import type { ProviderConfigurationManager } from "./provider-configuration.js";

function configurableResourceLimit(name: string, fallback: number): number | undefined {
  const configured = process.env[name];
  if (configured === undefined || configured.trim() === "") return fallback;
  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed === 0 ? undefined : Math.floor(parsed);
}

// Defaults prevent a broken endpoint from owning the worker indefinitely. They are deliberately
// generous, are not catalog/model limits, and can be raised or disabled (value 0) by the owner.
const MAX_RESPONSE_BYTES = configurableResourceLimit(
  "PIARIUM_PROVIDER_DISCOVERY_MAX_BYTES",
  256 * 1024 * 1024,
);
const REQUEST_TIMEOUT_MS = configurableResourceLimit(
  "PIARIUM_PROVIDER_DISCOVERY_TIMEOUT_MS",
  5 * 60_000,
);
const MAX_REDIRECTS = configurableResourceLimit(
  "PIARIUM_PROVIDER_DISCOVERY_MAX_REDIRECTS",
  20,
);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendModelsPath(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HostError("provider_discovery_invalid_url", "Provider base URL must use HTTP or HTTPS");
  }
  url.hash = "";
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = path.endsWith("/models") ? path : `${path}/models`;
  return url;
}

function safeHeaders(
  value: Record<string, string | null> | undefined,
): Record<string, string> {
  const blocked = new Set([
    "connection",
    "content-length",
    "host",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(
      (entry): entry is [string, string] =>
        entry[1] !== null && !blocked.has(entry[0].toLowerCase()),
    ),
  );
}

function requestHeaders(
  api: DiscoverableProviderApi,
  apiKey: string | undefined,
  configured: Record<string, string | null> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...safeHeaders(configured),
  };
  if (api === "anthropic-messages") {
    if (apiKey) headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (api === "google-generative-ai") {
    if (apiKey) headers["x-goog-api-key"] = apiKey;
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function isSensitiveHeader(name: string): boolean {
  return /authorization|cookie|key|secret|token/iu.test(name);
}

function stripSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !isSensitiveHeader(name)),
  );
}

function takeUrlCredentials(
  url: URL,
  headers: Record<string, string>,
): { headers: Record<string, string>; url: URL } {
  if (!url.username && !url.password) return { headers, url };
  const nextUrl = new URL(url);
  const nextHeaders = { ...headers };
  const username = decodeURIComponent(nextUrl.username);
  const password = decodeURIComponent(nextUrl.password);
  nextHeaders.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  nextUrl.username = "";
  nextUrl.password = "";
  return { headers: nextHeaders, url: nextUrl };
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length"));
  if (
    MAX_RESPONSE_BYTES !== undefined
    && Number.isFinite(contentLength)
    && contentLength > MAX_RESPONSE_BYTES
  ) {
    throw new HostError(
      "provider_discovery_response_too_large",
      `Provider model response exceeded the configured ${MAX_RESPONSE_BYTES} byte ceiling`,
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (MAX_RESPONSE_BYTES !== undefined && size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new HostError(
        "provider_discovery_response_too_large",
        `Provider model response exceeded the configured ${MAX_RESPONSE_BYTES} byte ceiling`,
      );
    }
    chunks.push(chunk.value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function redactedProviderMessage(
  payload: unknown,
  headers: Record<string, string>,
  status: number,
): string {
  const rawMessage = isObject(payload)
    ? typeof payload.message === "string"
      ? payload.message
      : isObject(payload.error) && typeof payload.error.message === "string"
        ? payload.error.message
        : typeof payload.error === "string"
          ? payload.error
          : undefined
    : undefined;
  let message = rawMessage || `Provider model discovery failed (${status})`;
  for (const [name, value] of Object.entries(headers)) {
    if (!isSensitiveHeader(name) || !value) continue;
    message = message.replaceAll(value, "[redacted]");
    if (/^bearer /iu.test(value)) message = message.replaceAll(value.slice(7), "[redacted]");
  }
  return message;
}

async function requestJson(url: URL, initialHeaders: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timeout = REQUEST_TIMEOUT_MS === undefined
    ? undefined
    : setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let currentUrl = url;
  let headers = initialHeaders;
  const visited = new Set<string>();
  try {
    for (let redirects = 0; ; redirects += 1) {
      const request = takeUrlCredentials(currentUrl, headers);
      if (visited.has(request.url.href)) {
        throw new HostError(
          "provider_discovery_redirect_loop",
          "Provider model discovery encountered a redirect loop",
        );
      }
      visited.add(request.url.href);
      let response: Response;
      try {
        response = await fetch(request.url, {
          headers: request.headers,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new HostError("provider_discovery_timeout", "Provider model discovery timed out", {
            cause: error,
            retryable: true,
          });
        }
        throw error;
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) {
          throw new HostError(
            "provider_discovery_redirect_invalid",
            "Provider returned a redirect without a location",
          );
        }
        if (MAX_REDIRECTS !== undefined && redirects >= MAX_REDIRECTS) {
          throw new HostError(
            "provider_discovery_redirect_limit",
            `Provider model discovery exceeded the configured ${MAX_REDIRECTS} redirects`,
          );
        }
        const nextUrl = new URL(location, request.url);
        if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
          throw new HostError(
            "provider_discovery_redirect_invalid",
            "Provider redirected to a non-HTTP URL",
          );
        }
        headers = nextUrl.origin === request.url.origin ? request.headers : stripSensitiveHeaders(request.headers);
        currentUrl = nextUrl;
        continue;
      }
      const bytes = await readBoundedBody(response);
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes));
      } catch (error) {
        throw new HostError("provider_discovery_invalid_response", "Provider returned invalid JSON", {
          cause: error,
        });
      }
      if (!response.ok) {
        throw new HostError(
          "provider_discovery_failed",
          redactedProviderMessage(payload, request.headers, response.status),
        );
      }
      return payload;
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function firstPositive(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
}

function containsImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsImage);
  return typeof value === "string" && /image|vision/iu.test(value);
}

function includesCapability(value: unknown, patterns: RegExp): boolean {
  if (Array.isArray(value)) return value.some((entry) => includesCapability(entry, patterns));
  return typeof value === "string" && patterns.test(value);
}

function normalizedModels(
  api: DiscoverableProviderApi,
  payload: unknown,
): ProviderModelConfigInput[] {
  if (!isObject(payload)) {
    throw new HostError("provider_discovery_invalid_response", "Provider response must be an object");
  }
  const entries = api === "google-generative-ai" ? payload.models : payload.data;
  if (!Array.isArray(entries)) {
    throw new HostError("provider_discovery_invalid_response", "Provider response did not contain a model list");
  }
  const result: ProviderModelConfigInput[] = [];
  const seen = new Set<string>();
  for (const value of entries) {
    if (!isObject(value)) continue;
    const rawId = api === "google-generative-ai" ? value.name : value.id;
    const id = typeof rawId === "string" ? rawId.trim().replace(/^models\//u, "") : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const capabilities = isObject(value.capabilities) ? value.capabilities : {};
    const architecture = isObject(value.architecture) ? value.architecture : {};
    const contextWindow = firstPositive(
      value.contextWindow,
      value.context_window,
      value.contextLength,
      value.context_length,
      value.inputTokenLimit,
      value.input_token_limit,
      isObject(value.limit) ? value.limit.context : undefined,
    );
    const maxTokens = firstPositive(
      value.maxTokens,
      value.max_tokens,
      value.maxOutputTokens,
      value.max_output_tokens,
      value.outputTokenLimit,
      value.output_token_limit,
      isObject(value.limit) ? value.limit.output : undefined,
    );
    const image =
      value.vision === true ||
      value.supportsImages === true ||
      value.supports_images === true ||
      containsImage(value.input_modalities) ||
      containsImage(value.inputModalities) ||
      containsImage(capabilities.input) ||
      containsImage(capabilities.modalities) ||
      containsImage(architecture.input_modalities);
    const reasoning =
      value.reasoning === true ||
      value.supportsReasoning === true ||
      value.supports_reasoning === true ||
      capabilities.reasoning === true ||
      capabilities.thinking === true ||
      includesCapability(value.supported_parameters, /reasoning|thinking/iu) ||
      includesCapability(value.supportedParameters, /reasoning|thinking/iu);
    const displayName = [value.displayName, value.display_name, value.title, value.name]
      .find((entry) => typeof entry === "string" && entry.trim().length > 0);
    result.push({
      ...(contextWindow === undefined ? {} : { contextWindow }),
      id,
      input: image ? ["text", "image"] : ["text"],
      ...(maxTokens === undefined ? {} : { maxTokens }),
      name: typeof displayName === "string" ? displayName.trim() : id,
      reasoning,
    });
  }
  if (result.length === 0) {
    throw new HostError("provider_discovery_empty", "Provider returned no usable models");
  }
  return result;
}

export async function discoverProviderModels(options: {
  apiKey?: string;
  config?: ProviderConfigInput;
  configuration: ProviderConfigurationManager;
  cwd: string;
  providerId: string;
  runtime: ModelRuntime;
}): Promise<ProviderModelDiscoveryResult> {
  const config = options.config
    ?? await options.configuration.effectiveConfig(options.cwd, options.providerId);
  const runtimeProvider = options.runtime.getProvider(options.providerId);
  const runtimeModel = options.runtime.getModels(options.providerId)[0];
  const configuredApi = config.api ?? runtimeModel?.api;
  const configuredBaseUrl = config.baseUrl ?? runtimeProvider?.baseUrl ?? runtimeModel?.baseUrl;
  if (
    !configuredApi ||
    !DISCOVERABLE_PROVIDER_APIS.includes(configuredApi as DiscoverableProviderApi)
  ) {
    throw new HostError(
      "provider_discovery_unsupported_api",
      `Model discovery is not supported for Pi API ${configuredApi ?? "(not configured)"}`,
    );
  }
  if (!configuredBaseUrl) {
    throw new HostError(
      "provider_discovery_invalid_url",
      `Provider ${options.providerId} does not define a base URL`,
    );
  }
  const api = configuredApi as DiscoverableProviderApi;
  const discoveryUrl = appendModelsPath(configuredBaseUrl);
  const auth = await options.runtime.getAuth(options.providerId);
  const payload = await requestJson(
    discoveryUrl,
    requestHeaders(api, options.apiKey ?? auth?.auth.apiKey, auth?.auth.headers),
  );
  return {
    api,
    baseUrl: configuredBaseUrl,
    models: normalizedModels(api, payload),
    providerId: options.providerId,
  };
}
