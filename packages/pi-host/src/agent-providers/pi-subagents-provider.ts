import { randomUUID } from "node:crypto";
import {
  type AgentSession,
  type RegisteredTool,
  wrapRegisteredTool,
} from "@earendil-works/pi-coding-agent";
import type {
  JsonValue,
  PiAgentActionDescriptor,
  PiAgentDescriptor,
  PiAgentProviderActionResult,
  PiAgentProviderDescriptor,
  PiAgentSourceScope,
} from "@piarium/protocol";
import { HostError } from "../errors.js";
import { agentProviderEntityId } from "./identity.js";
import type {
  AgentProviderAdapter,
  AgentProviderContext,
  AgentProviderListResult,
} from "./types.js";

const PROVIDER_ID = "pi-subagents";
const CONFIGURATION = { pluginId: "pi-subagents", section: "agents" } as const;

const INSPECT_ACTION: PiAgentActionDescriptor = { id: "inspect", label: "Inspect" };
const UPDATE_ACTION: PiAgentActionDescriptor = {
  id: "update",
  label: "Edit",
  requiresScope: true,
};
const DELETE_ACTION: PiAgentActionDescriptor = {
  destructive: true,
  id: "delete",
  label: "Delete",
};
const EJECT_ACTION: PiAgentActionDescriptor = {
  id: "eject",
  label: "Copy to scope",
  requiresScope: true,
};
const DISABLE_ACTION: PiAgentActionDescriptor = {
  id: "disable",
  label: "Disable",
  requiresScope: true,
};
const ENABLE_ACTION: PiAgentActionDescriptor = {
  id: "enable",
  label: "Enable",
  requiresScope: true,
};
const RESET_ACTION: PiAgentActionDescriptor = {
  destructive: true,
  id: "reset",
  label: "Reset",
  requiresScope: true,
};

interface ParsedListEntry {
  description: string;
  kind: "delegatable" | "workflow";
  name: string;
  source: PiAgentSourceScope;
}

interface ParsedAgentDetail {
  aliases?: string[];
  description: string;
  fallbackModels?: string[];
  model?: string;
  name: string;
  packageName?: string;
  path?: string;
  source: PiAgentSourceScope;
  thinking?: string;
}

interface ParsedChainDetail {
  description: string;
  name: string;
  packageName?: string;
  path?: string;
  source: PiAgentSourceScope;
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value;
}

function optionalScope(record: Record<string, JsonValue>): "user" | "project" | undefined {
  const value = record.scope;
  if (value === undefined) return undefined;
  if (value !== "user" && value !== "project") {
    throw new HostError("invalid_params", "input.scope must be user or project");
  }
  return value;
}

function createConfigForScope(
  value: JsonValue,
  scope: "user" | "project",
  kind: "agent" | "workflow",
): Record<string, JsonValue> {
  let parsed: JsonValue = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as JsonValue;
    } catch {
      throw new HostError("invalid_params", "input.config must be an object or a JSON object string");
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HostError("invalid_params", "input.config must be an object or a JSON object string");
  }
  const config: Record<string, JsonValue> = {
    ...(parsed as Record<string, JsonValue>),
    scope,
  };
  if (kind === "workflow" && (!Array.isArray(config.steps) || config.steps.length === 0)) {
    throw new HostError("invalid_params", "input.config.steps is required for create-workflow");
  }
  if (kind === "agent" && config.steps !== undefined) {
    throw new HostError("invalid_params", "input.config.steps is only valid for create-workflow");
  }
  return config;
}

function toolResultText(result: unknown): { message: string; success: boolean } {
  if (typeof result !== "object" || result === null) {
    return { message: "pi-subagents returned an invalid result", success: false };
  }
  const record = result as {
    content?: Array<{ text?: unknown; type?: unknown }>;
    isError?: unknown;
  };
  const message = Array.isArray(record.content)
    ? record.content
        .filter((entry) => entry?.type === "text" && typeof entry.text === "string")
        .map((entry) => entry.text as string)
        .join("\n")
        .trim()
    : "";
  return {
    message: message || "pi-subagents returned no message",
    success: record.isError !== true,
  };
}

function parseList(text: string): ParsedListEntry[] {
  const entries: ParsedListEntry[] = [];
  let section: "agent" | "workflow" | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "Executable agents:") {
      section = "agent";
      continue;
    }
    if (line.trim() === "Chains:") {
      section = "workflow";
      continue;
    }
    if (line.endsWith("diagnostics:")) {
      section = undefined;
      continue;
    }
    if (!section) continue;
    const match = /^-\s+(.+?)\s+\((builtin|package|user|project)(?:,[^)]*)?\):\s*(.*)$/.exec(
      line.trim(),
    );
    if (!match) continue;
    entries.push({
      description: match[3] ?? "",
      kind: section === "agent" ? "delegatable" : "workflow",
      name: match[1] ?? "",
      source: match[2] as PiAgentSourceScope,
    });
  }
  return entries;
}

function parseAvailableNames(text: string): string[] {
  const match = /Available:\s*([^\r\n]+?)(?:\.|$)/.exec(text);
  if (!match || match[1]?.trim() === "none") return [];
  return [...new Set((match[1] ?? "").split(",").map((name) => name.trim()).filter(Boolean))];
}

function valueAfterLabel(text: string, label: string): string | undefined {
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith(`${label}:`));
  const value = line?.slice(label.length + 1).trim();
  return value || undefined;
}

function parseAgentDetail(text: string): ParsedAgentDetail | undefined {
  const header = /^Agent:\s+(.+?)\s+\((builtin|package|user|project)\)$/m.exec(text);
  if (!header) return undefined;
  const csv = (label: string) => valueAfterLabel(text, label)?.split(",").map((value) => value.trim()).filter(Boolean);
  const aliases = csv("Aliases");
  const fallbackModels = csv("Fallback models");
  const model = valueAfterLabel(text, "Model");
  const packageName = valueAfterLabel(text, "Package");
  const path = valueAfterLabel(text, "Path");
  const thinking = valueAfterLabel(text, "Thinking");
  return {
    ...(aliases?.length ? { aliases } : {}),
    description: valueAfterLabel(text, "Description") ?? "",
    ...(fallbackModels?.length ? { fallbackModels } : {}),
    ...(model ? { model } : {}),
    name: header[1] ?? "",
    ...(packageName ? { packageName } : {}),
    ...(path ? { path } : {}),
    source: header[2] as PiAgentSourceScope,
    ...(thinking ? { thinking } : {}),
  };
}

function parseChainDetail(text: string): ParsedChainDetail | undefined {
  const header = /^Chain:\s+(.+?)\s+\((package|user|project)\)$/m.exec(text);
  if (!header) return undefined;
  const packageName = valueAfterLabel(text, "Package");
  const path = valueAfterLabel(text, "Path");
  return {
    description: valueAfterLabel(text, "Description") ?? "",
    name: header[1] ?? "",
    ...(packageName ? { packageName } : {}),
    ...(path ? { path } : {}),
    source: header[2] as PiAgentSourceScope,
  };
}

function actionsFor(
  source: PiAgentSourceScope,
  disabled: boolean,
  kind: ParsedListEntry["kind"],
): PiAgentActionDescriptor[] {
  const actions: PiAgentActionDescriptor[] = [INSPECT_ACTION];
  if (source === "user" || source === "project") actions.push(UPDATE_ACTION, DELETE_ACTION);
  if (kind === "workflow") return actions;
  if (source === "builtin" || source === "package") actions.push(EJECT_ACTION);
  actions.push(disabled ? ENABLE_ACTION : DISABLE_ACTION, RESET_ACTION);
  return actions;
}

function descriptorFor(entry: ParsedListEntry, disabled: boolean): PiAgentDescriptor {
  return {
    actions: actionsFor(entry.source, disabled, entry.kind),
    configuration: CONFIGURATION,
    description: entry.description,
    id: agentProviderEntityId(PROVIDER_ID, entry.kind, entry.name),
    invocation: {
      command: entry.kind === "workflow" ? "run-chain" : "run",
      kind: "slash-command",
      taskSeparator: entry.kind === "workflow" ? "double-dash" : "space",
    },
    kind: entry.kind,
    name: entry.name,
    providerId: PROVIDER_ID,
    source: { scope: entry.source },
    status: disabled ? "disabled" : "available",
  };
}

export class PiSubagentsProvider implements AgentProviderAdapter {
  readonly descriptor: PiAgentProviderDescriptor;
  readonly #context: AgentProviderContext;
  readonly #tool: RegisteredTool | undefined;

  constructor(
    context: AgentProviderContext,
    tool: RegisteredTool | undefined,
    loadError?: string,
  ) {
    this.#context = context;
    this.#tool = tool;
    this.descriptor = {
      actions: [
        { id: "create-agent", label: "Create agent", requiresScope: true },
        { id: "create-workflow", label: "Create workflow", requiresScope: true },
        { id: "models", label: "Inspect model resolution" },
      ],
      available: tool !== undefined,
      configuration: CONFIGURATION,
      description: "Delegatable agents and workflows owned by pi-subagents",
      id: PROVIDER_ID,
      label: "Pi Subagents",
      ...(tool?.sourceInfo.source === undefined
        ? loadError === undefined ? {} : { source: loadError }
        : { source: tool.sourceInfo.source }),
    };
  }

  async list(): Promise<AgentProviderListResult> {
    if (!this.#tool) {
      return {
        agents: [],
        diagnostics: [{
          message: "pi-subagents is configured but its subagent tool failed to load",
          providerId: PROVIDER_ID,
          severity: "error",
        }],
      };
    }
    const listed = await this.#execute({ action: "list", agentScope: "both" });
    if (!listed.success) {
      return {
        agents: [],
        diagnostics: [{ message: listed.message, providerId: PROVIDER_ID, severity: "error" }],
      };
    }
    const entries = parseList(listed.message);
    const detailResults = await Promise.all(entries.map((entry) => this.#execute({
      action: "get",
      ...(entry.kind === "workflow" ? { chainName: entry.name } : { agent: entry.name }),
      agentScope: "both",
    })));
    const agents = entries.map((entry, index): PiAgentDescriptor => {
      const descriptor = descriptorFor(entry, false);
      const detailText = detailResults[index]?.message ?? "";
      if (entry.kind === "workflow") {
        const detail = parseChainDetail(detailText);
        if (!detail) return descriptor;
        return {
          ...descriptor,
          description: detail.description || descriptor.description,
          source: {
            ...(detail.packageName === undefined ? {} : { packageName: detail.packageName }),
            ...(detail.path === undefined ? {} : { path: detail.path }),
            scope: detail.source,
          },
        };
      }
      const detail = parseAgentDetail(detailText);
      if (!detail) return descriptor;
      return {
        ...descriptor,
        ...(detail.aliases === undefined ? {} : { aliases: detail.aliases }),
        description: detail.description || descriptor.description,
        ...(detail.fallbackModels === undefined ? {} : { fallbackModels: detail.fallbackModels }),
        ...(detail.model === undefined ? {} : { model: detail.model }),
        source: {
          ...(detail.packageName === undefined ? {} : { packageName: detail.packageName }),
          ...(detail.path === undefined ? {} : { path: detail.path }),
          scope: detail.source,
        },
        ...(detail.thinking === undefined ? {} : { thinking: detail.thinking }),
      };
    });
    const activeNames = new Set(
      agents.filter((agent) => agent.kind === "delegatable").map((agent) => agent.name),
    );
    const probe = await this.#execute({
      action: "get",
      agent: "__piarium_catalog_probe__",
      agentScope: "both",
    });
    const missingNames = parseAvailableNames(probe.message).filter((name) => !activeNames.has(name));
    for (const name of missingNames) {
      const detailResult = await this.#execute({ action: "get", agent: name, agentScope: "both" });
      const detail = parseAgentDetail(detailResult.message);
      if (!detail) continue;
      agents.push({
        ...descriptorFor(
          { description: detail.description, kind: "delegatable", name: detail.name, source: detail.source },
          true,
        ),
        ...(detail.aliases === undefined ? {} : { aliases: detail.aliases }),
        ...(detail.fallbackModels === undefined ? {} : { fallbackModels: detail.fallbackModels }),
        ...(detail.model === undefined ? {} : { model: detail.model }),
        source: {
          ...(detail.packageName === undefined ? {} : { packageName: detail.packageName }),
          ...(detail.path === undefined ? {} : { path: detail.path }),
          scope: detail.source,
        },
        ...(detail.thinking === undefined ? {} : { thinking: detail.thinking }),
      });
    }
    agents.sort((left, right) => left.name.localeCompare(right.name));
    return { agents, diagnostics: [] };
  }

  async action(
    action: string,
    agentId: string | undefined,
    input: JsonValue | undefined,
  ): Promise<PiAgentProviderActionResult> {
    if (!this.#tool) throw new HostError("agent_provider_unavailable", "pi-subagents is unavailable");
    const record = asRecord(input);
    const scope = optionalScope(record);
    if (scope === "project" && !this.#context.projectTrusted) {
      throw new HostError("project_not_trusted", "Project is not trusted; refusing to change project agents");
    }
    if (action === "models") {
      return this.#result(action, agentId, await this.#execute({ action: "models" }));
    }
    if (action === "create-agent" || action === "create-workflow") {
      if (!scope) throw new HostError("invalid_params", "input.scope is required");
      if (record.config === undefined) throw new HostError("invalid_params", "input.config is required");
      const result = await this.#execute({
        action: "create",
        agentScope: scope,
        // pi-subagents currently chooses the create destination from config.scope,
        // while agentScope controls discovery and other mutations. Keep the
        // trusted top-level Piarium scope authoritative in both channels.
        config: createConfigForScope(
          record.config,
          scope,
          action === "create-workflow" ? "workflow" : "agent",
        ),
      });
      if (result.success) await this.#context.session.reload();
      return this.#result(action, undefined, result);
    }
    if (!agentId) throw new HostError("invalid_params", "agentId is required");
    const agent = (await this.list()).agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new HostError("agent_not_found", `Unknown pi-subagents agent: ${agentId}`);
    const targetKey = agent.kind === "workflow" ? "chainName" : "agent";
    const params: Record<string, unknown> = { action, [targetKey]: agent.name };
    const mutable = new Set(["update", "delete", "eject", "disable", "enable", "reset"]);
    if (!new Set(["inspect", ...mutable]).has(action)) {
      throw new HostError("unsupported_agent_action", `Unsupported pi-subagents action: ${action}`);
    }
    params.action = action === "inspect" ? "get" : action;
    if (action === "update") {
      if (record.config === undefined) throw new HostError("invalid_params", "input.config is required");
      params.config = record.config;
    }
    const effectiveScope = scope
      ?? (agent.source.scope === "user" || agent.source.scope === "project"
        ? agent.source.scope
        : undefined);
    if (["update", "delete", "eject", "disable", "enable", "reset"].includes(action)) {
      if (!effectiveScope) throw new HostError("invalid_params", "input.scope is required");
      if (effectiveScope === "project" && !this.#context.projectTrusted) {
        throw new HostError("project_not_trusted", "Project is not trusted; refusing to change project agents");
      }
      params.agentScope = effectiveScope;
    } else {
      params.agentScope = "both";
    }
    const result = await this.#execute(params);
    if (result.success && mutable.has(action)) await this.#context.session.reload();
    return this.#result(action, agentId, result);
  }

  async #execute(params: Record<string, unknown>): Promise<{ message: string; success: boolean }> {
    if (!this.#tool) return { message: "pi-subagents is unavailable", success: false };
    const wrapped = wrapRegisteredTool(this.#tool, this.#context.session.extensionRunner);
    try {
      return toolResultText(await wrapped.execute(`piarium-${randomUUID()}`, params as never));
    } catch (error) {
      return {
        message: error instanceof Error ? error.message : String(error),
        success: false,
      };
    }
  }

  #result(
    action: string,
    agentId: string | undefined,
    result: { message: string; success: boolean },
  ): PiAgentProviderActionResult {
    return {
      ...(agentId === undefined ? {} : { agentId }),
      data: { action },
      message: result.message,
      providerId: PROVIDER_ID,
      success: result.success,
    };
  }
}

export function findPiSubagentsTool(session: AgentSession): RegisteredTool | undefined {
  return session.extensionRunner
    .getAllRegisteredTools()
    .find((tool) => tool.definition.name === "subagent");
}
