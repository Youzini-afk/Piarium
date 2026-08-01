import { EventEmitter } from "node:events";
import { discoverPiRuntimes, type RuntimeCandidate } from "@piarium/pi-host/discovery";
import type {
  ExtensionUiResponse,
  HostMethod,
  HostMethodParams,
  HostMethodResult,
  ProjectTrustRequest,
  SessionSnapshot,
} from "@piarium/protocol";
import type { DesktopEvent } from "../shared/desktop-api.js";
import { HostClient, type HostExit } from "./host-client.js";

export interface ProjectTrustDecision {
  remember: boolean;
  trusted: boolean;
}

export interface RuntimeBrokerOptions {
  agentDir?: string;
  emit(event: DesktopEvent): void;
  hostEntry: string;
  promptForProjectTrust(request: ProjectTrustRequest): Promise<ProjectTrustDecision>;
}

export class RuntimeBroker extends EventEmitter {
  readonly #options: RuntimeBrokerOptions;
  readonly #sessions = new Map<string, HostClient>();
  readonly #workers = new Set<HostClient>();
  #catalog: HostClient | undefined;
  #catalogPromise: Promise<HostClient> | undefined;
  #disposed = false;

  constructor(options: RuntimeBrokerOptions) {
    super();
    this.#options = options;
  }

  discoverRuntimes(): Promise<RuntimeCandidate[]> {
    return discoverPiRuntimes();
  }

  async listSessions(cwd?: string) {
    const worker = await this.#getCatalog();
    return worker.request("session.list", cwd === undefined ? {} : { cwd });
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

  async requestForSession<M extends HostMethod>(
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

  respondToExtensionUi(sessionId: string, response: ExtensionUiResponse): Promise<boolean> {
    return this.#workerForSession(sessionId)
      .request("extension.ui.respond", response)
      .then((result) => result.accepted);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const workers = [...this.#workers];
    if (this.#catalog) workers.push(this.#catalog);
    this.#workers.clear();
    this.#sessions.clear();
    this.#catalog = undefined;
    await Promise.allSettled(workers.map((worker) => worker.dispose()));
  }

  async #getCatalog(): Promise<HostClient> {
    if (this.#disposed) throw new Error("Runtime broker is disposed");
    if (this.#catalog) return this.#catalog;
    this.#catalogPromise ??= (async () => {
      const client = this.#createClient();
      try {
        await client.start();
        this.#catalog = client;
        return client;
      } catch (error) {
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

  async #spawnWorker(): Promise<HostClient> {
    if (this.#disposed) throw new Error("Runtime broker is disposed");
    const worker = this.#createClient();
    this.#workers.add(worker);
    await worker.start();
    return worker;
  }

  #createClient(): HostClient {
    let client: HostClient;
    client = new HostClient({
      ...(this.#options.agentDir === undefined ? {} : { agentDir: this.#options.agentDir }),
      hostEntry: this.#options.hostEntry,
      onDiagnostic: (level, message) => this.emit("diagnostic", { level, message }),
      onEvent: (envelope) => {
        if (envelope.event === "project.trust.request") {
          void this.#resolveProjectTrust(client, envelope.data).catch((error) => {
            this.emit("diagnostic", {
              level: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          });
          return;
        }
        if (envelope.event === "session.snapshot") {
          this.#bindSession(client, envelope.data.sessionId);
        }
        this.#options.emit({
          envelope,
          kind: "host",
          ...(client.sessionId === undefined ? {} : { sessionId: client.sessionId }),
          workerId: client.id,
        });
      },
      onExit: (exit) => this.#handleExit(client, exit),
    });
    return client;
  }

  async #resolveProjectTrust(client: HostClient, request: ProjectTrustRequest): Promise<void> {
    let decision: ProjectTrustDecision = { remember: false, trusted: false };
    try {
      decision = await this.#options.promptForProjectTrust(request);
    } finally {
      await client.request("project.trust.respond", {
        ...decision,
        requestId: request.id,
      });
    }
  }

  #bindSession(client: HostClient, sessionId: string): void {
    for (const [mappedSessionId, worker] of this.#sessions) {
      if (worker === client && mappedSessionId !== sessionId)
        this.#sessions.delete(mappedSessionId);
    }
    this.#sessions.set(sessionId, client);
  }

  #workerForSession(sessionId: string): HostClient {
    const worker = this.#sessions.get(sessionId);
    if (!worker) throw new Error(`Session is not active: ${sessionId}`);
    return worker;
  }

  async #removeWorker(worker: HostClient): Promise<void> {
    this.#workers.delete(worker);
    for (const [sessionId, candidate] of this.#sessions) {
      if (candidate === worker) this.#sessions.delete(sessionId);
    }
    await worker.dispose();
  }

  #handleExit(client: HostClient, exit: HostExit): void {
    const sessionId = client.sessionId;
    if (client === this.#catalog) this.#catalog = undefined;
    this.#workers.delete(client);
    for (const [mappedSessionId, worker] of this.#sessions) {
      if (worker === client) this.#sessions.delete(mappedSessionId);
    }
    this.#options.emit({
      code: exit.code,
      kind: "worker.exit",
      ...(sessionId === undefined ? {} : { sessionId }),
      signal: exit.signal,
      workerId: client.id,
    });
  }
}
