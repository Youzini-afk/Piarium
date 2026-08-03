import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { HostEvent, HostEventData } from "@piarium/protocol";
import { HostError } from "../src/errors.js";
import { SessionHost } from "../src/session-host.js";

function createHost(agentDir: string, trusted: boolean): SessionHost {
  return new SessionHost({
    agentDir,
    emit: <E extends HostEvent>(_event: E, _data: HostEventData<E>) => undefined,
    projectTrustOverride: trusted,
  });
}

describe("SessionHost agent providers", () => {
  it("aggregates pi-subagents and Magic Context without overriding plugin ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-agent-providers-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    const home = join(root, "home");
    const actionLog = join(root, "subagent-actions.jsonl");
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(join(home, ".config", "cortexkit"), { recursive: true });
    await mkdir(join(cwd, ".cortexkit"), { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "pi-subagents-test.ts"),
      `import { appendFileSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
export default function (pi: any) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Fake management-compatible subagent tool",
    parameters: Type.Object({}, { additionalProperties: true }),
    async execute(_id: string, params: any) {
      appendFileSync(${JSON.stringify(actionLog)}, JSON.stringify(params) + "\\n", "utf8");
      if (params.action === "list") return { content: [{ type: "text", text: "Executable agents:\\n- custom (user): Custom role\\n- worker (builtin, context: fork): Built-in worker\\n\\nChains:\\n- verify (project): Verify workflow" }], details: { mode: "management", results: [] } };
      if (params.action === "get" && params.agent === "custom") return { content: [{ type: "text", text: "Agent: custom (user)\\nPath: /user/custom.md\\nDescription: Custom role\\nAliases: helper\\nModel: test/custom\\nFallback models: test/fallback\\nThinking: medium" }], details: { mode: "management", results: [] } };
      if (params.action === "get" && params.agent === "worker") return { content: [{ type: "text", text: "Agent: worker (builtin)\\nPath: /builtin/worker.md\\nDescription: Built-in worker" }], details: { mode: "management", results: [] } };
      if (params.action === "get" && params.agent === "disabled") return { content: [{ type: "text", text: "Agent: disabled (builtin)\\nPath: /builtin/disabled.md\\nDescription: Disabled role\\nModel: test/model\\nThinking: high\\nDisabled: true" }], details: { mode: "management", results: [] } };
      if (params.action === "get" && params.chainName === "verify") return { content: [{ type: "text", text: "Chain: verify (project)\\nPath: /project/verify.chain.md\\nDescription: Verify workflow\\n\\nSteps:\\n1. worker" }], details: { mode: "management", results: [] } };
      if (params.action === "get") return { content: [{ type: "text", text: "Agent 'missing' not found. Available: custom, disabled, worker." }], isError: true, details: { mode: "management", results: [] } };
      return { content: [{ type: "text", text: "Applied " + params.action }], details: { mode: "management", results: [] } };
    },
  });
}
`,
      "utf8",
    );
    await writeFile(
      join(agentDir, "extensions", "magic-context-test.ts"),
      `export default function (pi: any) {
  pi.registerCommand("ctx-test", { description: "Magic Context marker", handler() {} });
}
`,
      "utf8",
    );
    await writeFile(
      join(agentDir, "extensions", "generic-agent-provider.ts"),
      `export default function (pi: any) {
  pi.events.on("piarium.agent-provider.discover/v1", (discovery: any) => {
    discovery.register({
      bridgeVersion: 1,
      descriptor: {
        actions: [{ id: "inspect", label: "Inspect" }],
        available: true,
        configuration: { pluginId: "example-agents", section: "agents" },
        description: "Agents supplied by an unrelated extension",
        id: "example-agent-provider",
        label: "Example agents",
        source: "project:generic-agent-provider",
      },
      list: () => ({
        agents: [{
          actions: [{ id: "inspect", label: "Inspect" }],
          configuration: { pluginId: "example-agents", section: "agents" },
          description: "Agent discovered through the public bridge",
          id: "example-agent-provider:reviewer",
          kind: "profile",
          name: "reviewer",
          source: { packageName: "example-agents", scope: "package" },
          status: "available",
        }],
        diagnostics: [],
      }),
      action: ({ action, agentId }: any) => ({
        agentId,
        message: "bridged " + action,
        providerId: "ignored-by-host",
        success: true,
      }),
    });
  });
}
`,
      "utf8",
    );
    await writeFile(
      join(home, ".config", "cortexkit", "magic-context.jsonc"),
      `{
  // User-owned historian selection must win.
  "historian": { "model": "user/historian", "fallback_models": ["user/fallback"] },
  "dreamer": { "model": "user/dreamer" },
  "sidekick": { "model": "user/sidekick", "thinking_level": "low" }
}
`,
      "utf8",
    );
    await writeFile(
      join(cwd, ".cortexkit", "magic-context.jsonc"),
      `{
  "historian": { "model": "project/must-not-win", "disable": false },
  "dreamer": { "model": "project/dreamer", "prompt": "must be ignored" }
}
`,
      "utf8",
    );
    const host = createHost(agentDir, true);
    try {
      await host.openCatalogContext(cwd);
      const catalog = await host.listAgentProviders();
      assert.deepEqual(catalog.providers.map((provider) => provider.id).sort(), [
        "example-agent-provider",
        "magic-context",
        "pi-subagents",
      ]);
      const byName = new Map(catalog.agents.map((agent) => [`${agent.providerId}:${agent.name}`, agent]));
      assert.equal(byName.get("pi-subagents:worker")?.kind, "delegatable");
      assert.deepEqual(byName.get("pi-subagents:worker")?.invocation, {
        command: "run",
        kind: "slash-command",
        taskSeparator: "space",
      });
      assert.equal(byName.get("pi-subagents:custom")?.source.scope, "user");
      assert.equal(byName.get("pi-subagents:custom")?.source.path, "/user/custom.md");
      assert.equal(byName.get("pi-subagents:custom")?.model, "test/custom");
      assert.deepEqual(byName.get("pi-subagents:custom")?.fallbackModels, ["test/fallback"]);
      assert.equal(byName.get("pi-subagents:verify")?.kind, "workflow");
      assert.deepEqual(byName.get("pi-subagents:verify")?.invocation, {
        command: "run-chain",
        kind: "slash-command",
        taskSeparator: "double-dash",
      });
      assert.deepEqual(
        byName.get("pi-subagents:verify")?.actions.map((action) => action.id),
        ["inspect", "update", "delete"],
      );
      assert.equal(byName.get("pi-subagents:disabled")?.status, "disabled");
      assert.equal(byName.get("pi-subagents:disabled")?.model, "test/model");
      assert.equal(byName.get("magic-context:historian")?.model, "user/historian");
      assert.deepEqual(byName.get("magic-context:historian")?.fallbackModels, ["user/fallback"]);
      assert.equal(byName.get("magic-context:dreamer")?.model, "project/dreamer");
      assert.equal(byName.get("magic-context:sidekick")?.thinking, "low");
      assert.equal(byName.get("magic-context:sidekick")?.kind, "service");
      assert.equal(byName.get("magic-context:dreamer-reviewer")?.kind, "internal");
      assert.equal(byName.get("example-agent-provider:reviewer")?.kind, "profile");
      assert.equal(
        byName.get("example-agent-provider:reviewer")?.configuration?.pluginId,
        "example-agents",
      );

      const bridged = await host.runAgentProviderAction(
        "example-agent-provider",
        "inspect",
        "example-agent-provider:reviewer",
        undefined,
      );
      assert.equal(bridged.providerId, "example-agent-provider");
      assert.equal(bridged.message, "bridged inspect");

      const custom = byName.get("pi-subagents:custom");
      assert.ok(custom);
      const updated = await host.runAgentProviderAction(
        "pi-subagents",
        "update",
        custom.id,
        { config: { description: "Updated role" }, scope: "user" },
      );
      assert.equal(updated.success, true);
      assert.match(updated.message, /Applied update/);
      const createdProjectAgent = await host.runAgentProviderAction(
        "pi-subagents",
        "create-agent",
        undefined,
        {
          config: JSON.stringify({
            description: "Project-scoped role",
            name: "project-role",
            scope: "user",
          }),
          scope: "project",
        },
      );
      assert.equal(createdProjectAgent.success, true);
      await assert.rejects(
        host.runAgentProviderAction(
          "pi-subagents",
          "create-workflow",
          undefined,
          { config: { description: "Missing steps", name: "broken-workflow" }, scope: "user" },
        ),
        (error: unknown) => error instanceof HostError && error.code === "invalid_params",
      );
      const actions = (await readFile(actionLog, "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.ok(
        actions.some(
          (action) =>
            action.action === "update"
            && action.agent === "custom"
            && action.agentScope === "user",
        ),
      );
      assert.ok(
        actions.some(
          (action) =>
            action.action === "create"
            && action.agentScope === "project"
            && typeof action.config === "object"
            && action.config !== null
            && (action.config as Record<string, unknown>).scope === "project",
        ),
      );
      await assert.rejects(
        host.runAgentProviderAction("magic-context", "update", undefined, {}),
        (error: unknown) => error instanceof HostError && error.code === "unsupported_agent_action",
      );
    } finally {
      await host.dispose();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects project-scoped provider mutations when the project is untrusted", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-agent-provider-trust-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "pi-subagents-test.ts"),
      `import { Type } from "@earendil-works/pi-ai";
export default function (pi: any) {
  pi.registerTool({ name: "subagent", label: "Subagent", description: "test", parameters: Type.Object({}, { additionalProperties: true }), async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; } });
}
`,
      "utf8",
    );
    const host = createHost(agentDir, false);
    try {
      await host.openCatalogContext(cwd);
      await assert.rejects(
        host.runAgentProviderAction(
          "pi-subagents",
          "create-agent",
          undefined,
          { config: { description: "No", name: "blocked" }, scope: "project" },
        ),
        (error: unknown) => error instanceof HostError && error.code === "project_not_trusted",
      );
    } finally {
      await host.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("prefers a plugin-owned provider bridge over the built-in fallback adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "piarium-agent-provider-priority-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      join(agentDir, "extensions", "pi-subagents-owned-provider.ts"),
      `import { Type } from "@earendil-works/pi-ai";
export default function (pi: any) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Fallback-compatible tool",
    parameters: Type.Object({}, { additionalProperties: true }),
    async execute() {
      return { content: [{ type: "text", text: "Executable agents:\\n- fallback (user): Must not win" }], details: {} };
    },
  });
  pi.events.on("piarium.agent-provider.discover/v1", (discovery: any) => {
    discovery.register({
      bridgeVersion: 1,
      descriptor: {
        actions: [], available: true, description: "Plugin-owned catalog",
        id: "pi-subagents", label: "Pi Subagents owned",
      },
      list: () => ({
        agents: [{
          actions: [], description: "Authoritative plugin entry", id: "owned",
          kind: "delegatable", name: "owned", source: { scope: "runtime" }, status: "available",
        }],
        diagnostics: [],
      }),
    });
  });
}
`,
      "utf8",
    );
    const host = createHost(agentDir, true);
    try {
      await host.openCatalogContext(cwd);
      const catalog = await host.listAgentProviders();
      assert.deepEqual(catalog.providers.map((provider) => provider.id), ["pi-subagents"]);
      assert.equal(catalog.providers[0]?.label, "Pi Subagents owned");
      assert.deepEqual(catalog.agents.map((agent) => agent.name), ["owned"]);
    } finally {
      await host.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });
});
