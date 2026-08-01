import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultPackageManager,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  HostEvent,
  HostEventData,
  ImageAttachment,
  JsonValue,
  ModelDescriptor,
  PackageDescriptor,
  ProviderAuthType,
  ProviderDescriptor,
  SessionSnapshot,
  SessionSummary,
} from "@piarium/protocol";
import { HostError } from "./errors.js";
import { ExtensionUiBridge } from "./extension-ui-bridge.js";
import { toJsonValue } from "./json.js";
import { ProjectTrustController } from "./project-trust-controller.js";

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
  emit: EventEmitter;
  projectTrustOverride?: boolean;
  runtimeFactory?: CreateAgentSessionRuntimeFactory;
}

function getSessionDir(cwd: string, agentDir: string): string {
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(agentDir), "sessions", safePath);
}

function toModelDescriptor(model: AgentSession["model"]): ModelDescriptor | undefined {
  if (!model) return undefined;
  return {
    contextWindow: model.contextWindow,
    id: model.id,
    name: model.name,
    provider: model.provider,
    supportsImages: model.input.includes("image"),
    supportsThinking: model.reasoning,
  };
}

function toImages(images: ImageAttachment[]): NonNullable<Parameters<AgentSession["steer"]>[1]> {
  return images.map((image) => ({ data: image.data, mimeType: image.mimeType, type: "image" }));
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
  readonly #emit: EventEmitter;
  readonly #projectTrustOverride: boolean | undefined;
  readonly #runtimeFactory: CreateAgentSessionRuntimeFactory | undefined;
  readonly #trustStore: ProjectTrustStore;
  readonly trust: ProjectTrustController;
  readonly ui: ExtensionUiBridge;
  #runtime: AgentSessionRuntime | undefined;
  #unsubscribe: (() => void) | undefined;
  #disposed = false;

  constructor(options: SessionHostOptions) {
    this.#agentDir = resolve(options.agentDir);
    this.#emit = options.emit;
    this.#projectTrustOverride = options.projectTrustOverride;
    this.#runtimeFactory = options.runtimeFactory;
    this.#trustStore = new ProjectTrustStore(this.#agentDir);
    this.trust = new ProjectTrustController(options.emit);
    this.ui = new ExtensionUiBridge(options.emit, () => this.sessionId ?? "host");
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
    return infos.map((info) => ({
      createdAt: info.created.toISOString(),
      cwd: info.cwd,
      id: info.id,
      ...(info.name === undefined ? {} : { name: info.name }),
      sessionFile: info.path,
      updatedAt: info.modified.toISOString(),
    }));
  }

  snapshot(): SessionSnapshot {
    const session = this.session;
    const model = toModelDescriptor(session.model);
    return {
      activeTools: session.getActiveToolNames(),
      busy: !session.isIdle,
      cwd: this.runtime.cwd,
      ...(model === undefined ? {} : { model }),
      sessionId: session.sessionId,
      thinkingLevel: session.thinkingLevel,
    };
  }

  entries(sessionId: string, branchOnly: boolean): JsonValue {
    this.assertSession(sessionId);
    const entries = branchOnly
      ? this.session.sessionManager.getBranch()
      : this.session.sessionManager.getEntries();
    return toJsonValue(entries);
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

  listModels(): ModelDescriptor[] {
    return this.runtime.services.modelRuntime
      .getModels()
      .map((model) => toModelDescriptor(model))
      .filter((model): model is ModelDescriptor => model !== undefined);
  }

  async selectModel(
    sessionId: string,
    provider: string,
    modelId: string,
  ): Promise<SessionSnapshot> {
    this.assertSession(sessionId);
    const model = this.runtime.services.modelRuntime.getModel(provider, modelId);
    if (!model) throw new HostError("model_not_found", `Unknown model: ${provider}/${modelId}`);
    await this.session.setModel(model);
    return this.snapshot();
  }

  listProviders(): ProviderDescriptor[] {
    const runtime = this.runtime.services.modelRuntime;
    return runtime.getProviders().map((provider) => {
      const status = runtime.getProviderAuthStatus(provider.id);
      const authTypes: ProviderAuthType[] = [];
      if (provider.auth.apiKey) authTypes.push("api_key");
      if (provider.auth.oauth) authTypes.push("oauth");
      return {
        authTypes,
        configured: status.configured,
        id: provider.id,
        name: provider.name,
        ...(status.configured && "source" in status && status.source
          ? { source: status.source }
          : {}),
      };
    });
  }

  async loginProvider(providerId: string, type: ProviderAuthType): Promise<boolean> {
    const modelRuntime = this.runtime.services.modelRuntime;
    type LoginInteraction = Parameters<typeof modelRuntime.login>[2];
    const interaction: LoginInteraction = {
      prompt: async (prompt) => {
        const options = prompt.signal ? { signal: prompt.signal } : undefined;
        const payload =
          prompt.type === "select"
            ? {
                message: prompt.message,
                options: prompt.options.map((option) => ({
                  ...(option.description === undefined ? {} : { description: option.description }),
                  id: option.id,
                  label: option.label,
                })),
              }
            : {
                message: prompt.message,
                placeholder: prompt.placeholder ?? null,
                secret: prompt.type === "secret",
              };
        const value = await this.ui.request(
          prompt.type === "select" ? "select" : "input",
          toJsonValue(payload),
          options,
        );
        if (typeof value !== "string")
          throw new HostError("auth_cancelled", "Authentication was cancelled");
        return value;
      },
      notify: (event) => {
        this.#emit("provider.auth.event", { event: toJsonValue(event), providerId });
      },
    };
    await modelRuntime.login(providerId, type, interaction);
    return true;
  }

  async logoutProvider(providerId: string): Promise<void> {
    await this.runtime.services.modelRuntime.logout(providerId);
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
      const services = await createAgentSessionServices({
        agentDir,
        cwd,
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
      const created = await createAgentSessionFromServices({
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
      this.#emit("agent.event", { event: toJsonValue(event), sessionId: session.sessionId });
      if (
        event.type === "agent_start" ||
        event.type === "agent_end" ||
        event.type === "agent_settled" ||
        event.type === "queue_update"
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
    const runtime = this.#runtime;
    this.#runtime = undefined;
    if (runtime) await runtime.dispose();
  }
}
