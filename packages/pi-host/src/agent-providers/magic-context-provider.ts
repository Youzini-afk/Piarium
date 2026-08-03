import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  type JsonValue,
  type PiAgentDescriptor,
  type PiAgentProviderDescriptor,
  type PiAgentStatus,
} from "@piarium/protocol";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { agentProviderEntityId } from "./identity.js";
import type {
  AgentProviderAdapter,
  AgentProviderContext,
  AgentProviderListResult,
} from "./types.js";

const PROVIDER_ID = "magic-context";
const CONFIGURATION = { pluginId: "@cortexkit/pi-magic-context", section: "agents" } as const;
const HIDDEN_AGENT_KEYS = ["historian", "dreamer", "sidekick"] as const;
const AGENT_ESCALATION_FIELDS = ["prompt", "permission", "tools", "system_prompt"] as const;

interface LoadedConfig {
  config: Record<string, JsonValue>;
  path?: string;
  warning?: string;
}

interface MagicRole {
  description: string;
  id: string;
  kind: "internal" | "service";
  parent?: "dreamer" | "historian" | "sidekick";
}

const MAGIC_ROLES: readonly MagicRole[] = [
  {
    description: "Summarizes and recompacts long Pi sessions into durable context",
    id: "historian",
    kind: "service",
  },
  {
    description: "Runs scheduled and on-demand memory maintenance tasks",
    id: "dreamer",
    kind: "service",
  },
  {
    description: "Retrieves relevant project memory to augment the active prompt",
    id: "sidekick",
    kind: "service",
  },
  {
    description: "Historian pass used for explicit recompression",
    id: "historian-recomp",
    kind: "internal",
    parent: "historian",
  },
  {
    description: "Second-pass editor for historian output",
    id: "historian-editor",
    kind: "internal",
    parent: "historian",
  },
  {
    description: "Maintains generated architecture and structure documentation",
    id: "dreamer-docs",
    kind: "internal",
    parent: "dreamer",
  },
  {
    description: "Reviews dreamer results without tool access",
    id: "dreamer-reviewer",
    kind: "internal",
    parent: "dreamer",
  },
  {
    description: "Search-only retrospective over prior session memories",
    id: "dreamer-retrospective",
    kind: "internal",
    parent: "dreamer",
  },
  {
    description: "Read-only investigator used while refreshing project primers",
    id: "dreamer-primer-investigator",
    kind: "internal",
    parent: "dreamer",
  },
  {
    description: "Maps and verifies memories against the current source tree",
    id: "dreamer-memory-mapper",
    kind: "internal",
    parent: "dreamer",
  },
  {
    description: "Classifies memory records without tools",
    id: "dreamer-classifier",
    kind: "internal",
    parent: "dreamer",
  },
  {
    description: "Compiles queued notes into structured memory",
    id: "smart-note-compiler",
    kind: "internal",
    parent: "dreamer",
  },
];

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function homeRoot(): string {
  const configuredHome = process.env.HOME?.trim();
  return configuredHome && isAbsolute(configuredHome) ? resolve(configuredHome) : homedir();
}

function userConfigRoot(): string {
  const configured = process.env.XDG_CONFIG_HOME?.trim();
  return configured && isAbsolute(configured) ? resolve(configured) : join(homeRoot(), ".config");
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT"
  );
}

async function loadFirstConfig(paths: readonly string[]): Promise<LoadedConfig> {
  for (const path of paths) {
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) continue;
      return {
        config: {},
        path,
        warning: `Unable to read Magic Context configuration: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const errors: ParseError[] = [];
    const value = parse(content.replace(/^\uFEFF/, ""), errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (errors.length > 0 || !isRecord(value)) {
      const first = errors[0];
      return {
        config: {},
        path,
        warning: first
          ? `Invalid Magic Context JSONC (${printParseErrorCode(first.error)} at offset ${first.offset})`
          : "Magic Context configuration must contain an object",
      };
    }
    return { config: value, path };
  }
  return { config: {} };
}

function mergeConfig(
  base: Record<string, JsonValue>,
  override: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    merged[key] = isRecord(current) && isRecord(value) ? mergeConfig(current, value) : value;
  }
  return merged;
}

function safeProjectConfig(input: Record<string, JsonValue>): Record<string, JsonValue> {
  const project = structuredClone(input);
  for (const key of ["auto_update", "fail_closed_blocking", "language", "sqlite", "subc", "shadow_embedding"]) {
    delete project[key];
  }
  const pi = project.pi;
  if (isRecord(pi)) delete pi.subagent_extensions;
  const historian = project.historian;
  if (isRecord(historian)) {
    delete historian.model;
    delete historian.fallback_models;
  }
  for (const key of HIDDEN_AGENT_KEYS) {
    const block = project[key];
    if (!isRecord(block)) continue;
    for (const field of AGENT_ESCALATION_FIELDS) delete block[field];
  }
  return project;
}

function stringValue(record: Record<string, JsonValue> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(record: Record<string, JsonValue> | undefined, key: string): string[] | undefined {
  const value = record?.[key];
  if (!Array.isArray(value)) return undefined;
  const result = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return result.length ? result : undefined;
}

function roleStatus(
  providerEnabled: boolean,
  role: MagicRole,
  blocks: Record<string, Record<string, JsonValue> | undefined>,
): PiAgentStatus {
  if (!providerEnabled) return "disabled";
  const parent = role.parent ?? role.id;
  const block = blocks[parent];
  if (block?.disable === true) return "disabled";
  if (parent === "historian" || parent === "sidekick") {
    return stringValue(block, "model") ? "available" : "unconfigured";
  }
  return block ? "available" : "unconfigured";
}

export class MagicContextProvider implements AgentProviderAdapter {
  readonly descriptor: PiAgentProviderDescriptor;
  readonly #context: AgentProviderContext;
  readonly #loadError: string | undefined;

  constructor(context: AgentProviderContext, available: boolean, source?: string, loadError?: string) {
    this.#context = context;
    this.#loadError = loadError;
    this.descriptor = {
      actions: [],
      available,
      configuration: CONFIGURATION,
      description: "Context, memory, and autonomous maintenance roles owned by Magic Context",
      id: PROVIDER_ID,
      label: "Magic Context",
      ...(source === undefined ? {} : { source }),
    };
  }

  async list(): Promise<AgentProviderListResult> {
    if (!this.descriptor.available) {
      return {
        agents: [],
        diagnostics: [{
          message: this.#loadError ?? "Magic Context failed to load",
          providerId: PROVIDER_ID,
          severity: "error",
        }],
      };
    }
    const cwd = this.#context.cwd;
    const user = await loadFirstConfig([
      join(userConfigRoot(), "cortexkit", "magic-context.jsonc"),
      join(userConfigRoot(), "cortexkit", "magic-context.json"),
      join(this.#context.agentDir, "magic-context.jsonc"),
      join(this.#context.agentDir, "magic-context.json"),
    ]);
    const project = await loadFirstConfig([
      join(cwd, ".cortexkit", "magic-context.jsonc"),
      join(cwd, ".cortexkit", "magic-context.json"),
      join(cwd, ".pi", "magic-context.jsonc"),
      join(cwd, ".pi", "magic-context.json"),
    ]);
    const safeProject = safeProjectConfig(project.config);
    const config = mergeConfig(user.config, safeProject);
    const blocks: Record<string, Record<string, JsonValue> | undefined> = {
      dreamer: isRecord(config.dreamer) ? config.dreamer : undefined,
      historian: isRecord(config.historian) ? config.historian : undefined,
      sidekick: isRecord(config.sidekick) ? config.sidekick : undefined,
    };
    const providerEnabled = config.enabled !== false;
    const agents = MAGIC_ROLES.map((role): PiAgentDescriptor => {
      const parent = role.parent ?? role.id;
      const block = blocks[parent];
      const projectBlock = isRecord(safeProject[parent]) ? safeProject[parent] : undefined;
      const sourcePath = projectBlock ? project.path : user.path;
      const fallbackModels = stringList(block, "fallback_models");
      const model = stringValue(block, "model");
      const thinking = stringValue(block, "thinking_level");
      return {
        actions: [],
        configuration: CONFIGURATION,
        description: role.description,
        ...(fallbackModels === undefined ? {} : { fallbackModels }),
        id: agentProviderEntityId(PROVIDER_ID, role.kind, role.id),
        kind: role.kind,
        ...(model === undefined ? {} : { model }),
        name: role.id,
        providerId: PROVIDER_ID,
        source: { ...(sourcePath === undefined ? {} : { path: sourcePath }), scope: "runtime" },
        status: roleStatus(providerEnabled, role, blocks),
        ...(thinking === undefined ? {} : { thinking }),
      };
    });
    const diagnostics = [
      ...(user.warning
        ? [{ message: user.warning, ...(user.path ? { path: user.path } : {}), providerId: PROVIDER_ID, severity: "warning" as const }]
        : []),
      ...(project.warning
        ? [{ message: project.warning, ...(project.path ? { path: project.path } : {}), providerId: PROVIDER_ID, severity: "warning" as const }]
        : []),
    ];
    return { agents, diagnostics };
  }
}

export function findMagicContextExtension(context: AgentProviderContext): {
  available: boolean;
  loadError?: string;
  source?: string;
} | undefined {
  const loaded = context.session.resourceLoader.getExtensions();
  const extension = loaded.extensions.find((candidate) => {
    const identity = `${candidate.path}\n${candidate.resolvedPath}\n${candidate.sourceInfo.source}`.toLowerCase();
    return identity.includes("magic-context") || identity.includes("pi-magic-context");
  });
  if (extension) {
    return { available: true, source: extension.sourceInfo.source };
  }
  const error = loaded.errors.find((candidate) => candidate.path.toLowerCase().includes("magic-context"));
  return error
    ? { available: false, loadError: error.error, source: error.path }
    : undefined;
}
