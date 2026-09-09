import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createBackgroundInferenceRuntime } from "../../src/harness/background-inference.js";

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

describe("BackgroundInferenceRuntime", () => {
  it("embeds through the configured provider without exposing the credential", async () => {
    const { agentDir, cwd, runtime } = await setupBinding();
    const seen: Array<{ url: string; auth?: string | null }> = [];
    const inference = createBackgroundInferenceRuntime({
      agentDir,
      cwd,
      modelRuntime: runtime,
      projectTrustOverride: true,
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
    const result = await inference.embed({
      purpose: "document",
      providerId: "embed-provider",
      modelId: "embed-1",
      protocol: "openai-compatible",
      items: [{ id: "c1", text: "alpha" }],
      batchId: "b1",
    });
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
      projectTrustOverride: true,
      fetchImpl,
    });
    const before = await firstRuntime.embed({
      purpose: "query",
      providerId: "embed-provider",
      modelId: "embed-1",
      protocol: "openai-compatible",
      items: [{ id: "q", text: "same body" }],
      batchId: "q1",
    });
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
    const afterRotate = await firstRuntime.embed({
      purpose: "query",
      providerId: "embed-provider",
      modelId: "embed-1",
      protocol: "openai-compatible",
      items: [{ id: "q", text: "same body" }],
      batchId: "q2",
    });
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
      projectTrustOverride: true,
      fetchImpl,
    });
    const next = await switched.embed({
      purpose: "query",
      providerId: "embed-provider",
      modelId: "embed-2",
      protocol: "openai-compatible",
      items: [{ id: "q", text: "same body" }],
      batchId: "q3",
    });
    assert.notEqual(next.space.spaceId, before.space.spaceId);
    const recovered = createBackgroundInferenceRuntime({
      agentDir: first.agentDir,
      cwd: first.cwd,
      projectTrustOverride: true,
      fetchImpl,
    });
    const restored = await recovered.embed({
      purpose: "query",
      providerId: "embed-provider",
      modelId: "embed-2",
      protocol: "openai-compatible",
      items: [{ id: "q", text: "same body" }],
      batchId: "q4",
    });
    assert.equal(restored.space.spaceId, next.space.spaceId);
    assert.equal(calls.length, 4);
  });
});
