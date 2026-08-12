import { lstat, realpath, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  EventEnvelope,
  ExtensionUiResponse,
  HostHandshakeParams,
  HostHandshakeResult,
  HostMethod,
  HostMethodParams,
  HostMethodResult,
  ProviderAuthResponse,
  ProjectTrustRequest,
  SessionSnapshot,
  SessionSummary,
} from "@piarium/protocol";
import { PiHostClient, type PiHostExit } from "./host-client.js";
import { PiRuntimeBrokerError } from "./errors.js";
import { SessionMetadataStore } from "./session-metadata-store.js";

export interface ProjectTrustDecision {
  remember: boolean;
  trusted: boolean;
}

interface PendingProjectTrust {
  client: PiHostClient;
}

export type PiRuntimeBrokerEvent =
  | {
      kind: "diagnostic";
      level: "error" | "info";
      message: string;
      role: "catalog" | "session";
      workerId: string;
    }
  | {
      envelope: EventEnvelope;
      kind: "host";
      role: "catalog" | "session";
      sessionId?: string;
      workerId: string;
    }
  | {
      code: number | null;
      expected: boolean;
      kind: "worker.exit";
      role: "catalog" | "session";
      sessionId?: string;
      signal: NodeJS.Signals | null;
      workerId: string;
    };

export interface PiRuntimeBrokerOptions {
  agentDir?: string;
  client: Omit<HostHandshakeParams, "protocolVersions">;
  cwd?: string;
  emit?(event: PiRuntimeBrokerEvent): void;
  environment?: NodeJS.ProcessEnv;
  execArgv?: string[];
  hostEntry: string;
  nodePath?: string;
  projectTrustOverride?: boolean;
  promptForProjectTrust?(request: ProjectTrustRequest): Promise<ProjectTrustDecision>;
}

export type PiCatalogMethod =
  | "agentProvider.action"
  | "agentProvider.list"
  | "config.document.get"
  | "config.document.update"
  | "config.text.get"
  | "config.text.update"
  | "model.list"
  | "mcp.config.snapshot"
  | "package.install"
  | "package.list"
  | "package.remove"
  | "package.update"
  | "provider.list"
  | "provider.config.delete"
  | "provider.config.get"
  | "provider.config.upsert"
  | "provider.models.discover"
  | "provider.login"
  | "provider.logout"
  | "resource.copy"
  | "resource.create"
  | "resource.delete"
  | "resource.get"
  | "resource.list"
  | "resource.update"
  | "session.rename"
  | "session.list"
  | "settings.get"
  | "settings.update";

export class PiRuntimeBroker {
  readonly #clients = new Set<PiHostClient>();
  readonly #listeners = new Set<(event: PiRuntimeBrokerEvent) => void>();
  readonly #options: PiRuntimeBrokerOptions;
  readonly #sessions = new Map<string, PiHostClient>();
  readonly #knownSummaries = new Map<string, SessionSummary>();
  readonly #pendingProjectTrust = new Map<string, PendingProjectTrust>();
  #catalog: PiHostClient | undefined;
  #catalogContextCwd: string | undefined;
  #catalogContextQueue: Promise<void> = Promise.resolve();
  #catalogContextSessionId: string | undefined;
  #catalogPromise: Promise<PiHostClient> | undefined;
  #disposed = false;
  #metadata: SessionMetadataStore | undefined;

  constructor(options: PiRuntimeBrokerOptions) {
    this.#options = options;
    if (options.emit) this.#listeners.add(options.emit);
  }

  get activeSessionIds(): string[] {
    return [...this.#sessions.keys()];
  }

  get catalogStarted(): boolean {
    return this.#catalog !== undefined;
  }

  get workerCount(): number {
    return this.#clients.size;
  }

  subscribe(listener: (event: PiRuntimeBrokerEvent) => void): () => void {
    if (this.#disposed) throw new Error("Pi runtime broker is disposed");
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async warmup(): Promise<HostHandshakeResult> {
    const worker = await this.#getCatalog();
    return worker.handshake;
  }

  async requestCatalog<M extends PiCatalogMethod>(
    method: M,
    params: HostMethodParams<M>,
  ): Promise<HostMethodResult<M>> {
    const worker = await this.#getCatalog();
    return worker.request(method, params);
  }

  requestForWorkspace<M extends Exclude<PiCatalogMethod, "session.list">>(
    cwd: string,
    method: M,
    params: HostMethodParams<M>,
  ): Promise<HostMethodResult<M>> {
    const normalizedCwd = resolve(cwd);
    const request = this.#catalogContextQueue.then(async () => {
      const worker = await this.#getCatalog();
      if (this.#catalogContextCwd !== normalizedCwd) {
        const snapshot = await worker.request("catalog.context.open", { cwd: normalizedCwd });
        this.#catalogContextCwd = snapshot.cwd;
        this.#catalogContextSessionId = snapshot.sessionId;
      }
      return worker.request(method, params);
    });
    this.#catalogContextQueue = request.then(
      () => undefined,
      () => undefined,
    );
    return request;
  }

  listCommandsForWorkspace(cwd: string): Promise<HostMethodResult<"command.list">> {
    const normalizedCwd = resolve(cwd);
    const request = this.#catalogContextQueue.then(async () => {
      const worker = await this.#getCatalog();
      if (this.#catalogContextCwd !== normalizedCwd) {
        const snapshot = await worker.request("catalog.context.open", { cwd: normalizedCwd });
        this.#catalogContextCwd = snapshot.cwd;
        this.#catalogContextSessionId = snapshot.sessionId;
      }
      const sessionId = this.#catalogContextSessionId;
      if (!sessionId) throw new PiRuntimeBrokerError("catalog_context_missing", "Pi catalog context is unavailable");
      return worker.request("command.list", { sessionId });
    });
    this.#catalogContextQueue = request.then(
      () => undefined,
      () => undefined,
    );
    return request;
  }

  async listSessions(cwd?: string): Promise<SessionSummary[]> {
    const worker = await this.#getCatalog();
    const catalogSummaries = await worker.request(
      "session.list",
      cwd === undefined ? {} : { cwd },
    );
    for (const summary of catalogSummaries) this.#knownSummaries.set(summary.id, summary);
    const catalogIds = new Set(catalogSummaries.map((summary) => summary.id));
    const cwdKey = cwd === undefined ? undefined : this.#pathKey(cwd);
    for (const [sessionId, summary] of this.#knownSummaries) {
      if (this.#sessions.has(sessionId) || !summary.persisted) continue;
      if (cwdKey !== undefined && this.#pathKey(summary.cwd) !== cwdKey) continue;
      if (!catalogIds.has(sessionId)) this.#knownSummaries.delete(sessionId);
    }
    const activeSummaries = await Promise.allSettled(
      [...this.#sessions].map(([sessionId, sessionWorker]) =>
        sessionWorker.request("session.summary", { sessionId }),
      ),
    );
    for (const result of activeSummaries) {
      if (result.status === "fulfilled") this.#knownSummaries.set(result.value.id, result.value);
    }
    const merged = [...this.#knownSummaries.values()]
      .filter((summary) => cwdKey === undefined || this.#pathKey(summary.cwd) === cwdKey)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const idsByPath = new Map(merged.map((summary) => [this.#pathKey(summary.sessionFile), summary.id]));
    const linked = merged.map((summary): SessionSummary => {
      if (!summary.parentSessionPath) return summary;
      const parentId = idsByPath.get(this.#pathKey(summary.parentSessionPath));
      const linkedSummary = { ...summary };
      if (parentId === undefined) delete linkedSummary.parentId;
      else linkedSummary.parentId = parentId;
      return linkedSummary;
    });
    return (await this.#metadataFor(worker)).enrich(linked);
  }

  async createSession(cwd: string, name?: string, parentSession?: string): Promise<SessionSnapshot> {
    const worker = await this.#spawnWorker();
    try {
      const snapshot = await worker.request("session.create", {
        cwd,
        ...(name === undefined ? {} : { name }),
        ...(parentSession === undefined ? {} : { parentSession }),
      });
      this.#bindSession(worker, snapshot.sessionId);
      await this.#rememberSummary(worker, snapshot.sessionId);
      return snapshot;
    } catch (error) {
      await this.#removeWorker(worker);
      throw error;
    }
  }

  async openSession(input: {
    cwd?: string;
    sessionFile?: string;
    sessionId?: string;
  }): Promise<SessionSnapshot> {
    if (input.sessionId) {
      const existing = this.#sessions.get(input.sessionId);
      if (existing) return existing.request("session.snapshot", { sessionId: input.sessionId });
    }
    const worker = await this.#spawnWorker();
    try {
      const known = input.sessionId ? this.#knownSummaries.get(input.sessionId) : undefined;
      const openInput =
        input.sessionFile === undefined && known !== undefined
          ? { ...input, sessionFile: known.sessionFile }
          : input;
      const snapshot = await worker.request("session.open", openInput);
      this.#bindSession(worker, snapshot.sessionId);
      await this.#rememberSummary(worker, snapshot.sessionId);
      return snapshot;
    } catch (error) {
      await this.#removeWorker(worker);
      throw error;
    }
  }

  async closeSession(sessionId: string): Promise<{ closed: boolean }> {
    const worker = this.#workerForSession(sessionId);
    const summary = await this.#rememberSummary(worker, sessionId);
    const result = await worker.request("session.close", { sessionId });
    await this.#removeWorker(worker);
    if (!summary.persisted) this.#knownSummaries.delete(sessionId);
    return result;
  }

  requestForSession<M extends HostMethod>(
    sessionId: string,
    method: M,
    params: HostMethodParams<M>,
  ): Promise<HostMethodResult<M>> {
    return this.#workerForSession(sessionId).request(method, params);
  }

  async forkSession(sessionId: string, entryId: string, position?: "before" | "at") {
    const worker = this.#workerForSession(sessionId);
    await this.#rememberSummary(worker, sessionId);
    const result = await worker.request("session.fork", {
      entryId,
      ...(position === undefined ? {} : { position }),
      sessionId,
    });
    this.#bindSession(worker, result.snapshot.sessionId);
    if (result.snapshot.sessionId !== sessionId) this.#sessions.delete(sessionId);
    await this.#rememberSummary(worker, result.snapshot.sessionId);
    return result;
  }

  async renameSession(sessionId: string, name: string): Promise<{ name?: string; sessionId: string }> {
    const worker = this.#sessions.get(sessionId);
    if (worker) {
      const result = await worker.request("session.rename", { name, sessionId });
      await this.#rememberSummary(worker, sessionId);
      return result;
    }
    const summary = (await this.listSessions()).find((entry) => entry.id === sessionId);
    if (!summary) {
      throw new PiRuntimeBrokerError("session_not_found", `Unknown Pi session: ${sessionId}`);
    }
    const result = await this.requestCatalog("session.rename", {
      name,
      sessionFile: summary.sessionFile,
      sessionId,
    });
    const updated = { ...summary, updatedAt: new Date().toISOString() };
    if (result.name === undefined) delete updated.name;
    else updated.name = result.name;
    this.#knownSummaries.set(sessionId, updated);
    return result;
  }

  async archiveSession(sessionId: string, archived: boolean): Promise<SessionSummary> {
    const summaries = await this.listSessions();
    const summary = summaries.find((entry) => entry.id === sessionId);
    if (!summary) {
      throw new PiRuntimeBrokerError("session_not_found", `Unknown Pi session: ${sessionId}`);
    }
    const archivedAt = await (await this.#metadataFor()).setArchived(sessionId, archived);
    const updated = { ...summary };
    if (archivedAt !== undefined) updated.archivedAt = archivedAt;
    else delete updated.archivedAt;
    this.#knownSummaries.set(sessionId, updated);
    return updated;
  }

  async deleteSession(sessionId: string): Promise<{ deleted: boolean; sessionId: string }> {
    const summaries = await this.listSessions();
    const summary = summaries.find((entry) => entry.id === sessionId);
    if (!summary) return { deleted: false, sessionId };
    if (this.#sessions.has(sessionId)) await this.closeSession(sessionId);
    await this.#deleteSessionFile(summary.sessionFile);
    await (await this.#metadataFor()).remove(sessionId);
    this.#knownSummaries.delete(sessionId);
    return { deleted: true, sessionId };
  }

  async respondToExtensionUi(
    sessionId: string,
    response: ExtensionUiResponse,
  ): Promise<boolean> {
    const result = await this.#workerForInteractiveContext(sessionId).request(
      "extension.ui.respond",
      response,
    );
    return result.accepted;
  }

  async respondToProviderAuth(
    sessionId: string,
    response: ProviderAuthResponse,
  ): Promise<boolean> {
    const result = await this.#workerForInteractiveContext(sessionId).request(
      "provider.auth.respond",
      response,
    );
    return result.accepted;
  }

  async respondToProjectTrust(
    workerId: string,
    requestId: string,
    decision: ProjectTrustDecision,
  ): Promise<boolean> {
    const pending = this.#pendingProjectTrust.get(requestId);
    if (!pending || pending.client.id !== workerId) return false;
    const result = await pending.client.request("project.trust.respond", {
      ...decision,
      requestId,
    });
    this.#pendingProjectTrust.delete(requestId);
    return result.accepted;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const clients = [...this.#clients];
    this.#clients.clear();
    this.#sessions.clear();
    this.#knownSummaries.clear();
    this.#pendingProjectTrust.clear();
    this.#catalog = undefined;
    this.#catalogContextCwd = undefined;
    this.#catalogContextSessionId = undefined;
    this.#metadata = undefined;
    await Promise.allSettled(clients.map((client) => client.dispose()));
    this.#listeners.clear();
  }

  async #getCatalog(): Promise<PiHostClient> {
    if (this.#disposed) throw new Error("Pi runtime broker is disposed");
    if (this.#catalog) return this.#catalog;
    this.#catalogPromise ??= (async () => {
      const client = this.#createClient("catalog");
      this.#clients.add(client);
      try {
        await client.start();
        if (this.#disposed) {
          await client.dispose();
          throw new Error("Pi runtime broker was disposed during startup");
        }
        this.#catalog = client;
        return client;
      } catch (error) {
        this.#clients.delete(client);
        await client.dispose();
        throw error;
      }
    })();
    try {
      return await this.#catalogPromise;
    } finally {
      this.#catalogPromise = undefined;
    }
  }

  async #metadataFor(worker?: PiHostClient): Promise<SessionMetadataStore> {
    if (this.#metadata) return this.#metadata;
    const catalog = worker ?? (await this.#getCatalog());
    this.#metadata = new SessionMetadataStore(catalog.handshake.runtime.agentDir);
    return this.#metadata;
  }

  async #rememberSummary(worker: PiHostClient, sessionId: string): Promise<SessionSummary> {
    const summary = await worker.request("session.summary", { sessionId });
    this.#knownSummaries.set(summary.id, summary);
    return summary;
  }

  #pathKey(path: string): string {
    const normalized = resolve(path);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }

  async #deleteSessionFile(sessionFile: string): Promise<void> {
    const metadata = await this.#metadataFor();
    const rootPath = resolve(metadata.agentDir, "sessions");
    const candidate = resolve(sessionFile);
    const relativePath = relative(rootPath, candidate);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      throw new PiRuntimeBrokerError(
        "session_path_denied",
        `Refusing to delete a session outside the Pi session root: ${candidate}`,
      );
    }
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new PiRuntimeBrokerError(
        "session_path_denied",
        `Refusing to delete a non-regular Pi session file: ${candidate}`,
      );
    }
    const root = await realpath(rootPath);
    const resolvedCandidate = await realpath(candidate);
    const resolvedRelativePath = relative(root, resolvedCandidate);
    if (
      resolvedRelativePath === ".." ||
      resolvedRelativePath.startsWith(`..${sep}`) ||
      isAbsolute(resolvedRelativePath)
    ) {
      throw new PiRuntimeBrokerError(
        "session_path_denied",
        `Refusing to delete a session outside the Pi session root: ${resolvedCandidate}`,
      );
    }
    await rm(resolvedCandidate);
  }

  async #spawnWorker(): Promise<PiHostClient> {
    if (this.#disposed) throw new Error("Pi runtime broker is disposed");
    const worker = this.#createClient("session");
    this.#clients.add(worker);
    try {
      await worker.start();
      return worker;
    } catch (error) {
      await this.#removeWorker(worker);
      throw error;
    }
  }

  #createClient(role: "catalog" | "session"): PiHostClient {
    const client = new PiHostClient({
      ...(this.#options.agentDir === undefined ? {} : { agentDir: this.#options.agentDir }),
      ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
      ...(this.#options.environment === undefined
        ? {}
        : { environment: this.#options.environment }),
      ...(this.#options.execArgv === undefined ? {} : { execArgv: this.#options.execArgv }),
      handshake: this.#options.client,
      hostEntry: this.#options.hostEntry,
      ...(this.#options.nodePath === undefined ? {} : { nodePath: this.#options.nodePath }),
      onDiagnostic: (level, message) => {
        this.#emit({ kind: "diagnostic", level, message, role, workerId: client.id });
      },
      onEvent: (envelope) => {
        if (role === "session" && envelope.event === "session.snapshot") {
          this.#bindSession(client, envelope.data.sessionId);
        }
        if (envelope.event === "project.trust.request") {
          this.#pendingProjectTrust.set(envelope.data.id, { client });
        }
        this.#emit({
          envelope,
          kind: "host",
          role,
          ...(client.sessionId === undefined ? {} : { sessionId: client.sessionId }),
          workerId: client.id,
        });
        if (envelope.event === "project.trust.request") {
          if (this.#options.promptForProjectTrust) {
            void this.#resolveProjectTrust(client, role, envelope.data);
          }
        }
      },
      onExit: (exit) => this.#handleExit(client, role, exit),
      ...(this.#options.projectTrustOverride === undefined
        ? {}
        : { projectTrustOverride: this.#options.projectTrustOverride }),
    });
    return client;
  }

  async #resolveProjectTrust(
    client: PiHostClient,
    role: "catalog" | "session",
    request: ProjectTrustRequest,
  ): Promise<void> {
    let decision: ProjectTrustDecision = { remember: false, trusted: false };
    try {
      decision = await this.#options.promptForProjectTrust!(request);
    } catch (error) {
      this.#emit({
        kind: "diagnostic",
        level: "error",
        message: `Project trust prompt failed: ${error instanceof Error ? error.message : String(error)}`,
        role,
        workerId: client.id,
      });
    }
    try {
      await this.respondToProjectTrust(client.id, request.id, decision);
    } catch (error) {
      this.#emit({
        kind: "diagnostic",
        level: "error",
        message: `Project trust response failed: ${error instanceof Error ? error.message : String(error)}`,
        role,
        workerId: client.id,
      });
    }
  }

  #bindSession(client: PiHostClient, sessionId: string): void {
    for (const [mappedSessionId, worker] of this.#sessions) {
      if (worker === client && mappedSessionId !== sessionId) {
        this.#sessions.delete(mappedSessionId);
      }
    }
    this.#sessions.set(sessionId, client);
  }

  #workerForSession(sessionId: string): PiHostClient {
    const worker = this.#sessions.get(sessionId);
    if (!worker) throw new Error(`Session is not active: ${sessionId}`);
    return worker;
  }

  #workerForInteractiveContext(sessionId: string): PiHostClient {
    const worker = this.#sessions.get(sessionId);
    if (worker) return worker;
    if (this.#catalog && this.#catalogContextSessionId === sessionId) return this.#catalog;
    throw new Error(`Session or workspace context is not active: ${sessionId}`);
  }

  async #removeWorker(worker: PiHostClient): Promise<void> {
    this.#clients.delete(worker);
    if (this.#catalog === worker) {
      this.#catalog = undefined;
      this.#catalogContextCwd = undefined;
      this.#catalogContextSessionId = undefined;
    }
    for (const [sessionId, candidate] of this.#sessions) {
      if (candidate === worker) this.#sessions.delete(sessionId);
    }
    this.#clearProjectTrustForClient(worker);
    await worker.dispose();
  }

  #handleExit(
    client: PiHostClient,
    role: "catalog" | "session",
    exit: PiHostExit,
  ): void {
    const sessionId = client.sessionId;
    const expected = this.#disposed || client.disposing;
    if (client === this.#catalog) {
      this.#catalog = undefined;
      this.#catalogContextCwd = undefined;
      this.#catalogContextSessionId = undefined;
    }
    this.#clients.delete(client);
    for (const [mappedSessionId, worker] of this.#sessions) {
      if (worker === client) this.#sessions.delete(mappedSessionId);
    }
    this.#clearProjectTrustForClient(client);
    this.#emit({
      code: exit.code,
      expected,
      kind: "worker.exit",
      role,
      ...(sessionId === undefined ? {} : { sessionId }),
      signal: exit.signal,
      workerId: client.id,
    });
  }

  #emit(event: PiRuntimeBrokerEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Surface callbacks are observational and must not break worker ownership.
      }
    }
  }

  #clearProjectTrustForClient(client: PiHostClient): void {
    for (const [requestId, pending] of this.#pendingProjectTrust) {
      if (pending.client === client) this.#pendingProjectTrust.delete(requestId);
    }
  }
}
