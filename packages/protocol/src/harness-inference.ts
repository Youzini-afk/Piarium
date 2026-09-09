/**
 * Workspace-scoped embedding and rerank calls. These are not chat model slots.
 * Secrets stay in the Pi runtime; the Host only submits authorized text.
 */

/** Remote embedding window. Not the local MiniLM 512-token limit. */
export const REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS = 8192;

export type HarnessEmbedPurpose = "document" | "query";

export type HarnessEmbeddingProtocol = "openai-compatible";

export interface HarnessEmbeddingSettings {
  protocol: HarnessEmbeddingProtocol;
  providerId: string;
  modelId: string;
  dimensions?: number;
  maxTokens?: number;
}

export type HarnessRerankProtocol = "http-rerank";

export interface HarnessRerankSettings {
  protocol: HarnessRerankProtocol;
  providerId: string;
  modelId: string;
  /** Provider-relative path. Defaults to `/rerank`. */
  endpoint?: string;
  maxDocumentTokens?: number;
}

export interface HarnessVectorSpaceBinding {
  providerId: string;
  modelId: string;
  protocol: HarnessEmbeddingProtocol | "local";
  dim: number;
  maxTokens: number;
  spaceId: string;
}

export interface HarnessEmbedItem {
  id: string;
  text: string;
}

export interface HarnessEmbedParams {
  purpose: HarnessEmbedPurpose;
  providerId: string;
  modelId: string;
  protocol: HarnessEmbeddingProtocol;
  items: HarnessEmbedItem[];
  batchId: string;
  dimensions?: number;
  maxTokens?: number;
}

export interface HarnessEmbedVector {
  id: string;
  index: number;
  vector: number[];
}

export interface HarnessEmbedResult {
  batchId: string;
  space: HarnessVectorSpaceBinding;
  items: HarnessEmbedVector[];
}

export interface HarnessRerankDocument {
  id: string;
  text: string;
  revision?: string;
}

export interface HarnessRerankParams {
  providerId: string;
  modelId: string;
  protocol: HarnessRerankProtocol;
  query: string;
  documents: HarnessRerankDocument[];
  batchId: string;
  endpoint?: string;
}

export interface HarnessRerankScore {
  id: string;
  index: number;
  score: number;
}

export interface HarnessRerankResult {
  batchId: string;
  providerId: string;
  modelId: string;
  scores: HarnessRerankScore[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const nonEmpty = (value: unknown): string | undefined => (
  typeof value === "string" && value.trim() ? value.trim() : undefined
);

const positiveInt = (value: unknown): number | undefined => (
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined
);

export function parseHarnessEmbeddingSettings(value: unknown): HarnessEmbeddingSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return undefined;
  if (value.protocol !== "openai-compatible") return undefined;
  const providerId = nonEmpty(value.providerId);
  const modelId = nonEmpty(value.modelId);
  if (!providerId || !modelId) return undefined;
  const dimensions = positiveInt(value.dimensions);
  const maxTokens = positiveInt(value.maxTokens);
  return {
    protocol: "openai-compatible",
    providerId,
    modelId,
    ...(dimensions === undefined ? {} : { dimensions }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}

/**
 * Canonical remote vector-space identity. Credentials are never included.
 * Configured dimensions participate; an unspecified size is "auto" so the
 * Host can name the space before the first HTTP response.
 */
export function remoteEmbeddingSpaceParts(input: {
  protocol: string;
  providerId: string;
  modelId: string;
  maxTokens: number;
  dimensions?: number;
}): readonly unknown[] {
  return [
    input.protocol,
    input.providerId,
    input.modelId,
    input.maxTokens,
    input.dimensions ?? "auto",
  ];
}

export function parseHarnessRerankSettings(value: unknown): HarnessRerankSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return undefined;
  if (value.protocol !== "http-rerank") return undefined;
  const providerId = nonEmpty(value.providerId);
  const modelId = nonEmpty(value.modelId);
  if (!providerId || !modelId) return undefined;
  const endpoint = nonEmpty(value.endpoint);
  const maxDocumentTokens = positiveInt(value.maxDocumentTokens);
  return {
    protocol: "http-rerank",
    providerId,
    modelId,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(maxDocumentTokens === undefined ? {} : { maxDocumentTokens }),
  };
}
