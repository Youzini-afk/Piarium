import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ProviderConfigurationManager } from "../../src/provider-configuration.js";
import {
  createBackgroundInferenceRuntime,
  REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS,
  type BackgroundInferenceRuntime,
} from "../../src/harness/background-inference.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

const jsonResponse = (body: unknown) => (
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
);

const authorizationFromInit = (init: RequestInit | undefined): string | null => {
  const headers = init?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get("Authorization");
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === "authorization");
    return found?.[1] ?? null;
  }
  return headers.Authorization ?? headers.authorization ?? null;
};

async function setupBinding(options?: { modelId?: string; key?: string }) {
  const root = await mkdtemp(join(tmpdir(), "piarium-bg-inference-"));
  dirs.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    harness: {
      embedding: {
        protocol: "openai-compatible",
        providerId: "embed-provider",
        modelId: options?.modelId ?? "embed-1",
        dimensions: 2,
      },
      rerank: {
        protocol: "http-rerank",
        providerId: "embed-provider",
        modelId: "rerank-1",
      },
    },
  }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "embed-provider": {
        name: "Embed",
        baseUrl: "https://models.example/v1",
        api: "openai-completions",
        models: [],
      },
    },
  }));
  const runtime = await ModelRuntime.create({
    allowModelNetwork: true,
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const key = options?.key ?? "key-one";
  await runtime.setRuntimeApiKey("embed-provider", key);
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({
    "embed-provider": { type: "api_key", key },
  }));
  return { agentDir, cwd, runtime };
}

async function boundEmbed(
  inference: BackgroundInferenceRuntime,
  input: Omit<import("@piarium/protocol").HarnessEmbedParams, "configurationId" | "maxTokens">,
) {
  const described = await inference.describe();
  assert.equal(described.embedding.status, "ready");
  if (described.embedding.status !== "ready") throw new Error("embedding binding unavailable");
  return {
    ...input,
    configurationId: described.embedding.binding.configurationId,
    ...(described.embedding.binding.dimensions === undefined
      ? {}
      : { dimensions: described.embedding.binding.dimensions }),
    maxTokens: described.embedding.binding.maxTokens ?? REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS,
  };
}

describe("BackgroundInferenceRuntime", () => {
  it("embeds through the configured provider without exposing the credential", async () => {
    const { agentDir, cwd, runtime } = await setupBinding();
    const seen: Array<{ url: string; auth?: string | null }> = [];
    const inference = createBackgroundInferenceRuntime({
      agentDir,
      cwd,
      modelRuntime: runtime,
      fetchImpl: async (url, init) => {
        seen.push({
          url: String(url),
          auth: authorizationFromInit(init),
        });
        return jsonResponse({
          model: "embed-1",
          data: [{ index: 0, embedding: [1, 0] }],
        });
      },
    });
    const result = await inference.embed(await boundEmbed(inference, {
      purpose: "document",
      providerId: "embed-provider",
      modelId: "embed-1",
      protocol: "openai-compatible",
      items: [{ id: "c1", text: "alpha" }],
      batchId: "b1",
    }));
    assert.equal(result.space.modelId, "embed-1");
    assert.equal(result.space.dim, 2);
    assert.equal(result.items[0]?.id, "c1");
    assert.match(seen[0]?.url ?? "", /\/embeddings$/);
    assert.equal(seen[0]?.auth, "Bearer key-one");
    assert.doesNotMatch(JSON.stringify(result), /key-one/);
  });

  it("keeps the same space after credential rotation and changes space when the model changes", async () => {
    const first = await setupBinding({ key: "key-one" });
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async () => {
      calls.push("embed");
      return jsonResponse({
        data: [{ index: 0, embedding: [0, 1] }],
      });
    };
    const firstRuntime = createBackgroundInferenceRuntime({
      agentDir: first.agentDir,
      cwd: first.cwd,
      modelRuntime: first.runtime,
      fetchImpl,
    });
    const before = await firstRuntime.embed(await boundEmbed(firstRuntime, {
      purpose: "query",
      providerId: "embed-provider",
      modelId: "embed-1",
      protocol: "openai-compatible",
      items: [{ id: "q", text: "same body" }],
      batchId: "q1",
    }));
    const rotated = await ModelRuntime.create({
      allowModelNetwork: true,
      authPath: join(first.agentDir, "auth.json"),
      modelsPath: join(first.agentDir, "models.json"),
    });
    await rotated.setRuntimeApiKey("embed-provider", "key-two");
    await first.runtime.setRuntimeApiKey("embed-provider", "key-two");
    await writeFile(join(first.agentDir, "auth.json"), JSON.stringify({
      "embed-provider": { type: "api_key", key: "key-two" },
    }));
    const afterRotate = await firstRuntime.embed(await boundEmbed(firstRuntime, {
      purpose: "query",
      providerId: "embed-provider",
      modelId: "embed-1",
      protocol: "openai-compatible",
      items: [{ id: "q", text: "same body" }],
      batchId: "q2",
    }));
    assert.equal(afterRotate.space.spaceId, before.space.spaceId);

    await writeFile(join(first.agentDir, "settings.json"), JSON.stringify({
      harness: {
        embedding: {
          protocol: "openai-compatible",
          providerId: "embed-provider",
          modelId: "embed-2",
          dimensions: 2,
        },
      },
    }));
    const switched = createBackgroundInferenceRuntime({
      agentDir: first.agentDir,
      cwd: first.cwd,
      fetchImpl,
    });
    const next = await switched.embed(await boundEmbed(switched, {
      purpose: "query",
      providerId: "embed-provider",
      modelId: "embed-2",
      protocol: "openai-compatible",
      items: [{ id: "q", text: "same body" }],
      batchId: "q3",
    }));
    assert.notEqual(next.space.spaceId, before.space.spaceId);
    const recovered = createBackgroundInferenceRuntime({
      agentDir: first.agentDir,
      cwd: first.cwd,
      fetchImpl,
    });
    const restored = await recovered.embed(await boundEmbed(recovered, {
      purpose: "query",
      providerId: "embed-provider",
      modelId: "embed-2",
      protocol: "openai-compatible",
      items: [{ id: "q", text: "same body" }],
      batchId: "q4",
    }));
    assert.equal(restored.space.spaceId, next.space.spaceId);
    assert.equal(calls.length, 4);
  });

  it("ignores a trusted project provider redirect even when the shared chat runtime applied it", async () => {
    const { agentDir, cwd, runtime } = await setupBinding();
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "models.json"), JSON.stringify({
      providers: {
        "embed-provider": {
          baseUrl: "https://project-attacker.invalid/v1",
          api: "openai-completions",
          models: [],
        },
      },
    }));
    await new ProviderConfigurationManager({ agentDir }).apply(runtime, cwd, true);
    assert.equal(runtime.getProvider("embed-provider")?.baseUrl, "https://project-attacker.invalid/v1");
    const seen: string[] = [];
    const inference = createBackgroundInferenceRuntime({
      agentDir,
      cwd,
      modelRuntime: runtime,
      fetchImpl: async (url) => {
        seen.push(String(url));
        return jsonResponse({ data: [{ index: 0, embedding: [1, 0] }] });
      },
    });
    await inference.embed(await boundEmbed(inference, {
      purpose: "query",
      providerId: "embed-provider",
      modelId: "embed-1",
      protocol: "openai-compatible",
      items: [{ id: "q", text: "safe" }],
      batchId: "project-redirect",
    }));
    assert.match(seen[0] ?? "", /^https:\/\/models\.example\/v1\/embeddings$/);
    assert.doesNotMatch(seen[0] ?? "", /project-attacker/);
  });

  it("aborts the actual provider fetch through an explicit batch cancellation", async () => {
    const { agentDir, cwd, runtime } = await setupBinding();
    let fetchSignal: AbortSignal | undefined;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const inference = createBackgroundInferenceRuntime({
      agentDir,
      cwd,
      modelRuntime: runtime,
      fetchImpl: async (_url, init) => {
        fetchSignal = init?.signal ?? undefined;
        entered();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
    });
    const request = await boundEmbed(inference, {
      purpose: "query",
      providerId: "embed-provider",
      modelId: "embed-1",
      protocol: "openai-compatible",
      items: [{ id: "q", text: "cancel me" }],
      batchId: "cancel-fetch",
    });
    const pending = inference.embed(request);
    await started;
    assert.equal(inference.cancel(request.batchId), true);
    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
    assert.equal(fetchSignal?.aborted, true);
  });

  it("rejects stale dimensions, token limits, rerank endpoint, and document limits before HTTP", async () => {
    const { agentDir, cwd, runtime } = await setupBinding();
    let calls = 0;
    const inference = createBackgroundInferenceRuntime({
      agentDir,
      cwd,
      modelRuntime: runtime,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ data: [{ index: 0, embedding: [1, 0] }], results: [] });
      },
    });
    const embed = await boundEmbed(inference, {
      purpose: "query", providerId: "embed-provider", modelId: "embed-1",
      protocol: "openai-compatible", items: [{ id: "q", text: "stale" }], batchId: "stale-embed",
    });
    await assert.rejects(inference.embed({ ...embed, dimensions: 3 }), /dimensions/);
    await assert.rejects(inference.embed({ ...embed, batchId: "stale-tokens", maxTokens: embed.maxTokens + 1 }), /maxTokens/);
    const described = await inference.describe();
    assert.equal(described.rerank.status, "ready");
    if (described.rerank.status !== "ready") throw new Error("rerank binding unavailable");
    const binding = described.rerank.binding;
    const base = {
      configurationId: binding.configurationId,
      providerId: binding.providerId,
      modelId: binding.modelId,
      protocol: "http-rerank" as const,
      query: "q",
      documents: [{ id: "d", text: "body" }],
      batchId: "stale-rerank",
    };
    await assert.rejects(inference.rerank({ ...base, endpoint: "/other" }), /frozen binding/);
    await assert.rejects(inference.rerank({ ...base, batchId: "stale-doc-limit", maxDocumentTokens: 10 }), /frozen binding/);
    assert.equal(calls, 0);
  });

  it("changes the remote space when the credential-free endpoint configuration changes", async () => {
    const { agentDir, cwd, runtime } = await setupBinding();
    const urls: string[] = [];
    const inference = createBackgroundInferenceRuntime({
      agentDir,
      cwd,
      modelRuntime: runtime,
      fetchImpl: async (url) => {
        urls.push(String(url));
        return jsonResponse({ data: [{ index: 0, embedding: [1, 0] }] });
      },
    });
    const first = await inference.embed(await boundEmbed(inference, {
      purpose: "query", providerId: "embed-provider", modelId: "embed-1",
      protocol: "openai-compatible", items: [{ id: "q", text: "same" }], batchId: "endpoint-1",
    }));
    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        "embed-provider": {
          name: "Embed", baseUrl: "https://second.example/v1", api: "openai-completions", models: [],
        },
      },
    }));
    const second = await inference.embed(await boundEmbed(inference, {
      purpose: "query", providerId: "embed-provider", modelId: "embed-1",
      protocol: "openai-compatible", items: [{ id: "q", text: "same" }], batchId: "endpoint-2",
    }));
    assert.notEqual(second.space.configurationId, first.space.configurationId);
    assert.notEqual(second.space.spaceId, first.space.spaceId);
    assert.match(urls[1] ?? "", /^https:\/\/second\.example\/v1\/embeddings$/);
  });

  it("uses the selected model's endpoint ahead of the provider default", async () => {
    const { agentDir, cwd, runtime } = await setupBinding();
    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        "embed-provider": {
          baseUrl: "https://provider.example/v1",
          api: "openai-completions",
          models: [{ id: "embed-1", api: "openai-completions", baseUrl: "https://model.example/v2" }],
        },
      },
    }));
    const urls: string[] = [];
    const inference = createBackgroundInferenceRuntime({
      agentDir, cwd, modelRuntime: runtime,
      fetchImpl: async (url) => {
        urls.push(String(url));
        return jsonResponse({ data: [{ index: 0, embedding: [1, 0] }] });
      },
    });
    await inference.embed(await boundEmbed(inference, {
      purpose: "query", providerId: "embed-provider", modelId: "embed-1",
      protocol: "openai-compatible", items: [{ id: "q", text: "model endpoint" }], batchId: "model-endpoint",
    }));
    assert.match(urls[0] ?? "", /^https:\/\/model\.example\/v2\/embeddings$/);
  });
});
