import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type AgentSession,
  type AgentSessionRuntime,
  type AgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultPackageManager,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SessionManager,
  type SessionEntry as NativeSessionEntry,
  type SessionTreeNode as NativeSessionTreeNode,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type {
  HostEvent,
  HostEventData,
  ImageAttachment,
  JsonValue,
  ModelDescriptor,
  PackageDescriptor,
  ProviderConfigDeleteScope,
  ProviderConfigDetails,
  ProviderConfigInput,
  ProviderConfigScope,
  ProviderAuthType,
  ProviderDescriptor,
  ProviderModelDiscoveryResult,
  RecoveryAction,
  RecoveryMode,
  RecoveryOperationResult,
  RecoveryRepairAction,
  RecoveryStatus,
  PiSessionEntry,
  SessionEntriesResult,
  SessionHeader,
  SessionSnapshot,
  SessionStats,
  SessionSummary,
  SessionTreeNode,
  SessionTreeResult,
  ThinkingLevel,
} from "@piarium/protocol";
import { HostError } from "./errors.js";
import { ExtensionUiBridge } from "./extension-ui-bridge.js";
import { toJsonValue } from "./json.js";
import { ProjectTrustController } from "./project-trust-controller.js";
import { ProviderAuthBridge } from "./provider-auth-bridge.js";
import { ProviderConfigurationManager } from "./provider-configuration.js";
import { discoverProviderModels } from "./provider-model-discovery.js";
import {
  projectAgentEvent,
  projectProviderAuthEvent,
  projectSessionEntry,
} from "./protocol-projector.js";
import {
  createRecoveryBridgeExtension,
  RecoveryPluginAdapter,
  type RecoveryPluginContext,
  type RecoveryPluginExecution,
} from "./recovery-plugin-adapter.js";

type EventEmitter = <E extends HostEvent>(event: E, data: HostEventData<E>) => void;

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const QUEUE_MODES = new Set(["all", "one-at-a-time"]);
const WRITABLE_SETTINGS = new Set([
  "compactionEnabled",
  "defaultModel",
  "defaultProvider",
  "defaultThinkingLevel",
  "followUpMode",
  "retryEnabled",
  "shellPath",
  "steeringMode",
  "theme",
]);

export interface SessionHostOptions {
  agentDir: string;
  configureServices?: (
    services: AgentSessionServices,
  ) => Promise<{ model?: NonNullable<AgentSession["model"]> }>;
  emit: EventEmitter;
  projectTrustOverride?: boolean;
  runtimeFactory?: CreateAgentSessionRuntimeFactory;
}

function getSessionDir(cwd: string, agentDir: string): string {
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(agentDir), "sessions", safePath);
}

function toModelDescriptor(
  model: AgentSession["model"],
  available: boolean,
): ModelDescriptor | undefined {
  if (!model) return undefined;
  return {
    api: model.api,
    available,
    baseUrl: model.baseUrl,
    contextWindow: model.contextWindow,
    cost: {
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
      input: model.cost.input,
      output: model.cost.output,
      ...(model.cost.tiers === undefined
        ? {}
        : {
            tiers: model.cost.tiers.map((tier) => ({
              cacheRead: tier.cacheRead,
              cacheWrite: tier.cacheWrite,
              input: tier.input,
              inputTokensAbove: tier.inputTokensAbove,
              output: tier.output,
            })),
          }),
    },
    id: model.id,
    input: [...model.input],
    maxTokens: model.maxTokens,
    name: model.name,
    provider: model.provider,
    supportedThinkingLevels: getSupportedThinkingLevels(model) as ThinkingLevel[],
  };
}

function toImages(images: ImageAttachment[]): NonNullable<Parameters<AgentSession["steer"]>[1]> {
  return images.map((image) => ({ data: image.data, mimeType: image.mimeType, type: "image" }));
}

function sessionPathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function projectSessionTree(node: NativeSessionTreeNode): SessionTreeNode {
  return {
    children: node.children.map(projectSessionTree),
    entry: projectSessionEntry(node.entry),
    ...(node.label === undefined ? {} : { label: node.label }),
    ...(node.labelTimestamp === undefined ? {} : { labelTimestamp: node.labelTimestamp }),
  };
}

function messageSearchText(message: unknown): string {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return "";
  const record = message as Record<string, unknown>;
  const content = record.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part !== "object" || part === null || Array.isArray(part)) return "";
        const item = part as Record<string, unknown>;
        if (typeof item.text === "string") return item.text;
        if (typeof item.thinking === "string") return item.thinking;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return [record.command, record.output, record.summary]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function editableRecoveryContent(entry: NativeSessionEntry | undefined): {
  editorImages?: ImageAttachment[];
  editorText?: string;
} {
  let content: unknown;
  if (entry?.type === "message" && entry.message.role === "user") {
    content = entry.message.content;
  } else if (entry?.type === "custom_message") {
    content = entry.content;
  } else {
    return {};
  }
  if (typeof content === "string") return { editorText: content };
  if (!Array.isArray(content)) return {};
  const text = content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const editorImages = content
    .filter((part) => part.type === "image")
    .map((part) => ({ data: part.data, mimeType: part.mimeType }));
  return {
    ...(editorImages.length === 0 ? {} : { editorImages }),
    ...(text.length === 0 ? {} : { editorText: text }),
  };
}

function packageNameFromSource(source: string): string {
  const value = source.startsWith("npm:") ? source.slice(4) : source;
  if (value.startsWith("@")) {
    const slash = value.indexOf("/");
    const version = slash === -1 ? -1 : value.indexOf("@", slash);
    return version === -1 ? value : value.slice(0, version);
  }
  if (/^[A-Za-z0-9_.-]+(?:@[^@]+)?$/.test(value)) return value.split("@")[0] ?? value;
  return value;
}

function requireSettingType(
  values: Record<string, JsonValue>,
  key: string,
  expected: "boolean" | "string",
): void {
  const value = values[key];
  if (value !== undefined && typeof value !== expected) {
    throw new HostError("invalid_settings", `${key} must be a ${expected}`);
  }
}

export class SessionHost {
  readonly #agentDir: string;
  readonly #configureServices: SessionHostOptions["configureServices"];
  readonly #emit: EventEmitter;
  readonly #projectTrustOverride: boolean | undefined;
  readonly #providerConfiguration: ProviderConfigurationManager;
  readonly #runtimeFactory: CreateAgentSessionRuntimeFactory | undefined;
  readonly #trustStore: ProjectTrustStore;
  readonly trust: ProjectTrustController;
  readonly ui: ExtensionUiBridge;
  readonly auth: ProviderAuthBridge;
  #runtime: AgentSessionRuntime | undefined;
  #recovery: RecoveryPluginAdapter | undefined;
  #unsubscribe: (() => void) | undefined;
  #disposed = false;

  constructor(options: SessionHostOptions) {
    this.#agentDir = resolve(options.agentDir);
    this.#configureServices = options.configureServices;
    this.#emit = options.emit;
    this.#projectTrustOverride = options.projectTrustOverride;
    this.#runtimeFactory = options.runtimeFactory;
    this.#providerConfiguration = new ProviderConfigurationManager({ agentDir: this.#agentDir });
    this.#trustStore = new ProjectTrustStore(this.#agentDir);
    this.trust = new ProjectTrustController(options.emit);
    this.ui = new ExtensionUiBridge(options.emit, () => this.sessionId ?? "host");
    this.auth = new ProviderAuthBridge(options.emit);
  }

  get sessionId(): string | undefined {
    return this.#runtime?.session.sessionId;
  }

  get runtime(): AgentSessionRuntime {
    if (!this.#runtime) throw new HostError("no_active_session", "No Pi session is open");
    return this.#runtime;
  }

  get session(): AgentSession {
    return this.runtime.session;
  }

  async create(cwd: string, name?: string): Promise<SessionSnapshot> {
    await this.#replaceWith(SessionManager.create(cwd, getSessionDir(cwd, this.#agentDir)));
    if (name) this.session.setSessionName(name);
    return this.snapshot();
  }

  async openCatalogContext(cwd: string): Promise<SessionSnapshot> {
    await this.#replaceWith(SessionManager.inMemory(cwd));
    return this.snapshot();
  }

  async open(input: {
    cwd?: string;
    sessionFile?: string;
    sessionId?: string;
  }): Promise<SessionSnapshot> {
    let sessionFile = input.sessionFile;
    if (!sessionFile && input.sessionId) {
      const sessions = await this.list(input.cwd);
      sessionFile = sessions.find((entry) => entry.id === input.sessionId)?.sessionFile;
    }
    if (!sessionFile) {
      throw new HostError("session_not_found", "A session file or known session ID is required");
    }
    const manager = SessionManager.open(sessionFile, undefined, input.cwd);
    await this.#replaceWith(manager);
    return this.snapshot();
  }

  async close(sessionId: string): Promise<boolean> {
    this.assertSession(sessionId);
    await this.#disposeRuntime();
    this.#emit("session.closed", { sessionId });
    return true;
  }

  async list(cwd?: string): Promise<SessionSummary[]> {
    const infos = cwd
      ? await SessionManager.list(cwd, getSessionDir(cwd, this.#agentDir))
      : await this.#listAllFromAgentDir();
    const idsByPath = new Map(infos.map((info) => [sessionPathKey(info.path), info.id]));
    return infos.map((info) => {
      const parentId =
        info.parentSessionPath === undefined
          ? undefined
          : idsByPath.get(sessionPathKey(info.parentSessionPath));
      return {
        allMessagesText: info.allMessagesText,
        createdAt: info.created.toISOString(),
        cwd: info.cwd,
        firstMessage: info.firstMessage,
        id: info.id,
        messageCount: info.messageCount,
        ...(info.name === undefined ? {} : { name: info.name }),
        ...(parentId === undefined ? {} : { parentId }),
        ...(info.parentSessionPath === undefined
          ? {}
          : { parentSessionPath: info.parentSessionPath }),
        persisted: true,
        sessionFile: info.path,
        updatedAt: info.modified.toISOString(),
      };
    });
  }

  snapshot(): SessionSnapshot {
    const session = this.session;
    const selectedModel = session.model;
    const availableModels = this.runtime.services.modelRuntime.getAvailableSnapshot();
    const model = toModelDescriptor(
      selectedModel,
      selectedModel === undefined
        ? false
        : availableModels.some(
            (candidate) =>
              candidate.provider === selectedModel.provider && candidate.id === selectedModel.id,
          ),
    );
    const name = session.sessionManager.getSessionName();
    return {
      activeTools: session.getActiveToolNames(),
      busy: !session.isIdle,
      cwd: this.runtime.cwd,
      followUp: [...session.getFollowUpMessages()],
      followUpMode: session.followUpMode,
      isCompacting: session.isCompacting,
      isStreaming: session.isStreaming,
      leafId: session.sessionManager.getLeafId(),
      ...(model === undefined ? {} : { model }),
      ...(name === undefined ? {} : { name }),
      pendingMessageCount: session.pendingMessageCount,
      retryAttempt: session.retryAttempt,
      ...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
      sessionId: session.sessionId,
      steering: [...session.getSteeringMessages()],
      steeringMode: session.steeringMode,
      thinkingLevel: session.thinkingLevel as ThinkingLevel,
    };
  }

  header(sessionId: string): SessionHeader | null {
    this.assertSession(sessionId);
    const header = this.session.sessionManager.getHeader();
    if (!header) return null;
    return {
      cwd: header.cwd,
      id: header.id,
      ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
      timestamp: header.timestamp,
      ...(header.version === undefined ? {} : { version: header.version }),
    };
  }

  entries(sessionId: string, scope: "branch" | "all"): SessionEntriesResult {
    this.assertSession(sessionId);
    const entries = scope === "branch"
      ? this.session.sessionManager.getBranch()
      : this.session.sessionManager.getEntries();
    return {
      entries: entries.map(projectSessionEntry),
      leafId: this.session.sessionManager.getLeafId(),
      scope,
      sessionId,
    };
  }

  entry(sessionId: string, entryId: string): PiSessionEntry | null {
    this.assertSession(sessionId);
    const entry = this.session.sessionManager.getEntry(entryId);
    return entry === undefined ? null : projectSessionEntry(entry);
  }

  tree(sessionId: string): SessionTreeResult {
    this.assertSession(sessionId);
    return {
      leafId: this.session.sessionManager.getLeafId(),
      sessionId,
      tree: this.session.sessionManager.getTree().map(projectSessionTree),
    };
  }

  stats(sessionId: string): SessionStats {
    this.assertSession(sessionId);
    const stats = this.session.getSessionStats();
    return {
      assistantMessages: stats.assistantMessages,
      ...(stats.contextUsage === undefined
        ? {}
        : { contextUsage: toJsonValue(stats.contextUsage) }),
      cost: stats.cost,
      ...(stats.sessionFile === undefined ? {} : { sessionFile: stats.sessionFile }),
      sessionId: stats.sessionId,
      tokens: { ...stats.tokens },
      toolCalls: stats.toolCalls,
      toolResults: stats.toolResults,
      totalMessages: stats.totalMessages,
      userMessages: stats.userMessages,
    };
  }

  async summary(sessionId: string): Promise<SessionSummary> {
    this.assertSession(sessionId);
    const manager = this.session.sessionManager;
    const sessionFile = manager.getSessionFile();
    if (!sessionFile) {
      throw new HostError("session_not_persisted", "The active Pi context is not a persisted session");
    }
    const header = manager.getHeader();
    const entries = manager.getEntries();
    const messageTexts = entries
      .filter((entry) => entry.type === "message")
      .map((entry) => messageSearchText(entry.message));
    let fileInfo: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      fileInfo = await stat(sessionFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const name = manager.getSessionName();
    const createdAt = header?.timestamp ?? fileInfo?.birthtime.toISOString() ?? new Date().toISOString();
    return {
      allMessagesText: messageTexts.filter(Boolean).join("\n"),
      createdAt,
      cwd: manager.getCwd(),
      firstMessage: messageTexts.find(Boolean) ?? "",
      id: manager.getSessionId(),
      messageCount: messageTexts.length,
      ...(name === undefined ? {} : { name }),
      ...(header?.parentSession === undefined
        ? {}
        : { parentSessionPath: header.parentSession }),
      persisted: fileInfo !== undefined,
      sessionFile,
      updatedAt: fileInfo?.mtime.toISOString() ?? createdAt,
    };
  }

  async rename(
    sessionId: string,
    name: string,
    sessionFile?: string,
  ): Promise<{ name?: string; sessionId: string }> {
    if (this.sessionId === sessionId) {
      this.session.setSessionName(name);
      const normalized = this.session.sessionName;
      return { ...(normalized === undefined ? {} : { name: normalized }), sessionId };
    }
    const summary = sessionFile
      ? undefined
      : (await this.list()).find((entry) => entry.id === sessionId);
    const resolvedSessionFile = sessionFile ?? summary?.sessionFile;
    if (!resolvedSessionFile) {
      throw new HostError("session_not_found", `Unknown Pi session: ${sessionId}`);
    }
    const manager = SessionManager.open(resolvedSessionFile, undefined, summary?.cwd);
    if (manager.getSessionId() !== sessionId) {
      throw new HostError(
        "session_mismatch",
        `The Pi session file belongs to ${manager.getSessionId()}, not ${sessionId}`,
      );
    }
    manager.appendSessionInfo(name);
    const normalized = manager.getSessionName();
    return { ...(normalized === undefined ? {} : { name: normalized }), sessionId };
  }

  async fork(
    sessionId: string,
    entryId: string,
    position: "before" | "at" = "before",
  ): Promise<{ cancelled: boolean; editorText?: string; snapshot: SessionSnapshot }> {
    this.assertSession(sessionId);
    const result = await this.runtime.fork(entryId, { position });
    return {
      cancelled: result.cancelled,
      ...(result.selectedText === undefined ? {} : { editorText: result.selectedText }),
      snapshot: this.snapshot(),
    };
  }

  async navigate(
    sessionId: string,
    targetId: string,
    summarize: boolean = false,
  ): Promise<{ cancelled: boolean; editorText?: string; snapshot: SessionSnapshot }> {
    this.assertSession(sessionId);
    const result = await this.session.navigateTree(targetId, { summarize });
    return {
      cancelled: result.cancelled,
      ...(result.editorText === undefined ? {} : { editorText: result.editorText }),
      snapshot: this.snapshot(),
    };
  }

  async prompt(
    sessionId: string,
    text: string,
    images?: ImageAttachment[],
  ): Promise<{ accepted: boolean }> {
    this.assertSession(sessionId);
    const session = this.session;
    let accept: (accepted: boolean) => void = () => {};
    const preflight = new Promise<boolean>((resolvePreflight) => {
      accept = resolvePreflight;
    });
    const run = session.prompt(text, {
      ...(images === undefined ? {} : { images: toImages(images) }),
      preflightResult: accept,
      source: "interactive",
    });
    let accepted: boolean;
    try {
      accepted = await Promise.race([preflight, run.then(() => false)]);
      if (!accepted) await run;
    } catch (error) {
      throw new HostError(
        "agent_run_failed",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    void run.catch((error) => {
      this.#emit("host.error", {
        code: "agent_run_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return { accepted };
  }

  async steer(sessionId: string, text: string, images?: ImageAttachment[]): Promise<boolean> {
    this.assertSession(sessionId);
    await this.session.steer(text, images === undefined ? undefined : toImages(images));
    return true;
  }

  async followUp(sessionId: string, text: string, images?: ImageAttachment[]): Promise<boolean> {
    this.assertSession(sessionId);
    await this.session.followUp(text, images === undefined ? undefined : toImages(images));
    return true;
  }

  async abort(sessionId: string): Promise<boolean> {
    this.assertSession(sessionId);
    const wasBusy = !this.session.isIdle;
    await this.session.abort();
    return wasBusy;
  }

  recoveryStatus(sessionId: string): RecoveryStatus {
    this.assertSession(sessionId);
    return this.recovery.status(this.session, this.#recoveryContext());
  }

  async navigateRecovery(
    sessionId: string,
    targetId: string,
    mode: RecoveryMode,
    summarize?: boolean,
  ): Promise<RecoveryOperationResult> {
    this.#assertRecoveryReady(sessionId);
    const target = this.session.sessionManager.getEntry(targetId);
    if (!target) throw new HostError("recovery_target_not_found", `Unknown session entry: ${targetId}`);
    if (mode === "conversation" && summarize === true) {
      throw new HostError(
        "recovery_mode_unavailable",
        "Conversation-only recovery cannot summarize through a workspace-history hook",
      );
    }
    const editable = editableRecoveryContent(target);
    const execution =
      mode === "conversation"
        ? await this.#navigateConversationOnly(targetId)
        : await this.recovery.navigate(this.session, this.#recoveryContext(), {
            mode,
            ...(summarize === undefined ? {} : { summarize }),
            targetId,
          });
    return this.#finishRecovery("navigate", execution, {
      ...editable,
      mode,
    });
  }

  async undoRecovery(sessionId: string, mode: RecoveryMode): Promise<RecoveryOperationResult> {
    this.#assertRecoveryReady(sessionId);
    const execution =
      mode === "conversation"
        ? await this.#undoConversationOnly()
        : await this.recovery.undo(this.session, this.#recoveryContext(), mode);
    return this.#finishRecovery("undo", execution, { mode });
  }

  async redoRecovery(sessionId: string, mode: RecoveryMode): Promise<RecoveryOperationResult> {
    this.#assertRecoveryReady(sessionId);
    const execution = await this.recovery.redo(this.session, this.#recoveryContext(), mode);
    return this.#finishRecovery("redo", execution, { mode });
  }

  async createRecoveryCheckpoint(
    sessionId: string,
    name: string,
  ): Promise<RecoveryOperationResult> {
    this.#assertRecoveryReady(sessionId);
    const execution = await this.recovery.checkpoint(this.session, name);
    return this.#finishRecovery("checkpoint", execution);
  }

  async repairRecovery(
    sessionId: string,
    action: RecoveryRepairAction,
  ): Promise<RecoveryOperationResult> {
    this.assertSession(sessionId);
    const execution = await this.recovery.repair(this.session, action);
    const protocolAction: RecoveryAction =
      action === "recover"
        ? "repair"
        : action === "recover-typo"
          ? "repair-typo"
          : "repair-destructive";
    return this.#finishRecovery(protocolAction, execution);
  }

  listCommands(sessionId: string): Array<{ description?: string; name: string; source?: string }> {
    this.assertSession(sessionId);
    const extensionCommands = this.session.extensionRunner
      .getRegisteredCommands()
      .map((command) => ({
        ...(command.description === undefined ? {} : { description: command.description }),
        name: command.invocationName,
        source: "extension",
      }));
    const templates = this.session.promptTemplates.map((template) => ({
      ...(template.description === undefined ? {} : { description: template.description }),
      name: template.name,
      source: "prompt",
    }));
    const skills = this.session.resourceLoader.getSkills().skills.map((skill) => ({
      description: skill.description,
      name: `skill:${skill.name}`,
      source: "skill",
    }));
    return [...extensionCommands, ...templates, ...skills];
  }

  async executeCommand(sessionId: string, command: string): Promise<JsonValue> {
    this.assertSession(sessionId);
    if (!command.startsWith("/")) {
      throw new HostError("invalid_command", "Extension commands must start with '/'");
    }
    await this.session.prompt(command);
    return { executed: true };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    await this.#providerConfiguration.apply(
      this.runtime.services.modelRuntime,
      this.runtime.cwd,
    );
    const runtime = this.runtime.services.modelRuntime;
    const available = new Set(
      runtime.getAvailableSnapshot().map((model) => `${model.provider}\u0000${model.id}`),
    );
    return runtime
      .getModels()
      .map((model) => toModelDescriptor(model, available.has(`${model.provider}\u0000${model.id}`)))
      .filter((model): model is ModelDescriptor => model !== undefined);
  }

  async selectModel(
    sessionId: string,
    provider: string,
    modelId: string,
  ): Promise<SessionSnapshot> {
    this.assertSession(sessionId);
    await this.#providerConfiguration.apply(
      this.runtime.services.modelRuntime,
      this.runtime.cwd,
    );
    const model = this.runtime.services.modelRuntime.getModel(provider, modelId);
    if (!model) throw new HostError("model_not_found", `Unknown model: ${provider}/${modelId}`);
    await this.session.setModel(model);
    return this.snapshot();
  }

  selectThinkingLevel(sessionId: string, level: ThinkingLevel): SessionSnapshot {
    this.assertSession(sessionId);
    this.session.setThinkingLevel(level);
    return this.snapshot();
  }

  async listProviders(): Promise<ProviderDescriptor[]> {
    await this.#providerConfiguration.apply(
      this.runtime.services.modelRuntime,
      this.runtime.cwd,
    );
    const runtime = this.runtime.services.modelRuntime;
    return runtime.getProviders().map((provider) => {
      const status = runtime.getProviderAuthStatus(provider.id);
      const methods: ProviderDescriptor["auth"]["methods"] = [];
      if (provider.auth.apiKey?.login) {
        methods.push({ label: provider.auth.apiKey.name, type: "api_key" });
      }
      if (provider.auth.oauth) {
        methods.push({
          label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
          type: "oauth",
        });
      }
      let modelCount = 0;
      try {
        modelCount = provider.getModels().length;
      } catch {
        // A broken extension provider remains visible with an empty catalog.
      }
      return {
        auth: {
          configured: status.configured,
          ...(status.label === undefined ? {} : { label: status.label }),
          methods,
          ...(status.source === undefined ? {} : { source: status.source }),
        },
        ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
        dynamicModels: typeof provider.refreshModels === "function",
        id: provider.id,
        modelCount,
        name: provider.name,
      };
    });
  }

  async loginProvider(providerId: string, type: ProviderAuthType): Promise<boolean> {
    const modelRuntime = this.runtime.services.modelRuntime;
    await this.#providerConfiguration.apply(modelRuntime, this.runtime.cwd);
    type LoginInteraction = Parameters<typeof modelRuntime.login>[2];
    const sessionId = this.session.sessionId;
    const interaction: LoginInteraction = {
      prompt: (prompt) => this.auth.prompt(providerId, sessionId, prompt),
      notify: (event) => {
        this.#emit("provider.auth.event", {
          event: projectProviderAuthEvent(event),
          providerId,
          sessionId,
        });
      },
    };
    await modelRuntime.login(providerId, type, interaction);
    return true;
  }

  async logoutProvider(providerId: string): Promise<void> {
    await this.runtime.services.modelRuntime.logout(providerId);
  }

  async getProviderConfiguration(providerId: string): Promise<ProviderConfigDetails> {
    const runtime = this.runtime.services.modelRuntime;
    await this.#providerConfiguration.apply(runtime, this.runtime.cwd);
    return this.#providerConfiguration.getDetails(runtime, this.runtime.cwd, providerId);
  }

  async upsertProviderConfiguration(
    scope: ProviderConfigScope,
    config: ProviderConfigInput,
  ): Promise<ProviderConfigDetails> {
    const runtime = this.runtime.services.modelRuntime;
    const details = await this.#providerConfiguration.upsert(
      runtime,
      this.runtime.cwd,
      scope,
      config,
    );
    this.#emit("provider.config.changed", {
      providerId: config.id,
      scope,
      sessionId: this.session.sessionId,
    });
    return details;
  }

  async deleteProviderConfiguration(
    providerId: string,
    scope: ProviderConfigDeleteScope,
  ): Promise<ProviderConfigDetails> {
    const runtime = this.runtime.services.modelRuntime;
    if (scope === "auth" || scope === "all") {
      await runtime.logout(providerId);
    }
    const details =
      scope === "auth"
        ? await this.#providerConfiguration.getDetails(runtime, this.runtime.cwd, providerId)
        : await this.#providerConfiguration.delete(runtime, this.runtime.cwd, providerId, scope);
    this.#emit("provider.config.changed", {
      providerId,
      scope,
      sessionId: this.session.sessionId,
    });
    return details;
  }

  async discoverProviderModels(
    providerId: string,
    config?: ProviderConfigInput,
    requestCredential: boolean = false,
  ): Promise<ProviderModelDiscoveryResult> {
    const runtime = this.runtime.services.modelRuntime;
    await this.#providerConfiguration.apply(runtime, this.runtime.cwd);
    if (config && config.id !== providerId) {
      throw new HostError(
        "invalid_params",
        "Provider discovery config id must match providerId",
      );
    }
    const apiKey = requestCredential
      ? await this.auth.prompt(providerId, this.session.sessionId, {
          message: "Enter API key for model discovery",
          type: "secret",
        })
      : undefined;
    return discoverProviderModels({
      configuration: this.#providerConfiguration,
      ...(config === undefined ? {} : { config }),
      cwd: this.runtime.cwd,
      ...(apiKey === undefined ? {} : { apiKey }),
      providerId,
      runtime,
    });
  }

  listPackages(): PackageDescriptor[] {
    const manager = this.#packageManager();
    return manager.listConfiguredPackages().map((entry) => ({
      enabled: true,
      name: packageNameFromSource(entry.source),
      source: entry.source,
    }));
  }

  async installPackage(source: string): Promise<PackageDescriptor> {
    const manager = this.#packageManager();
    await manager.installAndPersist(source);
    await this.runtime.services.settingsManager.flush();
    await this.session.reload();
    return { enabled: true, name: packageNameFromSource(source), source };
  }

  async removePackage(source: string): Promise<boolean> {
    const manager = this.#packageManager();
    const removed = await manager.removeAndPersist(source);
    await this.runtime.services.settingsManager.flush();
    await this.session.reload();
    return removed;
  }

  async updatePackages(source?: string): Promise<PackageDescriptor[]> {
    const manager = this.#packageManager();
    await manager.update(source);
    await this.session.reload();
    return this.listPackages();
  }

  getSettings(): JsonValue {
    const settings = this.runtime.services.settingsManager;
    return toJsonValue({
      global: settings.getGlobalSettings(),
      project: settings.getProjectSettings(),
      projectTrusted: settings.isProjectTrusted(),
    });
  }

  async updateSettings(patch: JsonValue): Promise<JsonValue> {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      throw new HostError("invalid_settings", "Settings patch must be an object");
    }
    const settings = this.runtime.services.settingsManager;
    const values = patch as Record<string, JsonValue>;
    const unknown = Object.keys(values).filter((key) => !WRITABLE_SETTINGS.has(key));
    if (unknown.length > 0) {
      throw new HostError("invalid_settings", `Unknown settings: ${unknown.join(", ")}`);
    }
    for (const key of [
      "defaultProvider",
      "defaultModel",
      "defaultThinkingLevel",
      "steeringMode",
      "followUpMode",
      "theme",
    ]) {
      requireSettingType(values, key, "string");
    }
    for (const key of ["compactionEnabled", "retryEnabled"]) {
      requireSettingType(values, key, "boolean");
    }
    if (
      values.shellPath !== undefined &&
      values.shellPath !== null &&
      typeof values.shellPath !== "string"
    ) {
      throw new HostError("invalid_settings", "shellPath must be a string or null");
    }
    if (typeof values.defaultProvider === "string")
      settings.setDefaultProvider(values.defaultProvider);
    if (typeof values.defaultModel === "string") settings.setDefaultModel(values.defaultModel);
    if (typeof values.defaultThinkingLevel === "string") {
      if (!THINKING_LEVELS.has(values.defaultThinkingLevel)) {
        throw new HostError("invalid_settings", "Unknown default thinking level");
      }
      settings.setDefaultThinkingLevel(
        values.defaultThinkingLevel as Parameters<typeof settings.setDefaultThinkingLevel>[0],
      );
    }
    if (typeof values.steeringMode === "string") {
      if (!QUEUE_MODES.has(values.steeringMode))
        throw new HostError("invalid_settings", "Unknown steering mode");
      settings.setSteeringMode(values.steeringMode as "all" | "one-at-a-time");
    }
    if (typeof values.followUpMode === "string") {
      if (!QUEUE_MODES.has(values.followUpMode))
        throw new HostError("invalid_settings", "Unknown follow-up mode");
      settings.setFollowUpMode(values.followUpMode as "all" | "one-at-a-time");
    }
    if (typeof values.theme === "string") settings.setTheme(values.theme);
    if (typeof values.compactionEnabled === "boolean") {
      settings.setCompactionEnabled(values.compactionEnabled);
    }
    if (typeof values.retryEnabled === "boolean") settings.setRetryEnabled(values.retryEnabled);
    if (typeof values.shellPath === "string" || values.shellPath === null) {
      settings.setShellPath(values.shellPath ?? undefined);
    }
    await settings.flush();
    const errors = settings.drainErrors();
    if (errors.length > 0) {
      throw new HostError(
        "settings_write_failed",
        errors.map((entry) => entry.error.message).join("; "),
      );
    }
    return this.getSettings();
  }

  assertSession(sessionId: string): void {
    if (!this.#runtime || this.#runtime.session.sessionId !== sessionId) {
      throw new HostError(
        "session_not_active",
        `Session is not active in this worker: ${sessionId}`,
      );
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.ui.cancelAll();
    this.auth.cancelAll();
    this.trust.cancelAll();
    await this.#disposeRuntime();
  }

  async #replaceWith(manager: SessionManager): Promise<void> {
    if (this.#disposed) throw new HostError("host_disposed", "Pi session host is disposed");
    await this.#disposeRuntime();
    const cwd = manager.getCwd();
    const factory = this.#createRuntimeFactory();
    this.#runtime = await createAgentSessionRuntime(factory, {
      agentDir: this.#agentDir,
      cwd,
      sessionManager: manager,
    });
    this.#runtime.setRebindSession(async () => this.#bindSession());
    this.#runtime.setBeforeSessionInvalidate(() => {
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      this.ui.cancelAll();
      this.auth.cancelAll();
    });
    await this.#bindSession();
  }

  #createRuntimeFactory(): CreateAgentSessionRuntimeFactory {
    if (this.#runtimeFactory) return this.#runtimeFactory;
    return async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const requiresTrust = hasTrustRequiringProjectResources(cwd);
      const storedDecision = this.#trustStore.get(cwd);
      const initialTrust =
        this.#projectTrustOverride ??
        (!requiresTrust || (storedDecision !== null && storedDecision));
      const shouldPrompt =
        this.#projectTrustOverride === undefined && requiresTrust && storedDecision === null;
      const settingsManager = SettingsManager.create(cwd, agentDir, {
        projectTrusted: initialTrust,
      });
      const recovery = new RecoveryPluginAdapter();
      this.#recovery = recovery;
      const services = await createAgentSessionServices({
        agentDir,
        cwd,
        resourceLoaderOptions: {
          extensionFactories: [
            {
              factory: createRecoveryBridgeExtension(recovery),
              hidden: true,
              name: "piarium-recovery-bridge",
            },
          ],
        },
        settingsManager,
        ...(shouldPrompt
          ? {
              resourceLoaderReloadOptions: {
                resolveProjectTrust: async () => {
                  const decision = await this.trust.request(cwd);
                  if (decision.remember) this.#trustStore.set(cwd, decision.trusted);
                  return decision.trusted;
                },
              },
            }
          : {}),
      });
      const providerWarnings = await this.#providerConfiguration.apply(
        services.modelRuntime,
        cwd,
      );
      services.diagnostics.push(
        ...providerWarnings.map((message) => ({ message, type: "warning" as const })),
      );
      const configured = await this.#configureServices?.(services);
      const created = await createAgentSessionFromServices({
        ...(configured?.model === undefined ? {} : { model: configured.model }),
        services,
        sessionManager,
        ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
      });
      const diagnostics = [
        ...services.diagnostics,
        ...services.resourceLoader.getExtensions().errors.map((entry) => ({
          message: `Failed to load extension "${entry.path}": ${entry.error}`,
          type: "error" as const,
        })),
      ];
      return { ...created, diagnostics, services };
    };
  }

  async #bindSession(): Promise<void> {
    const runtime = this.runtime;
    const session = runtime.session;
    this.#unsubscribe?.();
    this.ui.cancelAll();
    await session.bindExtensions({
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: (options) => runtime.newSession(options),
        fork: async (entryId, options) => {
          const result = await runtime.fork(entryId, options);
          return { cancelled: result.cancelled };
        },
        navigateTree: async (targetId, options) => {
          const result = await session.navigateTree(targetId, options);
          return { cancelled: result.cancelled };
        },
        switchSession: (sessionPath, options) => runtime.switchSession(sessionPath, options),
        reload: () => session.reload(),
      },
      mode: "rpc",
      onError: (error) => {
        this.#emit("host.error", {
          code: "extension_error",
          details: toJsonValue({ event: error.event, extensionPath: error.extensionPath }),
          message: error.error,
        });
      },
      shutdownHandler: () => {
        this.#emit("host.log", { level: "info", message: "An extension requested host shutdown" });
      },
      uiContext: this.ui.createContext(),
    });
    this.#unsubscribe = session.subscribe((event) => {
      this.#emit("agent.event", {
        event: projectAgentEvent(event),
        sessionId: session.sessionId,
      });
      if (
        event.type === "agent_start" ||
        event.type === "agent_end" ||
        event.type === "agent_settled" ||
        event.type === "queue_update" ||
        event.type === "session_info_changed" ||
        event.type === "thinking_level_changed" ||
        event.type === "compaction_end"
      ) {
        this.#emit("session.snapshot", this.snapshot());
      }
    });
    for (const diagnostic of runtime.diagnostics) {
      this.#emit("host.log", {
        level: diagnostic.type === "error" ? "error" : "warn",
        message: diagnostic.message,
      });
    }
    this.#emit("session.snapshot", this.snapshot());
    this.#emit("recovery.status", {
      ...this.recoveryStatus(session.sessionId),
      sessionId: session.sessionId,
    });
  }

  #packageManager(): DefaultPackageManager {
    const manager = new DefaultPackageManager({
      agentDir: this.#agentDir,
      cwd: this.runtime.cwd,
      settingsManager: this.runtime.services.settingsManager,
    });
    manager.setProgressCallback((progress) => {
      const operation =
        progress.action === "remove"
          ? "remove"
          : progress.action === "update"
            ? "update"
            : "install";
      this.#emit("package.progress", {
        message: progress.message ?? `${progress.action}: ${progress.source}`,
        operation,
        source: progress.source,
      });
    });
    return manager;
  }

  async #listAllFromAgentDir() {
    const root = join(this.#agentDir, "sessions");
    let directories: string[];
    try {
      directories = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name));
    } catch {
      return [];
    }
    const groups = await Promise.all(
      directories.map((directory) => SessionManager.listAll(directory)),
    );
    return groups.flat().sort((left, right) => right.modified.getTime() - left.modified.getTime());
  }

  async #disposeRuntime(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.ui.cancelAll();
    this.auth.cancelAll();
    const runtime = this.#runtime;
    this.#runtime = undefined;
    if (runtime) await runtime.dispose();
    this.#recovery = undefined;
  }

  get recovery(): RecoveryPluginAdapter {
    if (!this.#recovery) throw new HostError("recovery_unavailable", "Recovery is unavailable");
    return this.#recovery;
  }

  #assertRecoveryReady(sessionId: string): void {
    this.assertSession(sessionId);
    if (!this.session.isIdle) {
      throw new HostError("session_busy", "Wait for the active Pi run before using recovery");
    }
  }

  #recoveryContext(): RecoveryPluginContext {
    const extensions = this.runtime.services.resourceLoader.getExtensions().extensions;
    return {
      configuredSources: this.#packageManager()
        .listConfiguredPackages()
        .map((entry) => entry.source),
      loadedExtensions: extensions.flatMap((extension) => [
        extension.path,
        extension.resolvedPath,
        extension.sourceInfo.source,
        extension.sourceInfo.path,
      ]),
    };
  }

  async #navigateConversationOnly(targetId: string): Promise<RecoveryPluginExecution> {
    const manager = this.session.sessionManager;
    const oldLeafId = manager.getLeafId();
    if (targetId === oldLeafId) {
      return { handledBy: "pi-native", outcome: "applied" };
    }
    const target = manager.getEntry(targetId);
    if (!target) throw new HostError("recovery_target_not_found", `Unknown session entry: ${targetId}`);
    const editable = editableRecoveryContent(target);
    const newLeafId =
      (target.type === "message" && target.message.role === "user") ||
      target.type === "custom_message"
        ? target.parentId
        : target.id;
    if (newLeafId === null) manager.resetLeaf();
    else manager.branch(newLeafId);
    await this.#replaceWith(manager);
    return { ...editable, handledBy: "pi-native", outcome: "applied" };
  }

  async #undoConversationOnly(): Promise<RecoveryPluginExecution> {
    const target = this.session.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === "message" && entry.message.role === "user");
    if (!target) {
      throw new HostError("recovery_action_unavailable", "This session has no user turn to undo");
    }
    return this.#navigateConversationOnly(target.id);
  }

  #finishRecovery(
    action: RecoveryAction,
    execution: RecoveryPluginExecution,
    options: {
      editorImages?: ImageAttachment[];
      editorText?: string;
      mode?: RecoveryMode;
    } = {},
  ): RecoveryOperationResult {
    const sessionId = this.session.sessionId;
    const result: RecoveryOperationResult = {
      action,
      ...(execution.editorImages === undefined && options.editorImages === undefined
        ? {}
        : { editorImages: execution.editorImages ?? options.editorImages }),
      ...(execution.editorText === undefined && options.editorText === undefined
        ? {}
        : { editorText: execution.editorText ?? options.editorText }),
      handledBy: execution.handledBy,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      outcome: execution.outcome,
      snapshot: this.snapshot(),
    };
    this.#emit("recovery.changed", { sessionId });
    this.#emit("recovery.status", { ...this.recoveryStatus(sessionId), sessionId });
    return result;
  }
}
