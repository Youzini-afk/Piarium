/**
 * Chat-independent Pi runtime binding for embedding and rerank.
 * Uses the same SettingsManager, AuthStorage (via ModelRuntime), and
 * ProviderConfigurationManager as sessions. It does not borrow a chat session.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { ModelRuntime, ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  mergeHarnessSettings,
  parseHarnessEmbeddingSettings,
  parseHarnessRerankSettings,
  remoteEmbeddingSpaceParts,
  REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS,
  type HarnessEmbedParams,
  type HarnessEmbedResult,
  type HarnessEmbeddingSettings,
  type HarnessRerankParams,
  type HarnessRerankResult,
  type HarnessRerankSettings,
  type HarnessSettingsInput,
  type HarnessVectorSpaceBinding,
} from "@piarium/protocol";
import { HostError } from "../errors.js";
import { ProviderConfigurationManager } from "../provider-configuration.js";
import { requestOpenAICompatibleEmbeddings } from "./openai-embeddings.js";
import { requestHttpRerank } from "./http-rerank.js";

export { REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS };

export interface BackgroundInferenceOptions {
  agentDir: string;
  cwd: string;
  fetchImpl?: typeof fetch;
  projectTrustOverride?: boolean;
  /**
   * Workspace-worker ModelRuntime. Shares AuthStorage and in-process API-key
   * overlays. When omitted, a runtime is created from the same auth.json.
   */
  modelRuntime?: ModelRuntime;
}

const spaceIdOf = (input: {
  protocol: string;
  providerId: string;
  modelId: string;
  maxTokens: number;
  dimensions?: number;
}): string => createHash("sha256").update(JSON.stringify(remoteEmbeddingSpaceParts(input))).digest("hex").slice(0, 16);

const stringHeaders = (headers: Record<string, string | null> | undefined): Record<string, string> | undefined => {
  if (!headers) return undefined;
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") cleaned[key] = value;
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
};

const harnessFromSettings = (manager: SettingsManager): HarnessSettingsInput => (
  ((manager.getGlobalSettings() as { harness?: HarnessSettingsInput }).harness ?? {})
);

export class BackgroundInferenceRuntime {
  readonly #agentDir: string;
  readonly #cwd: string;
  readonly #fetchImpl: typeof fetch | undefined;
  readonly #projectTrusted: boolean;
  readonly #settings: SettingsManager;
  readonly #providers: ProviderConfigurationManager;
  readonly #sharedRuntime: ModelRuntime | undefined;
  #modelRuntime: ModelRuntime | undefined;

  constructor(options: BackgroundInferenceOptions) {
    this.#agentDir = options.agentDir;
    this.#cwd = options.cwd;
    this.#fetchImpl = options.fetchImpl;
    this.#sharedRuntime = options.modelRuntime;
    this.#projectTrusted = options.projectTrustOverride === true
      || new ProjectTrustStore(options.agentDir).get(options.cwd) === true;
    this.#settings = SettingsManager.create(options.cwd, options.agentDir, {
      projectTrusted: this.#projectTrusted,
    });
    this.#providers = new ProviderConfigurationManager({ agentDir: options.agentDir });
  }

  embeddingSettings(): HarnessEmbeddingSettings | undefined {
    return parseHarnessEmbeddingSettings(harnessFromSettings(this.#settings).embedding);
  }

  rerankSettings(): HarnessRerankSettings | undefined {
    return parseHarnessRerankSettings(harnessFromSettings(this.#settings).rerank);
  }

  mergedHarness() {
    const user = harnessFromSettings(this.#settings);
    const project = this.#settings.isProjectTrusted()
      ? ((this.#settings.getProjectSettings() as { harness?: HarnessSettingsInput }).harness ?? {})
      : {};
    return mergeHarnessSettings(user, project);
  }

  async reload(): Promise<void> {
    await this.#settings.reload();
    if (!this.#sharedRuntime) this.#modelRuntime = undefined;
  }

  async embed(params: HarnessEmbedParams & { signal?: AbortSignal }): Promise<HarnessEmbedResult> {
    await this.#settings.reload();
    const configured = this.embeddingSettings();
    if (!configured) {
      throw new HostError("embedding_unconfigured", "Remote embedding is not configured");
    }
    if (
      configured.protocol !== params.protocol
      || configured.providerId !== params.providerId
      || configured.modelId !== params.modelId
    ) {
      throw new HostError("embedding_binding_mismatch", "Embed request does not match the configured binding");
    }
    const endpoint = await this.#resolveEndpoint(params.providerId);
    const result = await requestOpenAICompatibleEmbeddings({
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      ...(endpoint.headers ? { headers: endpoint.headers } : {}),
      model: params.modelId,
      input: params.items.map((item) => item.text),
      ...(configured.dimensions === undefined && params.dimensions === undefined
        ? {}
        : { dimensions: params.dimensions ?? configured.dimensions }),
      ...(this.#fetchImpl ? { fetchImpl: this.#fetchImpl } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    const maxTokens = configured.maxTokens ?? params.maxTokens ?? REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS;
    const space: HarnessVectorSpaceBinding = {
      providerId: configured.providerId,
      modelId: configured.modelId,
      protocol: "openai-compatible",
      dim: result.dim,
      maxTokens,
      spaceId: spaceIdOf({
        protocol: "openai-compatible",
        providerId: configured.providerId,
        modelId: configured.modelId,
        maxTokens,
        ...(configured.dimensions === undefined ? {} : { dimensions: configured.dimensions }),
      }),
    };
    return {
      batchId: params.batchId,
      space,
      items: result.vectors.map((vector, index) => ({
        id: params.items[index]!.id,
        index,
        vector,
      })),
    };
  }

  async rerank(params: HarnessRerankParams & { signal?: AbortSignal }): Promise<HarnessRerankResult> {
    await this.#settings.reload();
    const configured = this.rerankSettings();
    if (!configured) {
      throw new HostError("rerank_unconfigured", "Rerank is not configured");
    }
    if (
      configured.protocol !== params.protocol
      || configured.providerId !== params.providerId
      || configured.modelId !== params.modelId
    ) {
      throw new HostError("rerank_binding_mismatch", "Rerank request does not match the configured binding");
    }
    const endpoint = await this.#resolveEndpoint(params.providerId);
    const scores = await requestHttpRerank({
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      ...(endpoint.headers ? { headers: endpoint.headers } : {}),
      model: params.modelId,
      query: params.query,
      documents: params.documents,
      ...(configured.endpoint ?? params.endpoint ? { endpoint: params.endpoint ?? configured.endpoint } : {}),
      ...(this.#fetchImpl ? { fetchImpl: this.#fetchImpl } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    return {
      batchId: params.batchId,
      providerId: configured.providerId,
      modelId: configured.modelId,
      scores,
    };
  }

  async #runtime(): Promise<ModelRuntime> {
    if (this.#sharedRuntime) {
      await this.#providers.apply(this.#sharedRuntime, this.#cwd, this.#projectTrusted);
      return this.#sharedRuntime;
    }
    if (this.#modelRuntime) return this.#modelRuntime;
    this.#modelRuntime = await ModelRuntime.create({
      allowModelNetwork: true,
      authPath: join(this.#agentDir, "auth.json"),
      modelsPath: join(this.#agentDir, "models.json"),
    });
    await this.#providers.apply(this.#modelRuntime, this.#cwd, this.#projectTrusted);
    return this.#modelRuntime;
  }

  async #resolveEndpoint(providerId: string): Promise<{
    baseUrl: string;
    apiKey: string;
    headers?: Record<string, string>;
  }> {
    const runtime = await this.#runtime();
    await this.#providers.apply(runtime, this.#cwd, this.#projectTrusted);
    const provider = runtime.getProvider(providerId);
    let baseUrl = provider?.baseUrl;
    try {
      const config = await this.#providers.effectiveConfig(this.#cwd, providerId, this.#projectTrusted);
      baseUrl = config.baseUrl ?? baseUrl;
    } catch {
      // Native-only providers still resolve from the runtime catalog.
    }
    if (!baseUrl) {
      throw new HostError("provider_endpoint_missing", `Provider ${providerId} does not define a base URL`);
    }
    const auth = await runtime.getAuth(providerId);
    const apiKey = auth?.auth.apiKey;
    if (!apiKey) {
      throw new HostError("provider_auth_missing", `Provider ${providerId} has no credential`);
    }
    const headers = stringHeaders(auth.auth.headers);
    return {
      baseUrl,
      apiKey,
      ...(headers ? { headers } : {}),
    };
  }
}

export function createBackgroundInferenceRuntime(options: BackgroundInferenceOptions): BackgroundInferenceRuntime {
  return new BackgroundInferenceRuntime(options);
}
