import type {
  JsonValue,
  PiAgentCatalogSnapshot,
  PiAgentProviderActionResult,
} from "@piarium/protocol";
import { HostError } from "../errors.js";
import { findMagicContextExtension, MagicContextProvider } from "./magic-context-provider.js";
import { findPiSubagentsTool, PiSubagentsProvider } from "./pi-subagents-provider.js";
import type { AgentProviderAdapter, AgentProviderContext } from "./types.js";

export class AgentProviderRegistry {
  readonly #context: AgentProviderContext;

  constructor(context: AgentProviderContext) {
    this.#context = context;
  }

  async list(): Promise<PiAgentCatalogSnapshot> {
    const adapters = this.#adapters();
    const results = await Promise.allSettled(adapters.map((adapter) => adapter.list()));
    const agents: PiAgentCatalogSnapshot["agents"] = [];
    const diagnostics: PiAgentCatalogSnapshot["diagnostics"] = [];
    for (const [index, result] of results.entries()) {
      const provider = adapters[index];
      if (!provider) continue;
      if (result.status === "fulfilled") {
        agents.push(...result.value.agents);
        diagnostics.push(...result.value.diagnostics);
      } else {
        diagnostics.push({
          message: result.reason instanceof Error ? result.reason.message : String(result.reason),
          providerId: provider.descriptor.id,
          severity: "error",
        });
      }
    }
    agents.sort((left, right) =>
      left.providerId.localeCompare(right.providerId) || left.name.localeCompare(right.name),
    );
    return {
      agents,
      diagnostics,
      projectTrusted: this.#context.projectTrusted,
      providers: adapters.map((adapter) => adapter.descriptor),
    };
  }

  async action(
    providerId: string,
    action: string,
    agentId: string | undefined,
    input: JsonValue | undefined,
  ): Promise<PiAgentProviderActionResult> {
    const adapter = this.#adapters().find((candidate) => candidate.descriptor.id === providerId);
    if (!adapter) throw new HostError("agent_provider_not_found", `Unknown agent provider: ${providerId}`);
    if (!adapter.action) {
      throw new HostError(
        "unsupported_agent_action",
        `${adapter.descriptor.label} is configured through its plugin-owned settings`,
      );
    }
    return adapter.action(action, agentId, input);
  }

  #adapters(): AgentProviderAdapter[] {
    const adapters: AgentProviderAdapter[] = [];
    const extensions = this.#context.session.resourceLoader.getExtensions();
    const subagentsTool = findPiSubagentsTool(this.#context.session);
    const subagentsError = subagentsTool
      ? undefined
      : extensions.errors.find((entry) => entry.path.toLowerCase().includes("pi-subagents"));
    if (subagentsTool || subagentsError) {
      adapters.push(
        new PiSubagentsProvider(this.#context, subagentsTool, subagentsError?.error),
      );
    }
    const magic = findMagicContextExtension(this.#context);
    if (magic) {
      adapters.push(
        new MagicContextProvider(
          this.#context,
          magic.available,
          magic.source,
          magic.loadError,
        ),
      );
    }
    return adapters;
  }
}
