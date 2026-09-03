/**
 * Embedding provider abstraction.
 *
 * Design: agent-harness.md §7.2
 * Plan: agent-harness-plan.md §2.8
 *
 * Adapters: OpenAI, Voyage, Mistral, Gemini, Jina, Cohere, OpenAI-compatible.
 * Credentials go through provider credential path.
 * Store metadata { provider, model, dim } in meta.json alongside .tdb.
 * Switching → background recompute in batches of 100, write new generation,
 * publishGenerationManifest, old generation reclaimed by Reader leases.
 * Unconfigured → placeholder mode.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// ── Interface ──────────────────────────────────────────────────────

export interface EmbeddingProvider {
  id: string;
  model: string;
  dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingMeta {
  provider: string;
  model: string;
  dim: number;
}

// ── OpenAI adapter ─────────────────────────────────────────────────

export interface OpenAIEmbeddingConfig {
  apiKey: string;
  model: string; // e.g. "text-embedding-3-small"
  dim?: number; // default 1024, can be truncated via dimensions param
  baseUrl?: string;
}

export function createOpenAIEmbedding(config: OpenAIEmbeddingConfig): EmbeddingProvider {
  const dim = config.dim ?? 1024;
  const baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
  const id = config.baseUrl ? `openai-compatible:${config.baseUrl}` : "openai";

  return {
    id,
    model: config.model,
    dim,
    async embed(texts: string[]): Promise<number[][]> {
      const resp = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          input: texts,
          dimensions: dim,
        }),
      });
      if (!resp.ok) {
        throw new Error(`OpenAI embedding failed: ${resp.status} ${await resp.text()}`);
      }
      const data = await resp.json() as { data: Array<{ embedding: number[] }> };
      return data.data.map((d) => d.embedding);
    },
  };
}

// ── Voyage adapter ─────────────────────────────────────────────────

export interface VoyageEmbeddingConfig {
  apiKey: string;
  model: string;
  dim?: number;
}

export function createVoyageEmbedding(config: VoyageEmbeddingConfig): EmbeddingProvider {
  const dim = config.dim ?? 1024;
  return {
    id: "voyage",
    model: config.model,
    dim,
    async embed(texts: string[]): Promise<number[][]> {
      const resp = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model: config.model, input: texts }),
      });
      if (!resp.ok) throw new Error(`Voyage embedding failed: ${resp.status}`);
      const data = await resp.json() as { data: Array<{ embedding: number[] }> };
      return data.data.map((d) => d.embedding);
    },
  };
}

// ── Cohere adapter ─────────────────────────────────────────────────

export interface CohereEmbeddingConfig {
  apiKey: string;
  model: string;
  dim?: number;
}

export function createCohereEmbedding(config: CohereEmbeddingConfig): EmbeddingProvider {
  const dim = config.dim ?? 1024;
  return {
    id: "cohere",
    model: config.model,
    dim,
    async embed(texts: string[]): Promise<number[][]> {
      const resp = await fetch("https://api.cohere.ai/v1/embed", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model: config.model, texts, input_type: "search_document" }),
      });
      if (!resp.ok) throw new Error(`Cohere embedding failed: ${resp.status}`);
      const data = await resp.json() as { embeddings: number[][] };
      return data.embeddings;
    },
  };
}

// ── Jina adapter ───────────────────────────────────────────────────

export interface JinaEmbeddingConfig {
  apiKey: string;
  model: string;
  dim?: number;
}

export function createJinaEmbedding(config: JinaEmbeddingConfig): EmbeddingProvider {
  const dim = config.dim ?? 1024;
  return {
    id: "jina",
    model: config.model,
    dim,
    async embed(texts: string[]): Promise<number[][]> {
      const resp = await fetch("https://api.jina.ai/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model: config.model, input: texts }),
      });
      if (!resp.ok) throw new Error(`Jina embedding failed: ${resp.status}`);
      const data = await resp.json() as { data: Array<{ embedding: number[] }> };
      return data.data.map((d) => d.embedding);
    },
  };
}

// ── Mistral adapter ────────────────────────────────────────────────

export interface MistralEmbeddingConfig {
  apiKey: string;
  model: string;
  dim?: number;
}

export function createMistralEmbedding(config: MistralEmbeddingConfig): EmbeddingProvider {
  const dim = config.dim ?? 1024;
  return {
    id: "mistral",
    model: config.model,
    dim,
    async embed(texts: string[]): Promise<number[][]> {
      const resp = await fetch("https://api.mistral.ai/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model: config.model, input: texts }),
      });
      if (!resp.ok) throw new Error(`Mistral embedding failed: ${resp.status}`);
      const data = await resp.json() as { data: Array<{ embedding: number[] }> };
      return data.data.map((d) => d.embedding);
    },
  };
}

// ── Gemini adapter ─────────────────────────────────────────────────

export interface GeminiEmbeddingConfig {
  apiKey: string;
  model: string;
  dim?: number;
}

export function createGeminiEmbedding(config: GeminiEmbeddingConfig): EmbeddingProvider {
  const dim = config.dim ?? 1024;
  return {
    id: "gemini",
    model: config.model,
    dim,
    async embed(texts: string[]): Promise<number[][]> {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:batchEmbedContents?key=${config.apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requests: texts.map((t) => ({
              model: `models/${config.model}`,
              content: { parts: [{ text: t }] },
            })),
          }),
        },
      );
      if (!resp.ok) throw new Error(`Gemini embedding failed: ${resp.status}`);
      const data = await resp.json() as { embeddings: Array<{ values: number[] }> };
      return data.embeddings.map((e) => e.values);
    },
  };
}

// ── Meta persistence ───────────────────────────────────────────────

export function saveEmbeddingMeta(dbPath: string, meta: EmbeddingMeta): void {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const metaPath = join(dir, "meta.json");
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
}

export function loadEmbeddingMeta(dbPath: string): EmbeddingMeta | null {
  const metaPath = join(dirname(dbPath), "meta.json");
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8")) as EmbeddingMeta;
  } catch {
    return null;
  }
}

// ── Dimension validation ───────────────────────────────────────────

export function validateEmbeddingDim(
  provider: EmbeddingProvider,
  actual: number,
): boolean {
  return actual === provider.dim;
}
