import { createHash } from "node:crypto";
import { existsSync, readFileSync, type Dirent } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type AgentSession,
  type AgentSessionRuntime,
  type AgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultPackageManager,
  type PackageSource,
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
  PackageBootstrapResult,
  PackageDescriptor,
  PiCommandDescriptor,
  PiPackageScope,
  PiAgentCatalogSnapshot,
  PiAgentProviderActionResult,
  PiConfigDocumentSnapshot,
  PiConfigScope,
  PiConfigTextAuthorityId,
  PiConfigTextAuthoritySnapshot,
  PiConfigTextDocumentSnapshot,
  PiConfigTextFormat,
  PiConfigTextRoot,
  PiConfigWatchSubscription,
  PiConfigWatchTarget,
  PiFleetActionResult,
  PiFleetSnapshot,
  PiMcpConfigSnapshot,
  PiResourceCatalogSnapshot,
  PiResourceDescriptor,
  PiResourceDiagnostic,
  PiResourceDocumentSnapshot,
  PiResourceKind,
  PiResourceScope,
  PiSettingsSnapshot,
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
  PiSessionFeatureMutation,
  PiSessionFeatureState,
  SessionEntriesResult,
  SessionHeader,
  SessionSnapshot,
  SessionStats,
  SessionSummary,
  SessionTreeNode,
  SessionTreeResult,
  ThinkingLevel,
} from "@piarium/protocol";
import {
  packageSourceEnabled,
  packageSourceValue,
  setPackageSourceEnabled,
} from "./package-activation.js";
import { HostError } from "./errors.js";
import {
  AgentProviderBridge,
  createAgentProviderBridgeExtension,
} from "./agent-providers/bridge.js";
import { AgentProviderRegistry } from "./agent-providers/registry.js";
import { findPiSubagentsTool } from "./agent-providers/pi-subagents-provider.js";
import { ConfigTextFileEditor } from "./config-text-file-editor.js";
import { resolveConfigTextAuthority } from "./config-text-authority-resolver.js";
import { ConfigWatchManager } from "./config-watch-manager.js";
import { createExtensionStateBridgeExtension } from "./extension-state-bridge.js";
import { createPermissionSystemStateBridgeExtension } from "./permission-system-state-bridge.js";
import { ExtensionUiBridge } from "./extension-ui-bridge.js";
import { JsonObjectFileEditor } from "./json-object-file-editor.js";
import { toJsonValue } from "./json.js";
import { ProjectTrustController } from "./project-trust-controller.js";
import { FleetProviderRegistry, createFleetRegistryExtension } from "./fleet/registry.js";
import { PiBackgroundTasksFleetAdapter } from "./fleet/pi-background-tasks-adapter.js";
import { PiSubagentsFleetBridge } from "./pi-subagents-fleet-bridge.js";
import {
  createPiMcpConfigBridgeExtension,
  PiMcpConfigBridge,
} from "./pi-mcp-config-bridge.js";
import { ProviderAuthBridge } from "./provider-auth-bridge.js";
import { ProviderConfigurationManager } from "./provider-configuration.js";
import { RevisionedTextFileEditor } from "./revisioned-text-file-editor.js";
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
import {
  createSessionFeaturesExtension,
  mutateSessionFeatures,
  readSessionFeatures,
  SessionFeatureConflictError,
} from "./session-features.js";

type EventEmitter = <E extends HostEvent>(event: E, data: HostEventData<E>) => void;

const PIARIUM_INSTRUCTIONS_MESSAGE_TYPE = "piarium.instructions";

function overlayFleetExtensionLoadErrors(
  snapshot: PiFleetSnapshot,
  session: AgentSession,
): PiFleetSnapshot {
  const extensions = session.resourceLoader.getExtensions();
  const overlay = (providerId: string, needle: string, incompatibleIssue?: string) => {
    const provider = snapshot.providers.find((entry) => entry.id === providerId);
    if (provider?.state !== "unavailable") return snapshot;
    const loadError = extensions.errors.find((entry) => entry.path.toLowerCase().includes(needle));
    if (loadError) {
      snapshot = {
        ...snapshot,
        providers: snapshot.providers.map((entry) => entry.id === providerId
          ? { ...entry, issue: loadError.error, state: "degraded" as const }
          : entry),
      };
      return snapshot;
    }
    if (providerId === "pi-subagents" && incompatibleIssue && findPiSubagentsTool(session)) {
      snapshot = {
        ...snapshot,
        providers: snapshot.providers.map((entry) => entry.id === providerId
          ? { ...entry, issue: incompatibleIssue, state: "incompatible" as const }
          : entry),
      };
    }
    return snapshot;
  };
  overlay("pi-subagents", "pi-subagents", "The loaded pi-subagents version does not expose fleetStatus v1");
  overlay("pi-background-tasks", "pi-background-tasks");
  return snapshot;
}

function hasPiariumTrustRequiringProjectResources(cwd: string): boolean {
  return hasTrustRequiringProjectResources(cwd)
    || existsSync(join(resolve(cwd), ".pi", "models.json"));
}

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
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1).replace(/\.git$/i, "") || value;
}

function packageManifestFromPath(
  installedPath: string | undefined,
): { name?: string; version?: string } {
  if (!installedPath) return {};
  try {
    const manifest = JSON.parse(readFileSync(join(installedPath, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return {
      ...(typeof manifest.name === "string" && manifest.name.trim().length > 0
        ? { name: manifest.name.trim() }
        : {}),
      ...(typeof manifest.version === "string" && manifest.version.trim().length > 0
        ? { version: manifest.version.trim() }
        : {}),
    };
  } catch {
    return {};
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function resolveConfigDocumentPath(
  base: string,
  requestedPath: string,
  options: {
    extensions?: readonly string[];
    reservedPaths?: readonly string[];
  } = {},
): Promise<{ path: string; relativePath: string }> {
  if (requestedPath.length === 0 || requestedPath.includes("\0")) {
    throw new HostError("invalid_config_path", "Configuration path must be non-empty");
  }
  const extensions = options.extensions ?? [".json"];
  if (!extensions.includes(extname(requestedPath).toLowerCase())) {
    throw new HostError(
      "invalid_config_path",
      `Configuration path must use one of: ${extensions.join(", ")}`,
    );
  }
  const root = resolve(base);
  const path = resolve(root, requestedPath);
  const relativePath = relative(root, path);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new HostError(
      "invalid_config_path",
      "Configuration path must stay inside its configuration root",
    );
  }
  const normalizedPath = relativePath.replaceAll("\\", "/");
  const reservedPaths = options.reservedPaths ?? ["settings.json"];
  if (reservedPaths.some((entry) => normalizedPath.toLowerCase() === entry.toLowerCase())) {
    throw new HostError(
      "invalid_config_path",
      "Configuration path is owned by a dedicated Piarium settings API",
    );
  }
  let current = root;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new HostError(
          "invalid_config_path",
          "Configuration path cannot traverse a symbolic link",
        );
      }
    } catch (error) {
      if (isMissingPathError(error)) break;
      throw error;
    }
  }
  return { path, relativePath: normalizedPath };
}

function homeRoot(): string {
  const configuredHome = process.env.HOME?.trim();
  return configuredHome && isAbsolute(configuredHome) ? resolve(configuredHome) : homedir();
}

function userConfigRoot(): string {
  const configured = process.env.XDG_CONFIG_HOME?.trim();
  if (configured && isAbsolute(configured)) return resolve(configured);
  return join(homeRoot(), ".config");
}

interface ResourceRoot {
  path: string;
  scope: PiResourceScope;
}

interface ResourceOwnership extends ResourceRoot {
  filePath: string;
}

function resourcePathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resourceId(kind: PiResourceKind, filePath: string): string {
  return createHash("sha256")
    .update(kind)
    .update("\0")
    .update(resourcePathKey(filePath))
    .digest("base64url");
}

function normalizeResourceName(kind: PiResourceKind, requestedName: string): string {
  let name = requestedName.trim();
  if (kind === "prompt" && name.toLowerCase().endsWith(".md")) name = name.slice(0, -3);
  if (
    name.length === 0
    || name === "."
    || name === ".."
    || name.includes("\0")
    || name.includes("/")
    || name.includes("\\")
  ) {
    throw new HostError(
      "invalid_resource_name",
      "Resource name must be a non-empty file name without path separators",
    );
  }
  return name;
}

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const pathFromRoot = relative(resolve(rootPath), resolve(candidatePath));
  return (
    pathFromRoot.length > 0
    && pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot)
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

async function copyResourceDirectory(source: string, target: string): Promise<void> {
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink()) {
    throw new HostError("resource_symlink_denied", "Skill copies cannot include symbolic links");
  }
  if (sourceInfo.isDirectory()) {
    await mkdir(target);
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      await copyResourceDirectory(join(source, entry.name), join(target, entry.name));
    }
    return;
  }
  if (!sourceInfo.isFile()) {
    throw new HostError("resource_copy_failed", `Unsupported file type in skill: ${source}`);
  }
  await copyFile(source, target);
}

export class SessionHost {
  readonly #agentDir: string;
  readonly #configureServices: SessionHostOptions["configureServices"];
  readonly #configWatches: ConfigWatchManager;
  readonly #emit: EventEmitter;
  readonly #projectTrustOverride: boolean | undefined;
  readonly #providerConfiguration: ProviderConfigurationManager;
  readonly #runtimeFactory: CreateAgentSessionRuntimeFactory | undefined;
  readonly #trustStore: ProjectTrustStore;
  readonly trust: ProjectTrustController;
  readonly ui: ExtensionUiBridge;
  readonly auth: ProviderAuthBridge;
  #agentProviders: AgentProviderBridge | undefined;
  #fleet: FleetProviderRegistry | undefined;
  #mcpConfig: PiMcpConfigBridge | undefined;
  #runtime: AgentSessionRuntime | undefined;
  #recovery: RecoveryPluginAdapter | undefined;
  #unsubscribe: (() => void) | undefined;
  #disposed = false;

  constructor(options: SessionHostOptions) {
    this.#agentDir = resolve(options.agentDir);
    this.#configureServices = options.configureServices;
    this.#emit = options.emit;
    this.#configWatches = new ConfigWatchManager((subscription, reason) => {
      this.#emit("config.changed", { ...subscription, reason });
    });
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

  async create(cwd: string, name?: string, parentSession?: string): Promise<SessionSnapshot> {
    await this.#replaceWith(SessionManager.create(
      cwd,
      getSessionDir(cwd, this.#agentDir),
      parentSession === undefined ? undefined : { parentSession },
    ));
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
    this.#configWatches.close();
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
      features: readSessionFeatures(session.sessionManager),
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

  readEntries(
    sessionId: string,
    sessionFile: string,
    cwd: string | undefined,
    scope: "branch" | "all",
  ): SessionEntriesResult {
    if (!existsSync(sessionFile)) {
      throw new HostError("session_not_found", `Pi session file does not exist: ${sessionFile}`);
    }
    const manager = SessionManager.open(sessionFile, undefined, cwd);
    const header = manager.getHeader();
    if (!header || header.id !== sessionId) {
      throw new HostError(
        "session_mismatch",
        `Pi session file belongs to ${header?.id ?? "an unknown session"}, not ${sessionId}`,
      );
    }
    const entries = scope === "branch" ? manager.getBranch() : manager.getEntries();
    return {
      entries: entries.map(projectSessionEntry),
      leafId: manager.getLeafId(),
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
    instructions?: string,
  ): Promise<{ accepted: boolean }> {
    this.assertSession(sessionId);
    const session = this.session;
    await this.#queueInstructions(instructions, "nextTurn");
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

  async steer(
    sessionId: string,
    text: string,
    images?: ImageAttachment[],
    instructions?: string,
  ): Promise<boolean> {
    this.assertSession(sessionId);
    await this.#queueInstructions(instructions, "steer");
    await this.session.steer(text, images === undefined ? undefined : toImages(images));
    return true;
  }

  async followUp(
    sessionId: string,
    text: string,
    images?: ImageAttachment[],
    instructions?: string,
  ): Promise<boolean> {
    this.assertSession(sessionId);
    await this.#queueInstructions(instructions, "followUp");
    await this.session.followUp(text, images === undefined ? undefined : toImages(images));
    return true;
  }

  async #queueInstructions(
    instructions: string | undefined,
    deliverAs: "followUp" | "nextTurn" | "steer",
  ): Promise<void> {
    if (!instructions?.trim()) return;
    await this.session.sendCustomMessage(
      {
        content: instructions,
        customType: PIARIUM_INSTRUCTIONS_MESSAGE_TYPE,
        display: false,
      },
      { deliverAs },
    );
  }

  async abort(sessionId: string): Promise<boolean> {
    this.assertSession(sessionId);
    const wasBusy = !this.session.isIdle;
    await this.session.abort();
    const goal = readSessionFeatures(this.session.sessionManager).goal;
    if (wasBusy && goal?.status === "active") {
      this.mutateFeatures(sessionId, {
        goalId: goal.id,
        status: "paused",
        statusReason: "paused after abort",
        type: "goal.update",
      });
    }
    return wasBusy;
  }

  clearQueue(sessionId: string): { cleared: boolean; followUp: string[]; steering: string[] } {
    this.assertSession(sessionId);
    const cleared = this.session.clearQueue();
    return {
      cleared: cleared.followUp.length > 0 || cleared.steering.length > 0,
      followUp: cleared.followUp,
      steering: cleared.steering,
    };
  }

  features(sessionId: string): PiSessionFeatureState {
    this.assertSession(sessionId);
    return readSessionFeatures(this.session.sessionManager);
  }

  mutateFeatures(
    sessionId: string,
    mutation: PiSessionFeatureMutation,
  ): PiSessionFeatureState {
    this.assertSession(sessionId);
    try {
      const state = mutateSessionFeatures(this.session.sessionManager, mutation, {
        tokenBaseline: this.session.getSessionStats().tokens.total,
      });
      this.#emit("session.snapshot", this.snapshot());
      return state;
    } catch (error) {
      if (error instanceof SessionFeatureConflictError) {
        throw new HostError("session_feature_conflict", error.message);
      }
      throw error;
    }
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

  listAgentProviders(): Promise<PiAgentCatalogSnapshot> {
    return this.#agentProviderRegistry().list();
  }

  runAgentProviderAction(
    providerId: string,
    action: string,
    agentId: string | undefined,
    input: JsonValue | undefined,
  ): Promise<PiAgentProviderActionResult> {
    return this.#agentProviderRegistry().action(providerId, action, agentId, input);
  }

  async fleetStatus(sessionId: string): Promise<PiFleetSnapshot> {
    this.assertSession(sessionId);
    const snapshot = await this.fleet.status(sessionId);
    return overlayFleetExtensionLoadErrors(snapshot, this.session);
  }

  async fleetAction(
    sessionId: string,
    providerId: string,
    action: string,
    entryKey: string | undefined,
    input: JsonValue | undefined,
  ): Promise<PiFleetActionResult> {
    this.assertSession(sessionId);
    return this.fleet.action({
      action,
      ...(entryKey === undefined ? {} : { entryKey }),
      ...(input === undefined ? {} : { input }),
      providerId,
      sessionId,
    });
  }

  mcpConfigSnapshot(): Promise<PiMcpConfigSnapshot> {
    return this.mcpConfig.snapshot(this.session.sessionId);
  }

  async listResources(kind: PiResourceKind): Promise<PiResourceCatalogSnapshot> {
    const projectTrusted = this.runtime.services.settingsManager.isProjectTrusted();
    const prompts = kind === "prompt" ? this.session.resourceLoader.getPrompts() : undefined;
    const skills = kind === "skill" ? this.session.resourceLoader.getSkills() : undefined;
    const nativeDiagnostics = prompts?.diagnostics ?? skills?.diagnostics ?? [];
    const diagnostics: PiResourceDiagnostic[] = nativeDiagnostics.map((diagnostic) => ({
      ...(diagnostic.collision === undefined
        ? {}
        : {
            collision: {
              loserPath: diagnostic.collision.loserPath,
              ...(diagnostic.collision.loserSource === undefined
                ? {}
                : { loserSource: diagnostic.collision.loserSource }),
              name: diagnostic.collision.name,
              resourceType: diagnostic.collision.resourceType,
              winnerPath: diagnostic.collision.winnerPath,
              ...(diagnostic.collision.winnerSource === undefined
                ? {}
                : { winnerSource: diagnostic.collision.winnerSource }),
            },
          }),
      message: diagnostic.message,
      ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
      type: diagnostic.type,
    }));
    const nativeResources: PiResourceDescriptor[] = prompts
      ? prompts.prompts.map((resource) => ({
          active: true,
          ...(resource.argumentHint === undefined ? {} : { argumentHint: resource.argumentHint }),
          description: resource.description,
          filePath: resource.filePath,
          id: resourceId(kind, resource.filePath),
          kind,
          name: resource.name,
          sourceInfo: {
            ...(resource.sourceInfo.baseDir === undefined
              ? {}
              : { baseDir: resource.sourceInfo.baseDir }),
            origin: resource.sourceInfo.origin,
            path: resource.sourceInfo.path,
            scope: resource.sourceInfo.scope,
            source: resource.sourceInfo.source,
          },
          valid: true,
          writable: false,
        }))
      : (skills?.skills ?? []).map((resource) => ({
          active: true,
          baseDir: resource.baseDir,
          description: resource.description,
          disableModelInvocation: resource.disableModelInvocation,
          filePath: resource.filePath,
          id: resourceId(kind, resource.filePath),
          kind,
          name: resource.name,
          sourceInfo: {
            ...(resource.sourceInfo.baseDir === undefined
              ? {}
              : { baseDir: resource.sourceInfo.baseDir }),
            origin: resource.sourceInfo.origin,
            path: resource.sourceInfo.path,
            scope: resource.sourceInfo.scope,
            source: resource.sourceInfo.source,
          },
          valid: true,
          writable: false,
        }));
    const resources = await Promise.all(
      nativeResources.map(async (resource) => {
        const ownership = await this.#resourceOwnership(
          kind,
          resource.filePath,
          resource.sourceInfo.origin,
          resource.sourceInfo.scope,
        );
        return {
          ...resource,
          writable: ownership !== undefined,
        } satisfies PiResourceDescriptor;
      }),
    );
    const knownIds = new Set(resources.map((resource) => resource.id));
    for (const candidate of await this.#resourceCandidateFiles(kind, projectTrusted)) {
      const id = resourceId(kind, candidate.filePath);
      if (knownIds.has(id)) continue;
      const matchingDiagnostics = diagnostics.filter((diagnostic) => {
        if (diagnostic.path && resourcePathKey(diagnostic.path) === resourcePathKey(candidate.filePath)) {
          return true;
        }
        return diagnostic.collision
          ? resourcePathKey(diagnostic.collision.loserPath) === resourcePathKey(candidate.filePath)
          : false;
      });
      const collisionOnly =
        matchingDiagnostics.length > 0
        && matchingDiagnostics.every((diagnostic) => diagnostic.type === "collision");
      const fileName = basename(candidate.filePath);
      resources.push({
        active: false,
        ...(kind === "skill" ? { baseDir: dirname(candidate.filePath) } : {}),
        description: "",
        filePath: candidate.filePath,
        id,
        kind,
        name: kind === "prompt"
          ? fileName.replace(/\.md$/i, "")
          : fileName.toLowerCase() === "skill.md"
            ? basename(dirname(candidate.filePath))
            : fileName.replace(/\.md$/i, ""),
        sourceInfo: {
          baseDir: candidate.root,
          origin: "top-level",
          path: candidate.filePath,
          scope: candidate.scope,
          source: "local",
        },
        valid: collisionOnly,
        writable: true,
      });
      knownIds.add(id);
    }
    resources.sort((left, right) =>
      left.name.localeCompare(right.name) || left.filePath.localeCompare(right.filePath),
    );
    return { diagnostics, projectTrusted, resources };
  }

  async getResource(kind: PiResourceKind, id: string): Promise<PiResourceDocumentSnapshot> {
    const descriptor = await this.#findResource(kind, id);
    const snapshot = await new RevisionedTextFileEditor(descriptor.filePath, {
      conflictCode: "resource_conflict",
      conflictLabel: "Resource",
    }).read();
    if (!snapshot.exists) {
      throw new HostError("resource_not_found", `Pi ${kind} resource no longer exists: ${id}`);
    }
    return {
      content: snapshot.content,
      descriptor,
      projectTrusted: this.runtime.services.settingsManager.isProjectTrusted(),
      revision: snapshot.revision,
    };
  }

  async createResource(
    kind: PiResourceKind,
    scope: PiResourceScope,
    requestedName: string,
    content: string,
  ): Promise<PiResourceDocumentSnapshot> {
    this.#assertResourceScopeTrusted(scope);
    const target = await this.#resourceTarget(kind, scope, requestedName);
    const editor = new RevisionedTextFileEditor(target.filePath, {
      conflictCode: "resource_conflict",
      conflictLabel: "Resource",
    });
    const current = await editor.read();
    if (current.exists) {
      throw new HostError("resource_exists", `A Pi ${kind} resource already exists at ${target.filePath}`);
    }
    await editor.update(content, current.revision);
    await this.session.reload();
    return this.getResource(kind, resourceId(kind, target.filePath));
  }

  async updateResource(
    kind: PiResourceKind,
    id: string,
    content: string,
    expectedRevision: string,
  ): Promise<PiResourceDocumentSnapshot> {
    const descriptor = await this.#findResource(kind, id);
    const ownership = await this.#requireResourceOwnership(descriptor);
    this.#assertResourceScopeTrusted(ownership.scope);
    await new RevisionedTextFileEditor(descriptor.filePath, {
      conflictCode: "resource_conflict",
      conflictLabel: "Resource",
    }).update(content, expectedRevision);
    await this.session.reload();
    return this.getResource(kind, id);
  }

  async deleteResource(
    kind: PiResourceKind,
    id: string,
    expectedRevision: string,
  ): Promise<{ deleted: boolean; id: string }> {
    const descriptor = await this.#findResource(kind, id);
    const ownership = await this.#requireResourceOwnership(descriptor);
    this.#assertResourceScopeTrusted(ownership.scope);
    const deleted = await new RevisionedTextFileEditor(descriptor.filePath, {
      conflictCode: "resource_conflict",
      conflictLabel: "Resource",
    }).delete(expectedRevision);
    if (
      deleted
      && kind === "skill"
      && basename(descriptor.filePath).toLowerCase() === "skill.md"
    ) {
      const skillDirectory = resolve(descriptor.baseDir ?? dirname(descriptor.filePath));
      if (
        resourcePathKey(skillDirectory) === resourcePathKey(dirname(descriptor.filePath))
        && isPathInside(ownership.path, skillDirectory)
      ) {
        await rm(skillDirectory, { force: true, recursive: true });
      }
    }
    if (deleted) await this.session.reload();
    return { deleted, id };
  }

  async copyResource(
    kind: PiResourceKind,
    id: string,
    scope: PiResourceScope,
    requestedName?: string,
  ): Promise<PiResourceDocumentSnapshot> {
    this.#assertResourceScopeTrusted(scope);
    const source = await this.getResource(kind, id);
    const target = await this.#resourceTarget(
      kind,
      scope,
      requestedName ?? source.descriptor.name,
    );
    if (kind === "skill" && basename(source.descriptor.filePath).toLowerCase() === "skill.md") {
      const sourceDirectory = resolve(source.descriptor.baseDir ?? dirname(source.descriptor.filePath));
      const targetDirectory = dirname(target.filePath);
      if (await pathExists(targetDirectory)) {
        throw new HostError(
          "resource_exists",
          `A Pi skill resource already exists at ${targetDirectory}`,
        );
      }
      try {
        await mkdir(target.path, { recursive: true });
        await copyResourceDirectory(sourceDirectory, targetDirectory);
      } catch (error) {
        if (isPathInside(target.path, targetDirectory)) {
          await rm(targetDirectory, { force: true, recursive: true }).catch(() => undefined);
        }
        throw error;
      }
    } else {
      const editor = new RevisionedTextFileEditor(target.filePath, {
        conflictCode: "resource_conflict",
        conflictLabel: "Resource",
      });
      const current = await editor.read();
      if (current.exists) {
        throw new HostError(
          "resource_exists",
          `A Pi ${kind} resource already exists at ${target.filePath}`,
        );
      }
      await editor.update(source.content, current.revision);
    }
    await this.session.reload();
    return this.getResource(kind, resourceId(kind, target.filePath));
  }

  listCommands(sessionId: string): PiCommandDescriptor[] {
    this.assertSession(sessionId);
    const extensionCommands: PiCommandDescriptor[] = this.session.extensionRunner
      .getRegisteredCommands()
      .map((command) => ({
        ...(command.description === undefined ? {} : { description: command.description }),
        name: command.invocationName,
        source: "extension",
        sourceInfo: command.sourceInfo,
      }));
    const templates: PiCommandDescriptor[] = this.session.promptTemplates.map((template) => ({
      ...(template.argumentHint === undefined ? {} : { argumentHint: template.argumentHint }),
      ...(template.description === undefined ? {} : { description: template.description }),
      name: template.name,
      source: "prompt",
      sourceInfo: template.sourceInfo,
    }));
    const skills: PiCommandDescriptor[] = this.session.resourceLoader.getSkills().skills.map((skill) => ({
      description: skill.description,
      name: `skill:${skill.name}`,
      source: "skill",
      sourceInfo: skill.sourceInfo,
    }));
    return [...extensionCommands, ...templates, ...skills];
  }

  async executeCommand(sessionId: string, command: string): Promise<JsonValue> {
    this.assertSession(sessionId);
    if (!command.startsWith("/")) {
      throw new HostError("invalid_command", "Slash commands must start with '/'");
    }
    await this.session.prompt(command);
    return { executed: true };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const projectTrusted = this.runtime.services.settingsManager.isProjectTrusted();
    await this.#providerConfiguration.apply(
      this.runtime.services.modelRuntime,
      this.runtime.cwd,
      projectTrusted,
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
    const projectTrusted = this.runtime.services.settingsManager.isProjectTrusted();
    await this.#providerConfiguration.apply(
      this.runtime.services.modelRuntime,
      this.runtime.cwd,
      projectTrusted,
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
    const projectTrusted = this.runtime.services.settingsManager.isProjectTrusted();
    await this.#providerConfiguration.apply(
      this.runtime.services.modelRuntime,
      this.runtime.cwd,
      projectTrusted,
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
    const projectTrusted = this.runtime.services.settingsManager.isProjectTrusted();
    await this.#providerConfiguration.apply(modelRuntime, this.runtime.cwd, projectTrusted);
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
    const projectTrusted = this.runtime.services.settingsManager.isProjectTrusted();
    await this.#providerConfiguration.apply(runtime, this.runtime.cwd, projectTrusted);
    return this.#providerConfiguration.getDetails(
      runtime,
      this.runtime.cwd,
      providerId,
      projectTrusted,
    );
  }

  async upsertProviderConfiguration(
    scope: ProviderConfigScope,
    config: ProviderConfigInput,
  ): Promise<ProviderConfigDetails> {
    const runtime = this.runtime.services.modelRuntime;
    const projectTrusted = this.runtime.services.settingsManager.isProjectTrusted();
    const details = await this.#providerConfiguration.upsert(
      runtime,
      this.runtime.cwd,
      scope,
      config,
      projectTrusted,
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
    const projectTrusted = this.runtime.services.settingsManager.isProjectTrusted();
    if ((scope === "project" || scope === "all") && !projectTrusted) {
      throw new HostError(
        "project_not_trusted",
        "Project is not trusted; refusing to change project provider configuration",
      );
    }
    if (scope === "auth" || scope === "all") {
      await runtime.logout(providerId);
    }
    const details =
      scope === "auth"
        ? await this.#providerConfiguration.getDetails(
          runtime,
          this.runtime.cwd,
          providerId,
          projectTrusted,
        )
        : await this.#providerConfiguration.delete(
          runtime,
          this.runtime.cwd,
          providerId,
          scope,
          projectTrusted,
        );
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
    const projectTrusted = this.runtime.services.settingsManager.isProjectTrusted();
    await this.#providerConfiguration.apply(runtime, this.runtime.cwd, projectTrusted);
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
      projectTrusted,
      ...(apiKey === undefined ? {} : { apiKey }),
      providerId,
      runtime,
    });
  }

  listPackages(): PackageDescriptor[] {
    const manager = this.#packageManager();
    return manager.listConfiguredPackages().map((entry) => {
      const manifest = packageManifestFromPath(entry.installedPath);
      const settings = entry.scope === "project"
        ? this.runtime.services.settingsManager.getProjectSettings()
        : this.runtime.services.settingsManager.getGlobalSettings();
      const configured = (settings.packages ?? []).find((candidate) => (
        packageSourceValue(candidate) === entry.source
      ));
      return {
        enabled: configured === undefined ? true : packageSourceEnabled(configured),
        installed: entry.installedPath !== undefined && existsSync(entry.installedPath),
        name: manifest.name ?? packageNameFromSource(entry.source),
        ...(entry.installedPath === undefined ? {} : { resolvedPath: entry.installedPath }),
        scope: entry.scope === "project" ? "project" : "global",
        source: entry.source,
        structured: entry.filtered,
        ...(manifest.version === undefined ? {} : { version: manifest.version }),
      };
    });
  }

  async refreshPackages(): Promise<PackageDescriptor[]> {
    await this.#reloadPackageSettings();
    return this.listPackages();
  }

  async bootstrapPackages(sources: readonly string[]): Promise<PackageBootstrapResult> {
    await this.#reloadPackageSettings();
    const manager = this.#packageManager();
    const results: PackageBootstrapResult["results"] = [];
    let changed = false;
    for (const source of sources) {
      const sourceIdentity = packageNameFromSource(source).toLowerCase();
      const configured = this.listPackages().some((entry) => (
        entry.scope === "global"
        && (
          entry.source === source
          || entry.name.toLowerCase() === sourceIdentity
          || packageNameFromSource(entry.source).toLowerCase() === sourceIdentity
        )
      ));
      if (configured) {
        results.push({ source, status: "already_configured" });
        continue;
      }
      try {
        await manager.installAndPersist(source, { local: false });
        changed = true;
        results.push({ source, status: "installed" });
      } catch (error) {
        results.push({
          error: error instanceof Error ? error.message : String(error),
          source,
          status: "failed",
        });
      }
    }
    if (changed) {
      await this.#flushPackageSettings();
      await this.session.reload();
    }
    return { packages: this.listPackages(), results };
  }

  async installPackage(source: string, scope: PiPackageScope): Promise<PackageDescriptor> {
    await this.#reloadPackageSettings();
    const manager = this.#packageManager();
    await manager.installAndPersist(source, { local: scope === "project" });
    await this.#flushPackageSettings();
    await this.session.reload();
    const resolvedPath = manager.getInstalledPath(source, scope === "project" ? "project" : "user");
    return this.listPackages().find((entry) => (
      entry.scope === scope
      && (entry.source === source || (resolvedPath !== undefined && entry.resolvedPath === resolvedPath))
    )) ?? {
      enabled: true,
      installed: resolvedPath !== undefined,
      name: packageNameFromSource(source),
      ...(resolvedPath === undefined ? {} : { resolvedPath }),
      scope,
      source,
      structured: false,
    };
  }

  async setPackageEnabled(
    source: string,
    scope: PiPackageScope,
    enabled: boolean,
  ): Promise<PackageDescriptor> {
    await this.#reloadPackageSettings();
    const settings = this.runtime.services.settingsManager;
    const current = scope === "project"
      ? settings.getProjectSettings().packages ?? []
      : settings.getGlobalSettings().packages ?? [];
    const index = current.findIndex((entry) => packageSourceValue(entry) === source);
    if (index === -1) {
      throw new HostError("package_not_configured", `Pi package is not configured: ${source}`);
    }
    const next: PackageSource[] = [...current];
    next[index] = setPackageSourceEnabled(next[index] as PackageSource, enabled);
    if (scope === "project") settings.setProjectPackages(next);
    else settings.setPackages(next);
    await settings.flush();
    const writeErrors = settings.drainErrors();
    if (writeErrors.length > 0) {
      await settings.reload();
      throw new HostError(
        "settings_write_failed",
        writeErrors.map((entry) => entry.error.message).join("; "),
      );
    }
    await this.session.reload();
    const descriptor = this.listPackages().find((entry) => (
      entry.scope === scope && entry.source === source
    ));
    if (!descriptor) {
      throw new HostError("package_not_configured", `Pi package is not configured: ${source}`);
    }
    return descriptor;
  }

  async removePackage(source: string, scope: PiPackageScope): Promise<boolean> {
    await this.#reloadPackageSettings();
    const manager = this.#packageManager();
    const local = scope === "project";
    const configured = manager.listConfiguredPackages().find((entry) => (
      entry.scope === (local ? "project" : "user") && entry.source === source
    ));
    let removed = await manager.removeAndPersist(source, { local });
    if (!removed && configured?.installedPath) {
      // Pi stores local project packages relative to `.pi`, while its public
      // removal matcher resolves input relative to the workspace. Retry with
      // the already-resolved path so the exact configured entry is removed.
      removed = manager.removeSourceFromSettings(configured.installedPath, { local });
    }
    if (!removed && configured) {
      // Pi resolves an input local path relative to the workspace, but stores a
      // project-local source relative to `.pi`. If the source directory has
      // disappeared there is no installed path left to bridge those bases, so
      // remove the exact configured entry without guessing another identity.
      const settings = this.runtime.services.settingsManager;
      const current = local
        ? settings.getProjectSettings().packages ?? []
        : settings.getGlobalSettings().packages ?? [];
      const next = current.filter((entry) => (
        (typeof entry === "string" ? entry : entry.source) !== configured.source
      ));
      if (next.length !== current.length) {
        if (local) settings.setProjectPackages(next);
        else settings.setPackages(next);
        removed = true;
      }
    }
    await this.#flushPackageSettings();
    await this.session.reload();
    return removed;
  }

  async updatePackages(source?: string): Promise<PackageDescriptor[]> {
    await this.#reloadPackageSettings();
    const manager = this.#packageManager();
    await manager.update(source);
    await this.session.reload();
    return this.listPackages();
  }

  async getSettings(): Promise<PiSettingsSnapshot> {
    const settings = this.runtime.services.settingsManager;
    await settings.reload();
    const reloadErrors = settings.drainErrors();
    if (reloadErrors.length > 0) {
      throw new HostError(
        "settings_read_failed",
        reloadErrors.map((entry) => entry.error.message).join("; "),
      );
    }
    return this.#settingsSnapshot();
  }

  async #settingsSnapshot(): Promise<PiSettingsSnapshot> {
    const settings = this.runtime.services.settingsManager;
    const [globalSource, projectSource] = await Promise.all([
      new JsonObjectFileEditor(join(this.#agentDir, "settings.json")).read(),
      new JsonObjectFileEditor(join(this.runtime.cwd, ".pi", "settings.json")).read(),
    ]);
    return {
      global: globalSource.document,
      globalRevision: globalSource.revision,
      project: projectSource.document,
      projectRevision: projectSource.revision,
      projectTrusted: settings.isProjectTrusted(),
    };
  }

  async getConfigDocument(
    scope: PiConfigScope,
    requestedPath: string,
  ): Promise<PiConfigDocumentSnapshot> {
    const settings = this.runtime.services.settingsManager;
    if (scope === "project" && !settings.isProjectTrusted()) {
      throw new HostError(
        "project_not_trusted",
        "Project is not trusted; refusing to read project configuration",
      );
    }
    const location = await resolveConfigDocumentPath(
      scope === "global" ? this.#agentDir : join(this.runtime.cwd, ".pi"),
      requestedPath,
    );
    const result = await new JsonObjectFileEditor(location.path).read();
    return {
      document: result.document,
      exists: result.exists,
      path: location.relativePath,
      projectTrusted: settings.isProjectTrusted(),
      revision: result.revision,
      scope,
    };
  }

  async updateConfigDocument(
    scope: PiConfigScope,
    requestedPath: string,
    set: JsonValue,
    remove: readonly string[],
    expectedRevision: string,
  ): Promise<PiConfigDocumentSnapshot> {
    const settings = this.runtime.services.settingsManager;
    if (scope === "project" && !settings.isProjectTrusted()) {
      throw new HostError(
        "project_not_trusted",
        "Project is not trusted; refusing to write project configuration",
      );
    }
    const location = await resolveConfigDocumentPath(
      scope === "global" ? this.#agentDir : join(this.runtime.cwd, ".pi"),
      requestedPath,
    );
    await settings.flush();
    const pendingErrors = settings.drainErrors();
    if (pendingErrors.length > 0) {
      throw new HostError(
        "settings_write_failed",
        pendingErrors.map((entry) => entry.error.message).join("; "),
      );
    }
    const snapshot = await new JsonObjectFileEditor(location.path).updateRevisioned(
      set,
      remove,
      expectedRevision,
    );
    await this.session.reload();
    return {
      document: snapshot.document,
      exists: snapshot.exists,
      path: location.relativePath,
      projectTrusted: this.runtime.services.settingsManager.isProjectTrusted(),
      revision: snapshot.revision,
      scope,
    };
  }

  async getConfigTextDocument(
    root: PiConfigTextRoot,
    format: PiConfigTextFormat,
    requestedPath: string,
  ): Promise<PiConfigTextDocumentSnapshot> {
    const settings = this.runtime.services.settingsManager;
    if (root === "project" && !settings.isProjectTrusted()) {
      throw new HostError(
        "project_not_trusted",
        "Project is not trusted; refusing to read project configuration",
      );
    }
    const base = root === "agent"
      ? this.#agentDir
      : root === "home"
        ? homeRoot()
      : root === "project"
        ? this.runtime.cwd
        : userConfigRoot();
    const location = await resolveConfigDocumentPath(base, requestedPath, {
      extensions: format === "json" ? [".json"] : [".jsonc", ".json"],
      reservedPaths: root === "agent"
        ? ["settings.json", "models.json"]
        : root === "project"
          ? [".pi/settings.json", ".pi/models.json"]
          : [],
    });
    const snapshot = await new ConfigTextFileEditor(location.path, format).read();
    return {
      ...snapshot,
      format,
      path: location.relativePath,
      projectTrusted: settings.isProjectTrusted(),
      root,
    };
  }

  async updateConfigTextDocument(
    root: PiConfigTextRoot,
    format: PiConfigTextFormat,
    requestedPath: string,
    content: string,
    expectedRevision: string,
  ): Promise<PiConfigTextDocumentSnapshot> {
    const settings = this.runtime.services.settingsManager;
    if (root === "project" && !settings.isProjectTrusted()) {
      throw new HostError(
        "project_not_trusted",
        "Project is not trusted; refusing to write project configuration",
      );
    }
    const base = root === "agent"
      ? this.#agentDir
      : root === "home"
        ? homeRoot()
      : root === "project"
        ? this.runtime.cwd
        : userConfigRoot();
    const location = await resolveConfigDocumentPath(base, requestedPath, {
      extensions: format === "json" ? [".json"] : [".jsonc", ".json"],
      reservedPaths: root === "agent"
        ? ["settings.json", "models.json"]
        : root === "project"
          ? [".pi/settings.json", ".pi/models.json"]
          : [],
    });
    await settings.flush();
    const pendingErrors = settings.drainErrors();
    if (pendingErrors.length > 0) {
      throw new HostError(
        "settings_write_failed",
        pendingErrors.map((entry) => entry.error.message).join("; "),
      );
    }
    const snapshot = await new ConfigTextFileEditor(location.path, format).update(
      content,
      expectedRevision,
    );
    await this.session.reload();
    return {
      ...snapshot,
      format,
      path: location.relativePath,
      projectTrusted: this.runtime.services.settingsManager.isProjectTrusted(),
      root,
    };
  }

  async getConfigTextAuthority(
    authority: PiConfigTextAuthorityId,
  ): Promise<PiConfigTextAuthoritySnapshot> {
    const settings = this.runtime.services.settingsManager;
    this.#assertConfigTextAuthorityTrusted(authority, "read");
    const location = await resolveConfigTextAuthority(
      authority,
      this.runtime.cwd,
      this.#agentDir,
    );
    const snapshot = await new ConfigTextFileEditor(location.path, location.format).read();
    return {
      authority,
      ...snapshot,
      format: location.format,
      path: location.path,
      projectTrusted: settings.isProjectTrusted(),
    };
  }

  async updateConfigTextAuthority(
    authority: PiConfigTextAuthorityId,
    content: string,
    expectedRevision: string,
  ): Promise<PiConfigTextAuthoritySnapshot> {
    const settings = this.runtime.services.settingsManager;
    this.#assertConfigTextAuthorityTrusted(authority, "write");
    const location = await resolveConfigTextAuthority(
      authority,
      this.runtime.cwd,
      this.#agentDir,
    );
    await settings.flush();
    const pendingErrors = settings.drainErrors();
    if (pendingErrors.length > 0) {
      throw new HostError(
        "settings_write_failed",
        pendingErrors.map((entry) => entry.error.message).join("; "),
      );
    }
    const snapshot = await new ConfigTextFileEditor(location.path, location.format).update(
      content,
      expectedRevision,
    );
    await this.session.reload();
    return {
      authority,
      ...snapshot,
      format: location.format,
      path: location.path,
      projectTrusted: this.runtime.services.settingsManager.isProjectTrusted(),
    };
  }

  async watchConfig(target: PiConfigWatchTarget): Promise<PiConfigWatchSubscription> {
    const settings = this.runtime.services.settingsManager;
    if (
      (target.kind === "document" && target.scope === "project")
      || (target.kind === "text" && target.root === "project")
      || (target.kind === "text-authority" && target.authority === "pi-lens-project")
      || (target.kind === "settings" && target.scope === "project")
    ) {
      if (!settings.isProjectTrusted()) {
        throw new HostError(
          "project_not_trusted",
          "Project is not trusted; refusing to watch project configuration",
        );
      }
    }

    if (target.kind === "document") {
      const location = await resolveConfigDocumentPath(
        target.scope === "global" ? this.#agentDir : join(this.runtime.cwd, ".pi"),
        target.path,
      );
      return this.#configWatches.watch(
        { ...target, path: location.relativePath },
        [location.path],
      );
    }
    if (target.kind === "text") {
      const base = target.root === "agent"
        ? this.#agentDir
        : target.root === "home"
          ? homeRoot()
          : target.root === "project"
            ? this.runtime.cwd
            : userConfigRoot();
      const location = await resolveConfigDocumentPath(base, target.path, {
        extensions: target.format === "json" ? [".json"] : [".jsonc", ".json"],
        reservedPaths: target.root === "agent"
          ? ["settings.json", "models.json"]
          : target.root === "project"
            ? [".pi/settings.json", ".pi/models.json"]
            : [],
      });
      return this.#configWatches.watch(
        { ...target, path: location.relativePath },
        [location.path],
      );
    }
    if (target.kind === "text-authority") {
      const location = await resolveConfigTextAuthority(
        target.authority,
        this.runtime.cwd,
        this.#agentDir,
      );
      return this.#configWatches.watch(target, location.watchPaths);
    }

    const settingsRoot = target.scope === "global"
      ? this.#agentDir
      : join(this.runtime.cwd, ".pi");
    const location = await resolveConfigDocumentPath(settingsRoot, "settings.json", {
      reservedPaths: [],
    });
    return this.#configWatches.watch(target, [location.path]);
  }

  unwatchConfig(watchId: string): boolean {
    return this.#configWatches.unwatch(watchId);
  }

  #assertConfigTextAuthorityTrusted(
    authority: PiConfigTextAuthorityId,
    operation: "read" | "write",
  ): void {
    if (
      authority === "pi-lens-project"
      && !this.runtime.services.settingsManager.isProjectTrusted()
    ) {
      throw new HostError(
        "project_not_trusted",
        `Project is not trusted; refusing to ${operation} project configuration`,
      );
    }
  }

  async updateSettings(
    scope: PiConfigScope,
    set: JsonValue,
    remove: readonly string[],
    expectedRevision: string,
  ): Promise<PiSettingsSnapshot> {
    const settings = this.runtime.services.settingsManager;
    if (scope === "project" && !settings.isProjectTrusted()) {
      throw new HostError(
        "project_not_trusted",
        "Project is not trusted; refusing to write project settings",
      );
    }
    await settings.flush();
    const pendingErrors = settings.drainErrors();
    if (pendingErrors.length > 0) {
      throw new HostError(
        "settings_write_failed",
        pendingErrors.map((entry) => entry.error.message).join("; "),
      );
    }
    const settingsPath = scope === "global"
      ? join(this.#agentDir, "settings.json")
      : join(this.runtime.cwd, ".pi", "settings.json");
    await new JsonObjectFileEditor(settingsPath).updateRevisioned(
      set,
      remove,
      expectedRevision,
    );
    await settings.reload();
    const reloadErrors = settings.drainErrors();
    if (reloadErrors.length > 0) {
      throw new HostError(
        "settings_write_failed",
        reloadErrors.map((entry) => entry.error.message).join("; "),
      );
    }
    await this.session.reload();
    return this.#settingsSnapshot();
  }

  #resourceRoots(kind: PiResourceKind): ResourceRoot[] {
    const roots: ResourceRoot[] = kind === "prompt"
      ? [
          { path: join(this.#agentDir, "prompts"), scope: "user" },
          { path: join(this.runtime.cwd, ".pi", "prompts"), scope: "project" },
        ]
      : [
          { path: join(this.#agentDir, "skills"), scope: "user" },
          { path: join(homeRoot(), ".agents", "skills"), scope: "user" },
          { path: join(this.runtime.cwd, ".pi", "skills"), scope: "project" },
          { path: join(this.runtime.cwd, ".agents", "skills"), scope: "project" },
        ];
    const seen = new Set<string>();
    return roots.filter((root) => {
      const key = resourcePathKey(root.path);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  #agentProviderRegistry(): AgentProviderRegistry {
    return new AgentProviderRegistry(
      {
        agentDir: this.#agentDir,
        cwd: this.runtime.cwd,
        projectTrusted: this.runtime.services.settingsManager.isProjectTrusted(),
        session: this.session,
      },
      this.#agentProviders,
    );
  }

  async #resourceOwnership(
    kind: PiResourceKind,
    filePath: string,
    origin: "package" | "top-level",
    scope: PiResourceScope | "temporary",
  ): Promise<ResourceOwnership | undefined> {
    if (origin !== "top-level" || scope === "temporary") return undefined;
    for (const root of this.#resourceRoots(kind)) {
      if (root.scope !== scope || !isPathInside(root.path, filePath)) continue;
      const relativePath = relative(resolve(root.path), resolve(filePath));
      try {
        const resolved = await resolveConfigDocumentPath(root.path, relativePath, {
          extensions: [".md"],
          reservedPaths: [],
        });
        if (resourcePathKey(resolved.path) !== resourcePathKey(filePath)) continue;
        return { ...root, filePath: resolved.path };
      } catch (error) {
        if (error instanceof HostError) continue;
        throw error;
      }
    }
    return undefined;
  }

  async #requireResourceOwnership(
    descriptor: PiResourceDescriptor,
  ): Promise<ResourceOwnership> {
    const ownership = await this.#resourceOwnership(
      descriptor.kind,
      descriptor.filePath,
      descriptor.sourceInfo.origin,
      descriptor.sourceInfo.scope,
    );
    if (!ownership) {
      throw new HostError(
        "resource_read_only",
        "Package, temporary, linked, and externally configured Pi resources are read-only; copy the resource into the user or project scope before editing",
      );
    }
    return ownership;
  }

  async #resourceTarget(
    kind: PiResourceKind,
    scope: PiResourceScope,
    requestedName: string,
  ): Promise<ResourceOwnership> {
    const name = normalizeResourceName(kind, requestedName);
    const root = this.#resourceRoots(kind).find((candidate) => candidate.scope === scope);
    if (!root) throw new HostError("resource_scope_unavailable", `No ${scope} ${kind} root exists`);
    const requestedPath = kind === "prompt" ? `${name}.md` : join(name, "SKILL.md");
    const location = await resolveConfigDocumentPath(root.path, requestedPath, {
      extensions: [".md"],
      reservedPaths: [],
    });
    return { ...root, filePath: location.path };
  }

  async #findResource(kind: PiResourceKind, id: string): Promise<PiResourceDescriptor> {
    const descriptor = (await this.listResources(kind)).resources.find(
      (resource) => resource.id === id,
    );
    if (!descriptor) {
      throw new HostError("resource_not_found", `Unknown Pi ${kind} resource: ${id}`);
    }
    return descriptor;
  }

  #assertResourceScopeTrusted(scope: PiResourceScope): void {
    if (scope === "project" && !this.runtime.services.settingsManager.isProjectTrusted()) {
      throw new HostError(
        "project_not_trusted",
        "Project is not trusted; refusing to write project resources",
      );
    }
  }

  async #resourceCandidateFiles(
    kind: PiResourceKind,
    projectTrusted: boolean,
  ): Promise<Array<{ filePath: string; root: string; scope: PiResourceScope }>> {
    const candidates: Array<{ filePath: string; root: string; scope: PiResourceScope }> = [];
    for (const root of this.#resourceRoots(kind)) {
      if (root.scope === "project" && !projectTrusted) continue;
      let rootInfo: Awaited<ReturnType<typeof lstat>>;
      try {
        rootInfo = await lstat(root.path);
      } catch (error) {
        if (isMissingPathError(error)) continue;
        throw error;
      }
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) continue;
      let files: string[];
      try {
        files = kind === "prompt"
          ? (await readdir(root.path, { withFileTypes: true }))
              .filter(
                (entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".md"),
              )
              .map((entry) => join(root.path, entry.name))
          : await this.#walkSkillCandidates(root.path, true);
      } catch {
        continue;
      }
      candidates.push(
        ...files.map((filePath) => ({ filePath, root: root.path, scope: root.scope })),
      );
    }
    return candidates;
  }

  async #walkSkillCandidates(
    directory: string,
    includeRootFiles: boolean,
  ): Promise<string[]> {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return [];
    }
    const skillFile = entries.find(
      (entry) =>
        entry.name.toLowerCase() === "skill.md"
        && entry.isFile()
        && !entry.isSymbolicLink(),
    );
    if (skillFile) return [join(directory, skillFile.name)];
    const files = includeRootFiles
      ? entries
          .filter(
            (entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".md"),
          )
          .map((entry) => join(directory, entry.name))
      : [];
    for (const entry of entries) {
      if (
        !entry.isDirectory()
        || entry.isSymbolicLink()
        || entry.name.startsWith(".")
        || entry.name === "node_modules"
      ) {
        continue;
      }
      files.push(...(await this.#walkSkillCandidates(join(directory, entry.name), false)));
    }
    return files;
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
    this.#configWatches.close();
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
      const requiresTrust = hasPiariumTrustRequiringProjectResources(cwd);
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
      const agentProviders = new AgentProviderBridge();
      this.#agentProviders = agentProviders;
      const fleet = new FleetProviderRegistry([
        new PiSubagentsFleetBridge(),
        new PiBackgroundTasksFleetAdapter(),
      ]);
      this.#fleet = fleet;
      const mcpConfig = new PiMcpConfigBridge();
      this.#mcpConfig = mcpConfig;
      const services = await createAgentSessionServices({
        agentDir,
        cwd,
        resourceLoaderOptions: {
          extensionFactories: [
            {
              factory: createSessionFeaturesExtension(),
              hidden: true,
              name: "piarium-session-features",
            },
            {
              factory: createExtensionStateBridgeExtension(this.#emit),
              hidden: true,
              name: "piarium-extension-state-bridge",
            },
            {
              factory: createPermissionSystemStateBridgeExtension(this.#emit),
              hidden: true,
              name: "piarium-permission-system-state-bridge",
            },
            {
              factory: createFleetRegistryExtension(fleet),
              hidden: true,
              name: "piarium-fleet-registry",
            },
            {
              factory: createPiMcpConfigBridgeExtension(mcpConfig),
              hidden: true,
              name: "piarium-mcp-config-bridge",
            },
            {
              factory: createAgentProviderBridgeExtension(agentProviders),
              hidden: true,
              name: "piarium-agent-provider-bridge",
            },
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
        settingsManager.isProjectTrusted(),
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

  async #reloadPackageSettings(): Promise<void> {
    const settings = this.runtime.services.settingsManager;
    await settings.reload();
    const errors = settings.drainErrors();
    if (errors.length > 0) {
      throw new HostError(
        "settings_read_failed",
        errors.map((entry) => entry.error.message).join("; "),
      );
    }
  }

  async #flushPackageSettings(): Promise<void> {
    const settings = this.runtime.services.settingsManager;
    await settings.flush();
    const errors = settings.drainErrors();
    if (errors.length === 0) return;
    await settings.reload();
    throw new HostError(
      "settings_write_failed",
      errors.map((entry) => entry.error.message).join("; "),
    );
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
    this.#agentProviders = undefined;
    this.#fleet = undefined;
    this.#mcpConfig = undefined;
    this.#recovery = undefined;
  }

  get fleet(): FleetProviderRegistry {
    if (!this.#fleet) throw new HostError("fleet_unavailable", "Fleet is unavailable");
    return this.#fleet;
  }

  get recovery(): RecoveryPluginAdapter {
    if (!this.#recovery) throw new HostError("recovery_unavailable", "Recovery is unavailable");
    return this.#recovery;
  }

  get mcpConfig(): PiMcpConfigBridge {
    if (!this.#mcpConfig) throw new HostError("mcp_config_unavailable", "MCP config bridge is unavailable");
    return this.#mcpConfig;
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
    const parent = target.parentId === null ? undefined : manager.getEntry(target.parentId);
    const parentBeforeAssociatedInstructions =
      target.type === "message" && target.message.role === "user"
      && parent?.type === "custom_message"
      && parent.customType === PIARIUM_INSTRUCTIONS_MESSAGE_TYPE
      && parent.display === false
        ? parent.parentId
        : target.parentId;
    const newLeafId =
      target.type === "message" && target.message.role === "user"
        ? parentBeforeAssociatedInstructions
        : target.type === "custom_message"
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
