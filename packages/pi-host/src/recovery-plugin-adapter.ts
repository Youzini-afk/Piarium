import type {
  AgentSession,
  EventBus,
  ExtensionFactory,
  ResolvedCommand,
} from "@earendil-works/pi-coding-agent";
import type {
  ImageAttachment,
  RecoveryAction,
  RecoveryMode,
  RecoveryProviderDescriptor,
  RecoveryRepairAction,
  RecoveryStatus,
} from "@piarium/protocol";
import { HostError } from "./errors.js";

export const RECOVERY_BRIDGE_CHANNEL = "piarium.recovery.discover/v1";
export const RECOVERY_BRIDGE_VERSION = 1 as const;

interface RecoveryBridgeResponse {
  editorImages?: ImageAttachment[];
  editorText?: string;
  outcome?: "applied" | "cancelled" | "unknown";
}

interface RecoveryBridgeRequest {
  action: RecoveryAction;
  mode?: RecoveryMode;
  name?: string;
  sessionId: string;
  summarize?: boolean;
  targetId?: string;
}

interface RecoveryBridgeProvider {
  actions: RecoveryAction[];
  bridgeVersion: number;
  execute(request: RecoveryBridgeRequest): Promise<RecoveryBridgeResponse | void> | RecoveryBridgeResponse | void;
  id: string;
  modes: RecoveryMode[];
  name: string;
  source?: string;
}

interface RecoveryBridgeDiscovery {
  register(provider: unknown): void;
  version: typeof RECOVERY_BRIDGE_VERSION;
}

export interface RecoveryPluginContext {
  configuredSources: string[];
  loadedExtensions: string[];
}

export interface RecoveryPluginExecution {
  editorImages?: ImageAttachment[];
  editorText?: string;
  handledBy: string;
  outcome: "applied" | "cancelled" | "unknown";
}

const RECOVERY_ACTIONS = new Set<RecoveryAction>([
  "navigate",
  "undo",
  "redo",
  "checkpoint",
  "repair",
  "repair-typo",
  "repair-destructive",
]);
const RECOVERY_MODES = new Set<RecoveryMode>(["conversation", "files", "both"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedIdentity(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}

function containsPlugin(value: string, plugin: "pi-workspace-history" | "pi-wtf"): boolean {
  return normalizedIdentity(value).includes(plugin);
}

function commandIdentity(command: ResolvedCommand): string {
  const source = command.sourceInfo;
  return [source.source, source.path, source.baseDir ?? ""].join(" ");
}

function isWorkspaceHistoryCommand(command: ResolvedCommand): boolean {
  return containsPlugin(commandIdentity(command), "pi-workspace-history");
}

function isWtfCommand(command: ResolvedCommand): boolean {
  return containsPlugin(commandIdentity(command), "pi-wtf");
}

function workspaceAction(command: ResolvedCommand): RecoveryAction | undefined {
  if (command.name === "undo") return "undo";
  if (command.name === "redo") return "redo";
  if (command.name === "checkpoint") return "checkpoint";
  return undefined;
}

function repairAction(
  command: ResolvedCommand,
  commands: readonly ResolvedCommand[],
): RecoveryAction | undefined {
  if (command.name.endsWith("!")) return "repair-destructive";
  if (command.name.endsWith("?")) return "repair-typo";
  if (
    commands.some((candidate) => candidate.name === `${command.name}?`) &&
    commands.some((candidate) => candidate.name === `${command.name}!`)
  ) {
    return "repair";
  }
  return undefined;
}

function parseStringArray<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: T[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !allowed.has(entry as T)) return undefined;
    if (!result.includes(entry as T)) result.push(entry as T);
  }
  return result;
}

function parseBridgeProvider(value: unknown): RecoveryBridgeProvider | undefined {
  if (!isRecord(value)) return undefined;
  const actions = parseStringArray(value.actions, RECOVERY_ACTIONS);
  const modes = parseStringArray(value.modes, RECOVERY_MODES);
  if (
    actions === undefined ||
    modes === undefined ||
    typeof value.execute !== "function" ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    value.bridgeVersion !== RECOVERY_BRIDGE_VERSION ||
    (value.source !== undefined && typeof value.source !== "string")
  ) {
    return undefined;
  }
  return {
    actions,
    bridgeVersion: value.bridgeVersion,
    execute: value.execute as RecoveryBridgeProvider["execute"],
    id: value.id,
    modes,
    name: value.name,
    ...(value.source === undefined ? {} : { source: value.source }),
  };
}

function parseBridgeResponse(value: unknown): RecoveryBridgeResponse {
  if (value === undefined) return { outcome: "unknown" };
  if (!isRecord(value)) {
    throw new HostError("recovery_bridge_invalid", "A recovery plugin returned an invalid result");
  }
  const response: RecoveryBridgeResponse = {};
  if (value.editorText !== undefined) {
    if (typeof value.editorText !== "string") {
      throw new HostError("recovery_bridge_invalid", "Recovery editorText must be a string");
    }
    response.editorText = value.editorText;
  }
  if (value.editorImages !== undefined) {
    if (
      !Array.isArray(value.editorImages) ||
      value.editorImages.some(
        (image) =>
          !isRecord(image) ||
          typeof image.data !== "string" ||
          typeof image.mimeType !== "string",
      )
    ) {
      throw new HostError("recovery_bridge_invalid", "Recovery editorImages must be images");
    }
    response.editorImages = value.editorImages.map((image) => ({
      data: String((image as Record<string, unknown>).data),
      mimeType: String((image as Record<string, unknown>).mimeType),
    }));
  }
  if (value.outcome !== undefined) {
    if (value.outcome !== "applied" && value.outcome !== "cancelled" && value.outcome !== "unknown") {
      throw new HostError("recovery_bridge_invalid", "Recovery outcome is invalid");
    }
    response.outcome = value.outcome;
  }
  return response;
}

function mergeProvider(
  providers: Map<string, RecoveryProviderDescriptor>,
  descriptor: RecoveryProviderDescriptor,
): void {
  const current = providers.get(descriptor.id);
  if (!current) {
    providers.set(descriptor.id, descriptor);
    return;
  }
  providers.set(descriptor.id, {
    actions: [...new Set([...current.actions, ...descriptor.actions])],
    active: current.active || descriptor.active,
    ...(descriptor.bridgeVersion === undefined && current.bridgeVersion === undefined
      ? {}
      : { bridgeVersion: descriptor.bridgeVersion ?? current.bridgeVersion }),
    id: current.id,
    modes: [...new Set([...current.modes, ...descriptor.modes])],
    name: descriptor.name || current.name,
    ...(descriptor.source === undefined && current.source === undefined
      ? {}
      : { source: descriptor.source ?? current.source }),
  });
}

export class RecoveryPluginAdapter {
  #events: EventBus | undefined;

  attach(events: EventBus): void {
    this.#events = events;
  }

  detach(events: EventBus): void {
    if (this.#events === events) this.#events = undefined;
  }

  status(session: AgentSession, context: RecoveryPluginContext): RecoveryStatus {
    const commands = session.extensionRunner.getRegisteredCommands();
    const bridge = this.#discoverBridgeProviders();
    const providers = new Map<string, RecoveryProviderDescriptor>();
    const issues = [...bridge.issues];
    mergeProvider(providers, {
      actions: ["navigate", "undo"],
      active: true,
      id: "pi-native",
      modes: ["conversation"],
      name: "Pi session tree",
    });

    const workspaceCommands = commands.filter(isWorkspaceHistoryCommand);
    const workspaceConfigured = context.configuredSources.some((source) =>
      containsPlugin(source, "pi-workspace-history"),
    );
    const workspaceLoaded =
      workspaceCommands.length > 0 ||
      context.loadedExtensions.some((source) => containsPlugin(source, "pi-workspace-history"));
    if (workspaceConfigured || workspaceLoaded) {
      const actions = workspaceCommands
        .map(workspaceAction)
        .filter((action): action is RecoveryAction => action !== undefined);
      if (workspaceLoaded) actions.unshift("navigate");
      const source =
        workspaceCommands[0]?.sourceInfo.source ??
        context.configuredSources.find((entry) => containsPlugin(entry, "pi-workspace-history"));
      mergeProvider(providers, {
        actions: [...new Set(actions)],
        active: workspaceLoaded,
        id: "pi-workspace-history",
        modes: workspaceLoaded ? ["both"] : [],
        name: "Pi Workspace History",
        ...(source === undefined ? {} : { source }),
      });
      if (workspaceConfigured && !workspaceLoaded) {
        issues.push("pi-workspace-history is configured but is not loaded in this session");
      }
    }

    const wtfCommands = commands.filter(isWtfCommand);
    const wtfConfigured = context.configuredSources.some((source) => containsPlugin(source, "pi-wtf"));
    const wtfLoaded =
      wtfCommands.length > 0 ||
      context.loadedExtensions.some((source) => containsPlugin(source, "pi-wtf"));
    if (wtfConfigured || wtfLoaded) {
      const actions = wtfCommands
        .map((command) => repairAction(command, wtfCommands))
        .filter((action): action is RecoveryAction => action !== undefined);
      const source =
        wtfCommands[0]?.sourceInfo.source ??
        context.configuredSources.find((entry) => containsPlugin(entry, "pi-wtf"));
      mergeProvider(providers, {
        actions: [...new Set(actions)],
        active: wtfLoaded,
        id: "pi-wtf",
        modes: wtfLoaded ? [workspaceLoaded ? "both" : "conversation"] : [],
        name: "Pi WTF",
        ...(source === undefined ? {} : { source }),
      });
      if (wtfConfigured && !wtfLoaded) {
        issues.push("pi-wtf is configured but is not loaded in this session");
      }
    }

    for (const provider of bridge.providers) {
      mergeProvider(providers, {
        actions: provider.actions,
        active: true,
        bridgeVersion: provider.bridgeVersion,
        id: provider.id,
        modes: provider.modes,
        name: provider.name,
        ...(provider.source === undefined ? {} : { source: provider.source }),
      });
    }

    const active = [...providers.values()].filter((provider) => provider.active);
    return {
      actions: [...new Set(active.flatMap((provider) => provider.actions))],
      available: active.length > 0,
      issues,
      modes: [...new Set(active.flatMap((provider) => provider.modes))],
      providers: [...providers.values()],
    };
  }

  async navigate(
    session: AgentSession,
    context: RecoveryPluginContext,
    input: { mode: "files" | "both"; summarize?: boolean; targetId: string },
  ): Promise<RecoveryPluginExecution> {
    const bridge = await this.#executeBridge({
      action: "navigate",
      mode: input.mode,
      sessionId: session.sessionId,
      ...(input.summarize === undefined ? {} : { summarize: input.summarize }),
      targetId: input.targetId,
    });
    if (bridge) return bridge;
    if (input.mode === "both" && this.#workspaceHistoryLoaded(session, context)) {
      const result = await session.navigateTree(input.targetId, {
        summarize: input.summarize ?? false,
      });
      return {
        ...(result.editorText === undefined ? {} : { editorText: result.editorText }),
        handledBy: "pi-workspace-history",
        outcome: result.cancelled ? "cancelled" : "applied",
      };
    }
    throw new HostError(
      "recovery_mode_unavailable",
      input.mode === "files"
        ? "No active recovery plugin provides files-only restore"
        : "pi-workspace-history is required for conversation and workspace restore",
    );
  }

  async undo(
    session: AgentSession,
    context: RecoveryPluginContext,
    mode: "files" | "both",
  ): Promise<RecoveryPluginExecution> {
    const bridge = await this.#executeBridge({
      action: "undo",
      mode,
      sessionId: session.sessionId,
    });
    if (bridge) return bridge;
    if (mode !== "both") {
      throw new HostError("recovery_mode_unavailable", "No recovery plugin provides files-only undo");
    }
    return this.#executeWorkspaceCommand(session, "undo");
  }

  async redo(
    session: AgentSession,
    context: RecoveryPluginContext,
    mode: RecoveryMode,
  ): Promise<RecoveryPluginExecution> {
    const bridge = await this.#executeBridge({
      action: "redo",
      mode,
      sessionId: session.sessionId,
    });
    if (bridge) return bridge;
    if (mode !== "both") {
      throw new HostError("recovery_mode_unavailable", "No recovery plugin provides this redo mode");
    }
    return this.#executeWorkspaceCommand(session, "redo");
  }

  async checkpoint(
    session: AgentSession,
    name: string,
  ): Promise<RecoveryPluginExecution> {
    const bridge = await this.#executeBridge({
      action: "checkpoint",
      name,
      sessionId: session.sessionId,
    });
    if (bridge) return bridge;
    const command = this.#workspaceCommand(session, "checkpoint");
    if (!command) {
      throw new HostError(
        "recovery_action_unavailable",
        "pi-workspace-history does not expose a checkpoint command",
      );
    }
    await command.handler(name, session.extensionRunner.createCommandContext());
    return { handledBy: "pi-workspace-history", outcome: "unknown" };
  }

  async repair(
    session: AgentSession,
    action: RecoveryRepairAction,
  ): Promise<RecoveryPluginExecution> {
    const protocolAction: RecoveryAction =
      action === "recover"
        ? "repair"
        : action === "recover-typo"
          ? "repair-typo"
          : "repair-destructive";
    const bridge = await this.#executeBridge({
      action: protocolAction,
      sessionId: session.sessionId,
    });
    if (bridge) return bridge;
    const commands = session.extensionRunner
      .getRegisteredCommands()
      .filter(isWtfCommand);
    const command = commands.find(
      (candidate) => repairAction(candidate, commands) === protocolAction,
    );
    if (!command) {
      throw new HostError("recovery_action_unavailable", `pi-wtf does not expose ${action}`);
    }
    await command.handler("", session.extensionRunner.createCommandContext());
    return { handledBy: "pi-wtf", outcome: "unknown" };
  }

  #workspaceHistoryLoaded(session: AgentSession, context: RecoveryPluginContext): boolean {
    return (
      session.extensionRunner.getRegisteredCommands().some(isWorkspaceHistoryCommand) ||
      context.loadedExtensions.some((source) => containsPlugin(source, "pi-workspace-history"))
    );
  }

  #workspaceCommand(session: AgentSession, action: RecoveryAction): ResolvedCommand | undefined {
    return session.extensionRunner
      .getRegisteredCommands()
      .find(
        (command) =>
          isWorkspaceHistoryCommand(command) && workspaceAction(command) === action,
      );
  }

  async #executeWorkspaceCommand(
    session: AgentSession,
    action: "undo" | "redo",
  ): Promise<RecoveryPluginExecution> {
    const command = this.#workspaceCommand(session, action);
    if (!command) {
      throw new HostError(
        "recovery_action_unavailable",
        `pi-workspace-history does not expose ${action}`,
      );
    }
    await command.handler("", session.extensionRunner.createCommandContext());
    return { handledBy: "pi-workspace-history", outcome: "unknown" };
  }

  async #executeBridge(
    request: RecoveryBridgeRequest,
  ): Promise<RecoveryPluginExecution | undefined> {
    const bridge = this.#discoverBridgeProviders().providers.find(
      (provider) =>
        provider.actions.includes(request.action) &&
        (request.mode === undefined || provider.modes.includes(request.mode)),
    );
    if (!bridge) return undefined;
    let response: RecoveryBridgeResponse;
    try {
      response = parseBridgeResponse(await bridge.execute(request));
    } catch (error) {
      if (error instanceof HostError) throw error;
      throw new HostError(
        "recovery_plugin_failed",
        `${bridge.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return {
      ...(response.editorImages === undefined ? {} : { editorImages: response.editorImages }),
      ...(response.editorText === undefined ? {} : { editorText: response.editorText }),
      handledBy: bridge.id,
      outcome: response.outcome ?? "unknown",
    };
  }

  #discoverBridgeProviders(): { issues: string[]; providers: RecoveryBridgeProvider[] } {
    if (!this.#events) return { issues: [], providers: [] };
    const issues: string[] = [];
    const providers = new Map<string, RecoveryBridgeProvider>();
    const discovery: RecoveryBridgeDiscovery = {
      register: (value) => {
        const provider = parseBridgeProvider(value);
        if (!provider) {
          issues.push("A recovery plugin offered an invalid Piarium recovery bridge");
          return;
        }
        if (!providers.has(provider.id)) providers.set(provider.id, provider);
      },
      version: RECOVERY_BRIDGE_VERSION,
    };
    try {
      this.#events.emit(RECOVERY_BRIDGE_CHANNEL, discovery);
    } catch (error) {
      issues.push(
        `Recovery bridge discovery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { issues, providers: [...providers.values()] };
  }
}

export function createRecoveryBridgeExtension(adapter: RecoveryPluginAdapter): ExtensionFactory {
  return (pi) => {
    adapter.attach(pi.events);
    pi.on("session_shutdown", () => adapter.detach(pi.events));
  };
}
