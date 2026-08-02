import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProviderConfigInput } from "@piarium/protocol";
import { ProviderConfigurationManager } from "../src/provider-configuration.js";

function config(
  id: string,
  modelId: string,
  baseUrl = "https://models.example.test/v1",
): ProviderConfigInput {
  return {
    api: "openai-completions",
    baseUrl,
    id,
    models: [
      {
        contextWindow: 32_768,
        id: modelId,
        input: ["text", "image"],
        maxTokens: 4_096,
        name: modelId,
        reasoning: true,
      },
    ],
    name: `Provider ${id}`,
  };
}

describe("ProviderConfigurationManager", () => {
  it("writes native Pi models.json while preserving comments and configured keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-provider-config-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(agentDir, "models.json"),
      `{
  // Keep this operator note.
  "providers": {
    "local": {
      "name": "Old name",
      "baseUrl": "https://old.example.test/v1",
      "api": "openai-completions",
      "apiKey": "$PIARIUM_TEST_KEY",
      "models": []
    }
  }
}
`,
      { mode: 0o600 },
    );
    const runtime = await ModelRuntime.create({
      allowModelNetwork: false,
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const manager = new ProviderConfigurationManager({ agentDir });
    try {
      const details = await manager.upsert(runtime, cwd, "user", config("local", "local-model"));
      assert.equal(details.effectiveScope, "user");
      assert.equal(details.config?.models?.[0]?.id, "local-model");
      assert.equal(details.locations.user.exists, true);
      const content = await readFile(join(agentDir, "models.json"), "utf8");
      assert.match(content, /Keep this operator note/);
      assert.match(content, /\$PIARIUM_TEST_KEY/);
      assert.doesNotMatch(JSON.stringify(details), /PIARIUM_TEST_KEY/);
      assert.equal(runtime.getModel("local", "local-model")?.input.includes("image"), true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("layers project and explicit custom Pi configurations over the user catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-provider-layers-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    const customPath = join(root, "operator", "models.json");
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const runtime = await ModelRuntime.create({
      allowModelNetwork: false,
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const manager = new ProviderConfigurationManager({ agentDir, customConfigPath: customPath });
    try {
      await manager.upsert(runtime, cwd, "user", config("layered", "user-model"));
      await manager.upsert(runtime, cwd, "project", config("layered", "project-model"));
      const details = await manager.upsert(
        runtime,
        cwd,
        "custom",
        config("layered", "custom-model"),
      );
      assert.equal(details.effectiveScope, "custom");
      assert.deepEqual(
        runtime.getModels("layered").map((model) => model.id),
        ["user-model", "project-model", "custom-model"],
      );
      assert.equal(details.locations.project.exists, true);
      assert.equal(details.locations.custom.exists, true);

      const afterCustomDelete = await manager.delete(runtime, cwd, "layered", "custom");
      assert.equal(afterCustomDelete.effectiveScope, "project");
      assert.deepEqual(
        runtime.getModels("layered").map((model) => model.id),
        ["user-model", "project-model"],
      );
      const afterAllDelete = await manager.delete(runtime, cwd, "layered", "all");
      assert.equal(afterAllDelete.effectiveScope, undefined);
      assert.equal(runtime.getProvider("layered"), undefined);

      await manager.upsert(runtime, cwd, "user", config("partial", "base-model"));
      const partial = await manager.upsert(runtime, cwd, "project", {
        baseUrl: "http://127.0.0.1:11434/v1",
        id: "partial",
      });
      assert.equal(partial.effectiveScope, "project");
      assert.equal(partial.config?.api, undefined);
      assert.equal(partial.config?.models, undefined);
      assert.equal(runtime.getModel("partial", "base-model")?.baseUrl, "http://127.0.0.1:11434/v1");

      const longProviderId = `provider-${"x".repeat(512)}`;
      const longIdDetails = await manager.upsert(
        runtime,
        cwd,
        "project",
        config(longProviderId, "long-id-model"),
      );
      assert.equal(longIdDetails.providerId, longProviderId);

      const unrestrictedProviderId = "本地 provider/@experimental";
      const unrestrictedIdDetails = await manager.upsert(
        runtime,
        cwd,
        "project",
        config(unrestrictedProviderId, "unrestricted-id-model"),
      );
      assert.equal(unrestrictedIdDetails.providerId, unrestrictedProviderId);

      await assert.rejects(
        manager.upsert(runtime, cwd, "project", {
          id: "invalid-model-definition",
          models: [{ id: "missing-api-and-base-url" }],
        }),
        /does not define an API/,
      );
      assert.equal(
        (await manager.getDetails(runtime, cwd, "invalid-model-definition")).locations.project.exists,
        false,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
