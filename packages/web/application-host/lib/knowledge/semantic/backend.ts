/**
 * Chooses the live embedding backend from user-owned harness.embedding.
 * A configured remote binding is used for both index and query. There is no
 * silent fallback to MiniLM for that query.
 */

import {
  parseHarnessEmbeddingSettings,
  type HarnessEmbeddingSettings,
  type PiSettingsSnapshot,
} from "@piarium/protocol";
import type { SemanticEmbedder } from "./embedder.js";
import { createRemoteEmbedder, type RemoteEmbedClient } from "./remote-embedder.js";

export type SemanticBackendKind = "local" | "remote";

const bindingKey = (binding: HarnessEmbeddingSettings): string => (
  `${binding.protocol}:${binding.providerId}:${binding.modelId}:${binding.dimensions ?? ""}:${binding.maxTokens ?? ""}`
);

export function embeddingSettingsFromSnapshot(snapshot: PiSettingsSnapshot | null | undefined): HarnessEmbeddingSettings | undefined {
  const harness = snapshot?.global?.harness;
  if (!harness || typeof harness !== "object" || Array.isArray(harness)) return undefined;
  return parseHarnessEmbeddingSettings((harness as { embedding?: unknown }).embedding);
}

export function createSemanticBackend(options: {
  local: SemanticEmbedder;
  embedClient?: RemoteEmbedClient;
}) {
  let kind: SemanticBackendKind = "local";
  let current = options.local;
  let currentKey = "local";
  let lastError: unknown;

  const bind = (settings: HarnessEmbeddingSettings | undefined): SemanticEmbedder => {
    lastError = undefined;
    if (!settings) {
      kind = "local";
      current = options.local;
      currentKey = "local";
      return current;
    }
    if (!options.embedClient) {
      lastError = new Error("Remote embedding is configured but the Pi workspace binding is unavailable.");
      kind = "remote";
      current = {
        ...options.local,
        status: "unavailable",
      };
      currentKey = bindingKey(settings);
      return current;
    }
    const key = bindingKey(settings);
    if (kind === "remote" && currentKey === key && current.status === "ready") return current;
    kind = "remote";
    currentKey = key;
    current = createRemoteEmbedder({ binding: settings, client: options.embedClient });
    return current;
  };

  return {
    get kind() { return kind; },
    get embedder() { return current; },
    get lastError() { return lastError; },
    bind,
    local: options.local,
  };
}

export type SemanticBackend = ReturnType<typeof createSemanticBackend>;
