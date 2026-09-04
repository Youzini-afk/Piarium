import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createOpenAIEmbedding,
  createVoyageEmbedding,
  createCohereEmbedding,
  createJinaEmbedding,
  createMistralEmbedding,
  createGeminiEmbedding,
  saveEmbeddingMeta,
  loadEmbeddingMeta,
  validateEmbeddingDim,
  type EmbeddingProvider,
} from "./embedding.js";

// Scratch dirs live in the OS temp dir; see harness/recall-tool.test.ts.
const TEST_DIR = join(tmpdir(), "piarium-test-embedding");
function cleanup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
}

// Fake fetch helper
function fakeFetch(response: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(response), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as unknown as typeof fetch;
}

describe("embedding adapters", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
    globalThis.fetch = fakeFetch({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) as typeof fetch;
  });
  afterEach(() => {
    cleanup();
  });

  it("OpenAI adapter sends correct request", async () => {
    const provider = createOpenAIEmbedding({ apiKey: "test-key", model: "text-embedding-3-small" });
    expect(provider.id).toBe("openai");
    expect(provider.model).toBe("text-embedding-3-small");
    expect(provider.dim).toBe(1024);
    const result = await provider.embed(["test text"]);
    expect(result).toEqual([[0.1, 0.2, 0.3]]);
  });

  it("OpenAI-compatible uses custom baseUrl", async () => {
    const provider = createOpenAIEmbedding({
      apiKey: "test-key", model: "custom-model", baseUrl: "https://custom.example.com/v1",
    });
    expect(provider.id).toBe("openai-compatible:https://custom.example.com/v1");
  });

  it("Voyage adapter", async () => {
    globalThis.fetch = fakeFetch({ data: [{ embedding: [0.4, 0.5] }] }) as typeof fetch;
    const provider = createVoyageEmbedding({ apiKey: "key", model: "voyage-2" });
    expect(provider.id).toBe("voyage");
    const result = await provider.embed(["text"]);
    expect(result).toEqual([[0.4, 0.5]]);
  });

  it("Cohere adapter", async () => {
    globalThis.fetch = fakeFetch({ embeddings: [[0.6, 0.7]] }) as typeof fetch;
    const provider = createCohereEmbedding({ apiKey: "key", model: "embed-english-v3.0" });
    expect(provider.id).toBe("cohere");
    const result = await provider.embed(["text"]);
    expect(result).toEqual([[0.6, 0.7]]);
  });

  it("Jina adapter", async () => {
    globalThis.fetch = fakeFetch({ data: [{ embedding: [0.8, 0.9] }] }) as typeof fetch;
    const provider = createJinaEmbedding({ apiKey: "key", model: "jina-embeddings-v2" });
    expect(provider.id).toBe("jina");
    const result = await provider.embed(["text"]);
    expect(result).toEqual([[0.8, 0.9]]);
  });

  it("Mistral adapter", async () => {
    globalThis.fetch = fakeFetch({ data: [{ embedding: [1.0, 1.1] }] }) as typeof fetch;
    const provider = createMistralEmbedding({ apiKey: "key", model: "mistral-embed" });
    expect(provider.id).toBe("mistral");
    const result = await provider.embed(["text"]);
    expect(result).toEqual([[1.0, 1.1]]);
  });

  it("Gemini adapter", async () => {
    globalThis.fetch = fakeFetch({ embeddings: [{ values: [1.2, 1.3] }] }) as typeof fetch;
    const provider = createGeminiEmbedding({ apiKey: "key", model: "text-embedding-004" });
    expect(provider.id).toBe("gemini");
    const result = await provider.embed(["text"]);
    expect(result).toEqual([[1.2, 1.3]]);
  });
});

describe("embedding meta persistence", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => cleanup());

  it("saves and loads meta", () => {
    const dbPath = join(TEST_DIR, "sub", "test.tdb");
    saveEmbeddingMeta(dbPath, { provider: "openai", model: "text-embedding-3-small", dim: 1024 });
    const loaded = loadEmbeddingMeta(dbPath);
    expect(loaded).toEqual({ provider: "openai", model: "text-embedding-3-small", dim: 1024 });
  });

  it("returns null when no meta file", () => {
    const dbPath = join(TEST_DIR, "nonexistent.tdb");
    expect(loadEmbeddingMeta(dbPath)).toBeNull();
  });
});

describe("validateEmbeddingDim", () => {
  it("returns true when dim matches", () => {
    const provider: EmbeddingProvider = { id: "test", model: "m", dim: 1024, embed: async () => [] };
    expect(validateEmbeddingDim(provider, 1024)).toBe(true);
  });

  it("returns false when dim does not match", () => {
    const provider: EmbeddingProvider = { id: "test", model: "m", dim: 1024, embed: async () => [] };
    expect(validateEmbeddingDim(provider, 768)).toBe(false);
  });
});
