import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ProviderConfigurationManager } from "../src/provider-configuration.js";
import { discoverProviderModels } from "../src/provider-model-discovery.js";

describe("provider model discovery", () => {
  it("supports authenticated HTTP providers on localhost without a special opt-in", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-provider-discovery-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    let authorization = "";
    let requestedUrl = "";
    const server = createServer((request, response) => {
      authorization = request.headers.authorization ?? "";
      requestedUrl = request.url ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: [
            {
              capabilities: { reasoning: true },
              context_window: 65_536,
              id: "discovered-model",
              input_modalities: ["text", "image"],
              max_output_tokens: 8_192,
              name: "Discovered model",
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const runtime = await ModelRuntime.create({
      allowModelNetwork: false,
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const manager = new ProviderConfigurationManager({ agentDir });
    try {
      await manager.upsert(runtime, cwd, "user", {
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        id: "discovery-test",
        models: [],
        name: "Discovery test",
      });
      await runtime.setRuntimeApiKey("discovery-test", "secret-test-key", {
        allowNetwork: false,
      });
      const result = await discoverProviderModels({
        configuration: manager,
        cwd,
        providerId: "discovery-test",
        runtime,
      });
      assert.equal(requestedUrl, "/v1/models");
      assert.equal(authorization, "Bearer secret-test-key");
      assert.deepEqual(result.models, [
        {
          contextWindow: 65_536,
          id: "discovered-model",
          input: ["text", "image"],
          maxTokens: 8_192,
          name: "Discovered model",
          reasoning: true,
        },
      ]);
    } finally {
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
      await rm(root, { force: true, recursive: true });
    }
  });

  it("discovers models from anonymous HTTP endpoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-provider-anonymous-discovery-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const authorizations: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      authorizations.push(request.headers.authorization);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "anonymous-model" }] }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const runtime = await ModelRuntime.create({
      allowModelNetwork: false,
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const manager = new ProviderConfigurationManager({ agentDir });
    try {
      const result = await discoverProviderModels({
        config: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          id: "anonymous-discovery",
          models: [],
        },
        configuration: manager,
        cwd,
        providerId: "anonymous-discovery",
        runtime,
      });
      assert.equal(authorizations[0], undefined);
      assert.equal(result.models[0]?.id, "anonymous-model");
      await discoverProviderModels({
        apiKey: "one-shot-draft-key",
        config: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          id: "anonymous-discovery",
          models: [],
        },
        configuration: manager,
        cwd,
        providerId: "anonymous-discovery",
        runtime,
      });
      assert.equal(authorizations[1], "Bearer one-shot-draft-key");
      assert.equal(runtime.getProviderAuthStatus("anonymous-discovery").configured, false);
    } finally {
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
      await rm(root, { force: true, recursive: true });
    }
  });
});
