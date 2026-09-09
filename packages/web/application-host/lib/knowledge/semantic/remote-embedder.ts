/**
 * Host-side remote embedder. Submits authorized text through the Pi workspace
 * binding and never sees provider secrets.
 */

import {
  REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS,
  type HarnessEmbedResult,
  type HarnessEmbeddingSettings,
} from "@piarium/protocol";
import type { SemanticEmbedder, SemanticEmbedRequest, SemanticEmbedResult } from "./embedder.js";
import { remoteEmbeddingSpaceId, type VectorSpaceIdentity } from "./identity.js";

export interface RemoteEmbedClient {
  embed(params: {
    purpose: "document" | "query";
    providerId: string;
    modelId: string;
    protocol: "openai-compatible";
    items: Array<{ id: string; text: string }>;
    batchId: string;
    dimensions?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<HarnessEmbedResult>;
}

const spaceFromBinding = (
  binding: HarnessEmbeddingSettings,
  dim: number,
): VectorSpaceIdentity => {
  const maxTokens = binding.maxTokens ?? REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS;
  return {
    provider: binding.providerId,
    model: binding.modelId,
    modelRevision: "openai-compatible",
    dim,
    pooling: "mean",
    normalize: true,
    maxTokens,
    spaceId: remoteEmbeddingSpaceId({
      protocol: binding.protocol,
      providerId: binding.providerId,
      modelId: binding.modelId,
      maxTokens,
      ...(binding.dimensions === undefined ? {} : { dimensions: binding.dimensions }),
    }),
  };
};

export function createRemoteEmbedder(options: {
  binding: HarnessEmbeddingSettings;
  client: RemoteEmbedClient;
}): SemanticEmbedder {
  const maxTokens = options.binding.maxTokens ?? REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS;
  const space = spaceFromBinding(options.binding, options.binding.dimensions ?? 0);
  const embedder: SemanticEmbedder = {
    status: "ready",
    get space() { return space; },
    prepare: async () => undefined,
    countTokens: (text) => {
      // Remote tokenizers stay on the provider. Character length is a conservative
      // Host-side split so a long line is never dropped while we wait for a count.
      return Math.max(1, text.length);
    },
    embed: async (texts, request) => {
      request?.signal?.throwIfAborted();
      const result = await embedder.embedBatch({
        purpose: request?.purpose ?? "document",
        batchId: request?.batchId ?? `remote:${texts.length}`,
        items: texts.map((text, index) => ({ id: `remote-${index}`, text })),
        ...(request?.signal ? { signal: request.signal } : {}),
      });
      return result.items.sort((left, right) => left.index - right.index).map((item) => item.vector);
    },
    embedBatch: async (request: SemanticEmbedRequest): Promise<SemanticEmbedResult> => {
      request.signal?.throwIfAborted();
      const result = await options.client.embed({
        purpose: request.purpose,
        providerId: options.binding.providerId,
        modelId: options.binding.modelId,
        protocol: "openai-compatible",
        items: request.items.map((item) => ({ id: item.id, text: item.text })),
        batchId: request.batchId,
        ...(options.binding.dimensions === undefined ? {} : { dimensions: options.binding.dimensions }),
        maxTokens,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (result.items.length !== request.items.length) {
        throw new Error(`Remote embedder returned ${result.items.length} vectors for ${request.items.length} inputs.`);
      }
      const ordered = [...result.items].sort((left, right) => left.index - right.index);
      for (const [index, item] of ordered.entries()) {
        if (item.index !== index) throw new Error(`Remote embedder result is missing index ${index}.`);
        if (item.id !== request.items[index]!.id) {
          throw new Error("Remote embedder result identity does not match the submitted batch.");
        }
        if (item.vector.some((value) => !Number.isFinite(value))) {
          throw new Error("Remote embedder returned a non-finite vector.");
        }
      }
      const dim = result.space.dim;
      if (ordered.some((item) => item.vector.length !== dim)) {
        throw new Error("Remote embedder mixed vector dimensions.");
      }
      space.dim = dim;
      if (result.space.spaceId && result.space.spaceId !== space.spaceId) {
        throw new Error("Remote embedder returned a different vector space than the configured binding.");
      }
      return {
        batchId: result.batchId,
        space,
        items: ordered,
      };
    },
  };
  return embedder;
}
