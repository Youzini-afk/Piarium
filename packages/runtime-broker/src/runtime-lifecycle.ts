import type {
  ExtensionUiResponse,
  HostHandshakeResult,
  PiRuntimeInstallation,
  PiRuntimeSnapshot,
  ProviderAuthResponse,
  SessionSnapshot,
  SessionSummary,
  SessionWorkspaceBinding,
} from "@piarium/protocol";
import { PiRuntimeNotReadyError } from "./errors.js";
import { resolveBundledPiHostEntry } from "./host-entry.js";
import {
  PiRuntimeBroker,
  type PiRuntimeBrokerEvent,
  type PiRuntimeBrokerOptions,
  type ProjectTrustDecision,
} from "./runtime-broker.js";
import {
  PiRuntimeManager,
  type PiRuntimeManagerOptions,
} from "./runtime-manager.js";

export interface PiRuntimeBrokerFactoryOptions {
  hostEntry: string;
  nodePath?: string;
  packageRoot?: string;
  runtimeGeneration: number;
  runtimeSource?: PiRuntimeInstallation["source"];
}

export interface PiRuntimeLifecycleOptions extends PiRuntimeManagerOptions {
  createBroker: (options: PiRuntimeBrokerFactoryOptions) => PiRuntimeBroker;
}

interface BrokerGeneration {
  broker: PiRuntimeBroker;
  handshake: HostHandshakeResult;
  id: number;
  packageRoot?: string;
  unsubscribe: () => void;
}

export class PiRuntimeLifecycle {
  readonly #brokerListeners = new Set<(event: PiRuntimeBrokerEvent) => void>();
  readonly #createBroker: PiRuntimeLifecycleOptions["createBroker"];
  readonly #generations = new Map<number, BrokerGeneration>();
  readonly #hostEntry: string;
  readonly #manager: PiRuntimeManager;
  readonly #managerUnsubscribe: () => void;
  readonly #sessionGenerations = new Map<string, number>();
  readonly #snapshotListeners = new Set<(snapshot: PiRuntimeSnapshot) => void>();
  readonly #workerGenerations = new Map<string, number>();
  #activationIssue: string | undefined;
  #currentId = 0;
  #handshake: HostHandshakeResult | undefined;
  #nextId = 1;
  #revision = 0;

  constructor(options: PiRuntimeLifecycleOptions) {
    this.#createBroker = options.createBroker;
    this.#hostEntry = options.hostEntry ?? resolveBundledPiHostEntry();
    this.#manager = new PiRuntimeManager({
      dataDir: options.dataDir,
      ...(options.discover === undefined ? {} : { discover: options.discover }),
      ...(options.discovery === undefined ? {} : { discovery: options.discovery }),
      hostEntry: this.#hostEntry,
      ...(options.installer === undefined ? {} : { installer: options.installer }),
      ...(options.planInstall === undefined ? {} : { planInstall: options.planInstall }),
      ...(options.probe === undefined ? {} : { probe: options.probe }),
      ...(options.targetVersion === undefined ? {} : { targetVersion: options.targetVersion }),
    });
    this.#managerUnsubscribe = this.#manager.subscribe((snapshot) => {
      if (snapshot.status !== "ready") this.#activationIssue = undefined;
      this.#publishSnapshot();
    });
  }

  get snapshot(): PiRuntimeSnapshot {
    const snapshot: PiRuntimeSnapshot = {
      ...this.#manager.snapshot,
      revision: this.#revision,
    };
    if (snapshot.status === "ready" && snapshot.active && !this.#currentMatches(snapshot.active)) {
      snapshot.status = this.#activationIssue ? "failed" : "probing";
      if (this.#activationIssue) snapshot.issue = this.#activationIssue;
      else delete snapshot.issue;
    }
    return snapshot;
  }

  get handshake(): HostHandshakeResult | undefined {
    return this.#handshake;
  }

  get currentBroker(): PiRuntimeBroker | undefined {
    return this.#generations.get(this.#currentId)?.broker;
  }

  subscribe(listener: (snapshot: PiRuntimeSnapshot) => void): () => void {
    this.#snapshotListeners.add(listener);
    return () => {
      this.#snapshotListeners.delete(listener);
    };
  }

  subscribeBroker(listener: (event: PiRuntimeBrokerEvent) => void): () => void {
    this.#brokerListeners.add(listener);
    return () => {
      this.#brokerListeners.delete(listener);
    };
  }

  async start(): Promise<HostHandshakeResult | undefined> {
    const snapshot = await this.#manager.refresh();
    if (snapshot.status === "ready" && snapshot.active) {
      return this.#activateInstallation(snapshot.active);
    }
    return undefined;
  }

  async refresh(): Promise<PiRuntimeSnapshot> {
    const snapshot = await this.#manager.refresh();
    if (snapshot.status === "ready" && snapshot.active) {
      await this.#activateInstallation(snapshot.active);
    }
    return this.snapshot;
  }

  async rediscover(): Promise<PiRuntimeSnapshot> {
    return this.refresh();
  }

  async activate(id: string): Promise<PiRuntimeSnapshot> {
    const snapshot = await this.#manager.activate(id);
    if (snapshot.status === "ready" && snapshot.active) {
      await this.#activateInstallation(snapshot.active);
    }
    return this.snapshot;
  }

  async activateCustom(packageRoot: string, nodePath?: string): Promise<PiRuntimeSnapshot> {
    const snapshot = await this.#manager.activateCustom(packageRoot, nodePath);
    if (snapshot.status === "ready" && snapshot.active) {
      await this.#activateInstallation(snapshot.active);
    }
    return this.snapshot;
  }

  async install(): Promise<PiRuntimeSnapshot> {
    await this.#stopGenerationsForUpdate();
    const snapshot = await this.#manager.install();
    if (snapshot.status === "ready" && snapshot.active) {
      await this.#activateInstallation(snapshot.active);
    }
    return this.snapshot;
  }

  async upgrade(): Promise<PiRuntimeSnapshot> {
    await this.#stopGenerationsForUpdate();
    const snapshot = await this.#manager.upgrade();
    if (snapshot.status === "ready" && snapshot.active) {
      await this.#activateInstallation(snapshot.active);
    }
    return this.snapshot;
  }

  requireBroker(): PiRuntimeBroker {
    const broker = this.currentBroker;
    if (!broker) throw new PiRuntimeNotReadyError();
    return broker;
  }

  brokerForSession(sessionId: string): PiRuntimeBroker {
    return this.#findBrokerForSession(sessionId) ?? this.requireBroker();
  }

  async listSessions(cwd?: string): Promise<SessionSummary[]> {
    const generations = [...this.#generations.values()];
    if (generations.length === 0) return this.requireBroker().listSessions(cwd);
    const snapshots = await Promise.all(generations.map(async (generation) => ({
      activeSessionIds: new Set(generation.broker.activeSessionIds),
      summaries: await generation.broker.listSessions(cwd),
    })));
    const merged = new Map<string, { active: boolean; summary: SessionSummary }>();
    for (const snapshot of snapshots) {
      for (const summary of snapshot.summaries) {
        const active = snapshot.activeSessionIds.has(summary.id);
        const existing = merged.get(summary.id);
        if (!existing || active || !existing.active) merged.set(summary.id, { active, summary });
      }
    }
    return [...merged.values()]
      .map((entry) => entry.summary)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async createSession(
    cwd: string,
    name?: string,
    parentSession?: string,
    workspace?: SessionWorkspaceBinding,
  ): Promise<SessionSnapshot> {
    return this.requireBroker().createSession(cwd, name, parentSession, workspace);
  }

  async openSession(input: {
    cwd?: string;
    sessionFile?: string;
    sessionId?: string;
    workspace?: SessionWorkspaceBinding;
  }): Promise<SessionSnapshot> {
    const broker = input.sessionId ? this.#findBrokerForSession(input.sessionId) : undefined;
    return (broker ?? this.requireBroker()).openSession(input);
  }

  closeSession(sessionId: string): Promise<{ closed: boolean }> {
    return this.brokerForSession(sessionId).closeSession(sessionId);
  }

  forkSession(sessionId: string, entryId: string, position?: "before" | "at") {
    return this.brokerForSession(sessionId).forkSession(sessionId, entryId, position);
  }

  renameSession(sessionId: string, name: string): Promise<{ name?: string; sessionId: string }> {
    return this.brokerForSession(sessionId).renameSession(sessionId, name);
  }

  archiveSession(sessionId: string, archived: boolean): Promise<SessionSummary> {
    return this.brokerForSession(sessionId).archiveSession(sessionId, archived);
  }

  deleteSession(sessionId: string): Promise<{ deleted: boolean; sessionId: string }> {
    return this.brokerForSession(sessionId).deleteSession(sessionId);
  }

  respondToExtensionUi(sessionId: string, response: ExtensionUiResponse): Promise<boolean> {
    return this.brokerForSession(sessionId).respondToExtensionUi(sessionId, response);
  }

  respondToProviderAuth(sessionId: string, response: ProviderAuthResponse): Promise<boolean> {
    return this.brokerForSession(sessionId).respondToProviderAuth(sessionId, response);
  }

  respondToProjectTrust(
    workerId: string,
    requestId: string,
    decision: ProjectTrustDecision,
  ): Promise<boolean> {
    const generationId = this.#workerGenerations.get(workerId);
    const broker = generationId === undefined
      ? this.requireBroker()
      : this.#generations.get(generationId)?.broker ?? this.requireBroker();
    return broker.respondToProjectTrust(workerId, requestId, decision);
  }

  async ensureActiveBroker(): Promise<HostHandshakeResult> {
    if (this.#handshake) return this.#handshake;
    const snapshot = this.#manager.snapshot.status === "ready"
      ? this.#manager.snapshot
      : await this.#manager.refresh();
    if (snapshot.status !== "ready" || !snapshot.active) {
      throw new PiRuntimeNotReadyError(snapshot.issue ?? "Pi runtime is not ready");
    }
    return this.#activateInstallation(snapshot.active);
  }

  asBroker(): PiRuntimeBroker {
    return new Proxy(this.currentBroker ?? ({} as PiRuntimeBroker), {
      get: (_target, property) => {
        if (property === "subscribe") {
          return (listener: (event: PiRuntimeBrokerEvent) => void) => this.subscribeBroker(listener);
        }
        if (property === "dispose") {
          return () => this.dispose();
        }
        if (property === "warmup") {
          return () => this.ensureActiveBroker();
        }
        if (property === "requestForSession") {
          return (
            sessionId: string,
            method: Parameters<PiRuntimeBroker["requestForSession"]>[1],
            params: Parameters<PiRuntimeBroker["requestForSession"]>[2],
          ) => this.brokerForSession(sessionId).requestForSession(sessionId, method, params);
        }
        if (property === "listSessions") return this.listSessions.bind(this);
        if (property === "createSession") return this.createSession.bind(this);
        if (property === "openSession") return this.openSession.bind(this);
        if (property === "closeSession") return this.closeSession.bind(this);
        if (property === "forkSession") return this.forkSession.bind(this);
        if (property === "renameSession") return this.renameSession.bind(this);
        if (property === "archiveSession") return this.archiveSession.bind(this);
        if (property === "deleteSession") return this.deleteSession.bind(this);
        if (property === "respondToExtensionUi") return this.respondToExtensionUi.bind(this);
        if (property === "respondToProviderAuth") return this.respondToProviderAuth.bind(this);
        if (property === "respondToProjectTrust") return this.respondToProjectTrust.bind(this);
        if (property === "activeSessionIds") {
          return [...new Set([...this.#generations.values()].flatMap((entry) => entry.broker.activeSessionIds))];
        }
        if (property === "workerCount") {
          return [...this.#generations.values()].reduce((sum, entry) => sum + entry.broker.workerCount, 0);
        }
        if (property === "packageRoot") {
          return this.currentBroker?.packageRoot;
        }
        const broker = this.requireBroker();
        const value = Reflect.get(broker, property);
        return typeof value === "function" ? value.bind(broker) : value;
      },
    });
  }

  async dispose(): Promise<void> {
    this.#managerUnsubscribe();
    const generations = [...this.#generations.values()];
    this.#generations.clear();
    this.#currentId = 0;
    this.#handshake = undefined;
    this.#sessionGenerations.clear();
    this.#workerGenerations.clear();
    await Promise.all(generations.map(async (generation) => {
      generation.unsubscribe();
      await generation.broker.dispose();
    }));
    this.#snapshotListeners.clear();
  }

  async #activateInstallation(installation: PiRuntimeInstallation): Promise<HostHandshakeResult> {
    try {
      return await this.#ensureBroker(installation);
    } catch (error) {
      this.#activationIssue = error instanceof Error ? error.message : String(error);
      this.#publishSnapshot();
      throw error;
    }
  }

  async #ensureBroker(installation: PiRuntimeInstallation): Promise<HostHandshakeResult> {
    const current = this.#generations.get(this.#currentId);
    if (current && this.#generationMatches(current, installation)) {
      this.#handshake = current.handshake;
      this.#activationIssue = undefined;
      return current.handshake;
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const broker = this.#createBroker({
      hostEntry: this.#hostEntry,
      ...(installation.nodePath === undefined ? {} : { nodePath: installation.nodePath }),
      ...(installation.packageRoot === undefined ? {} : { packageRoot: installation.packageRoot }),
      runtimeGeneration: id,
      runtimeSource: installation.source,
    });
    let handshake: HostHandshakeResult;
    try {
      handshake = await broker.warmup();
    } catch (error) {
      await broker.dispose().catch(() => {});
      throw error;
    }
    const unsubscribe = broker.subscribe((event) => {
      this.#workerGenerations.set(event.workerId, id);
      const eventSessionId = "sessionId" in event ? event.sessionId : undefined;
      if (event.role === "session" && eventSessionId) {
        this.#sessionGenerations.set(eventSessionId, id);
      }
      for (const listener of this.#brokerListeners) listener(event);
      if (event.kind === "worker.exit") {
        this.#workerGenerations.delete(event.workerId);
        if (event.role === "session" && eventSessionId) {
          this.#sessionGenerations.delete(eventSessionId);
        }
      }
      if (event.kind === "worker.exit" && event.role === "session") {
        void this.#retireIdleGeneration(id);
      }
    });
    this.#generations.set(id, {
      broker,
      handshake,
      id,
      ...(installation.packageRoot === undefined ? {} : { packageRoot: installation.packageRoot }),
      unsubscribe,
    });
    this.#currentId = id;
    this.#handshake = handshake;
    this.#activationIssue = undefined;
    this.#publishSnapshot();
    return handshake;
  }

  async #stopGenerationsForUpdate(): Promise<void> {
    const target = this.#manager.snapshot.installations.find(
      (entry) => entry.id === "system" || entry.id === "standalone",
    );
    const packageRoot = target?.packageRoot ?? this.currentBroker?.packageRoot;
    const doomed = [...this.#generations.values()].filter((generation) => (
      !packageRoot || generation.packageRoot === packageRoot
    ));
    for (const generation of doomed) {
      generation.unsubscribe();
      await generation.broker.dispose();
      this.#generations.delete(generation.id);
      if (this.#currentId === generation.id) {
        this.#currentId = 0;
        this.#handshake = undefined;
      }
      for (const [workerId, generationId] of this.#workerGenerations) {
        if (generationId === generation.id) this.#workerGenerations.delete(workerId);
      }
      for (const [sessionId, generationId] of this.#sessionGenerations) {
        if (generationId === generation.id) this.#sessionGenerations.delete(sessionId);
      }
    }
    if (doomed.length > 0) this.#publishSnapshot();
  }

  async #retireIdleGeneration(id: number): Promise<void> {
    if (id === this.#currentId) return;
    const generation = this.#generations.get(id);
    if (!generation || generation.broker.activeSessionIds.length > 0) return;
    generation.unsubscribe();
    await generation.broker.dispose();
    this.#generations.delete(id);
    for (const [workerId, generationId] of this.#workerGenerations) {
      if (generationId === id) this.#workerGenerations.delete(workerId);
    }
    for (const [sessionId, generationId] of this.#sessionGenerations) {
      if (generationId === id) this.#sessionGenerations.delete(sessionId);
    }
  }

  #findBrokerForSession(sessionId: string): PiRuntimeBroker | undefined {
    const mappedGenerationId = this.#sessionGenerations.get(sessionId);
    if (mappedGenerationId !== undefined) {
      const mapped = this.#generations.get(mappedGenerationId)?.broker;
      if (mapped) return mapped;
      this.#sessionGenerations.delete(sessionId);
    }
    for (const generation of this.#generations.values()) {
      if (generation.broker.activeSessionIds.includes(sessionId)) {
        this.#sessionGenerations.set(sessionId, generation.id);
        return generation.broker;
      }
    }
    return undefined;
  }

  #currentMatches(installation: PiRuntimeInstallation): boolean {
    const current = this.#generations.get(this.#currentId);
    return current !== undefined && this.#generationMatches(current, installation);
  }

  #generationMatches(
    generation: BrokerGeneration,
    installation: PiRuntimeInstallation,
  ): boolean {
    const runtimeSource = installation.source === "development" ? "source" : installation.source;
    return generation.packageRoot === installation.packageRoot
      && generation.handshake.runtime.nodePath === installation.nodePath
      && generation.handshake.runtime.piVersion === installation.version
      && generation.handshake.runtime.source === runtimeSource;
  }

  #publishSnapshot(): void {
    this.#revision += 1;
    const snapshot = this.snapshot;
    for (const listener of this.#snapshotListeners) listener(snapshot);
  }
}

export type { PiRuntimeBrokerOptions };
