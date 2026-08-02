import { resolve } from "node:path";
import {
  discoverPiRuntimes,
  type RuntimeCandidate,
  type RuntimeDiscoveryOptions,
} from "@piarium/pi-host/discovery";
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
} from "@piarium/protocol";
import { PiHostClient, type PiHostExit } from "./host-client.js";

export interface ProjectTrustDecision {
  remember: boolean;
  trusted: boolean;
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
  discovery?: RuntimeDiscoveryOptions;
  emit?(event: PiRuntimeBrokerEvent): void;
  environment?: NodeJS.ProcessEnv;
  execArgv?: string[];
  hostEntry: string;
  nodePath?: string;
  projectTrustOverride?: boolean;
  promptForProjectTrust?(request: ProjectTrustRequest): Promise<ProjectTrustDecision>;
}

export type PiCatalogMethod =
  | "model.list"
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
  | "session.list"
  | "settings.get"
  | "settings.update";

export class PiRuntimeBroker {
  readonly #clients = new Set<PiHostClient>();
  readonly #listeners = new Set<(event: PiRuntimeBrokerEvent) => void>();
  readonly #options: PiRuntimeBrokerOptions;
  readonly #sessions = new Map<string, PiHostClient>();
  #catalog: PiHostClient | undefined;
  #catalogContextCwd: string | undefined;
  #catalogContextQueue: Promise<void> = Promise.resolve();
  #catalogContextSessionId: string | undefined;
  #catalogPromise: Promise<PiHostClient> | undefined;
  #disposed = false;

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

  discoverRuntimes(): Promise<RuntimeCandidate[]> {
    return discoverPiRuntimes(this.#options.discovery);
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

  async listSessions(cwd?: string) {
    return this.requestCatalog("session.list", cwd === undefined ? {} : { cwd });
  }

  async createSession(cwd: string, name?: string): Promise<SessionSnapshot> {
    const worker = await this.#spawnWorker();
    try {
      const snapshot = await worker.request("session.create", {
        cwd,
        ...(name === undefined ? {} : { name }),
      });
      this.#bindSession(worker, snapshot.sessionId);
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
      const snapshot = await worker.request("session.open", input);
      this.#bindSession(worker, snapshot.sessionId);
      return snapshot;
    } catch (error) {
      await this.#removeWorker(worker);
      throw error;
    }
  }

  async closeSession(sessionId: string): Promise<{ closed: boolean }> {
    const worker = this.#workerForSession(sessionId);
    const result = await worker.request("session.close", { sessionId });
    await this.#removeWorker(worker);
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
    const result = await worker.request("session.fork", {
      entryId,
      ...(position === undefined ? {} : { position }),
      sessionId,
    });
    this.#bindSession(worker, result.snapshot.sessionId);
    if (result.snapshot.sessionId !== sessionId) this.#sessions.delete(sessionId);
    return result;
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

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const clients = [...this.#clients];
    this.#clients.clear();
    this.#sessions.clear();
    this.#catalog = undefined;
    this.#catalogContextCwd = undefined;
    this.#catalogContextSessionId = undefined;
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
        this.#emit({
          envelope,
          kind: "host",
          role,
          ...(client.sessionId === undefined ? {} : { sessionId: client.sessionId }),
          workerId: client.id,
        });
        if (envelope.event === "project.trust.request") {
          void this.#resolveProjectTrust(client, role, envelope.data);
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
      if (this.#options.promptForProjectTrust) {
        decision = await this.#options.promptForProjectTrust(request);
      }
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
      await client.request("project.trust.respond", {
        ...decision,
        requestId: request.id,
      });
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
}
