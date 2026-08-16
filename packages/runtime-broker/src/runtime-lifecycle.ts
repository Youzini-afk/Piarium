import type {
  HostHandshakeResult,
  PiRuntimeInstallation,
  PiRuntimeSnapshot,
} from "@piarium/protocol";
import { PiRuntimeNotReadyError } from "./errors.js";
import { resolveBundledPiHostEntry } from "./host-entry.js";
import {
  PiRuntimeBroker,
  type PiRuntimeBrokerEvent,
  type PiRuntimeBrokerOptions,
} from "./runtime-broker.js";
import {
  PiRuntimeManager,
  type PiRuntimeManagerOptions,
} from "./runtime-manager.js";

export interface PiRuntimeBrokerFactoryOptions {
  hostEntry: string;
  nodePath?: string;
  packageRoot?: string;
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
  #currentId = 0;
  #handshake: HostHandshakeResult | undefined;
  #nextId = 1;

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
  }

  get snapshot(): PiRuntimeSnapshot {
    return this.#manager.snapshot;
  }

  get handshake(): HostHandshakeResult | undefined {
    return this.#handshake;
  }

  get currentBroker(): PiRuntimeBroker | undefined {
    return this.#generations.get(this.#currentId)?.broker;
  }

  subscribe(listener: (snapshot: PiRuntimeSnapshot) => void): () => void {
    return this.#manager.subscribe(listener);
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
      await this.#ensureBroker(snapshot.active);
    }
    return this.#handshake;
  }

  async refresh(): Promise<PiRuntimeSnapshot> {
    const snapshot = await this.#manager.refresh();
    if (snapshot.status === "ready" && snapshot.active) {
      await this.#ensureBroker(snapshot.active);
    }
    return this.snapshot;
  }

  async rediscover(): Promise<PiRuntimeSnapshot> {
    return this.refresh();
  }

  async activate(id: string): Promise<PiRuntimeSnapshot> {
    const snapshot = await this.#manager.activate(id);
    if (snapshot.status === "ready" && snapshot.active) {
      await this.#ensureBroker(snapshot.active);
    }
    return this.snapshot;
  }

  async activateCustom(packageRoot: string, nodePath?: string): Promise<PiRuntimeSnapshot> {
    const snapshot = await this.#manager.activateCustom(packageRoot, nodePath);
    if (snapshot.status === "ready" && snapshot.active) {
      await this.#ensureBroker(snapshot.active);
    }
    return this.snapshot;
  }

  async install(): Promise<PiRuntimeSnapshot> {
    await this.#stopGenerationsForUpdate();
    const snapshot = await this.#manager.install();
    if (snapshot.status === "ready" && snapshot.active) {
      await this.#ensureBroker(snapshot.active);
    }
    return this.snapshot;
  }

  async upgrade(): Promise<PiRuntimeSnapshot> {
    await this.#stopGenerationsForUpdate();
    const snapshot = await this.#manager.upgrade();
    if (snapshot.status === "ready" && snapshot.active) {
      await this.#ensureBroker(snapshot.active);
    }
    return this.snapshot;
  }

  requireBroker(): PiRuntimeBroker {
    const broker = this.currentBroker;
    if (!broker) throw new PiRuntimeNotReadyError();
    return broker;
  }

  brokerForSession(sessionId: string): PiRuntimeBroker {
    for (const generation of this.#generations.values()) {
      if (generation.broker.activeSessionIds.includes(sessionId)) return generation.broker;
    }
    return this.requireBroker();
  }

  async ensureActiveBroker(): Promise<HostHandshakeResult> {
    if (this.#handshake) return this.#handshake;
    const snapshot = this.#manager.snapshot.status === "ready"
      ? this.#manager.snapshot
      : await this.#manager.refresh();
    if (snapshot.status !== "ready" || !snapshot.active) {
      throw new PiRuntimeNotReadyError(snapshot.issue ?? "Pi runtime is not ready");
    }
    return this.#ensureBroker(snapshot.active);
  }

  asBroker(): PiRuntimeBroker {
    return new Proxy(this.currentBroker ?? ({} as PiRuntimeBroker), {
      get: (_target, property, receiver) => {
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
        const value = Reflect.get(broker, property, receiver);
        return typeof value === "function" ? value.bind(broker) : value;
      },
    });
  }

  async dispose(): Promise<void> {
    const generations = [...this.#generations.values()];
    this.#generations.clear();
    this.#currentId = 0;
    this.#handshake = undefined;
    await Promise.all(generations.map(async (generation) => {
      generation.unsubscribe();
      await generation.broker.dispose();
    }));
  }

  async #ensureBroker(installation: PiRuntimeInstallation): Promise<HostHandshakeResult> {
    const current = this.#generations.get(this.#currentId);
    if (
      current
      && current.packageRoot === installation.packageRoot
      && current.handshake.runtime.piVersion === installation.version
    ) {
      this.#handshake = current.handshake;
      return current.handshake;
    }
    const broker = this.#createBroker({
      hostEntry: this.#hostEntry,
      ...(installation.nodePath === undefined ? {} : { nodePath: installation.nodePath }),
      ...(installation.packageRoot === undefined ? {} : { packageRoot: installation.packageRoot }),
      runtimeSource: installation.source,
    });
    const handshake = await broker.warmup();
    const id = this.#nextId;
    this.#nextId += 1;
    const unsubscribe = broker.subscribe((event) => {
      for (const listener of this.#brokerListeners) listener(event);
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
    }
  }

  async #retireIdleGeneration(id: number): Promise<void> {
    if (id === this.#currentId) return;
    const generation = this.#generations.get(id);
    if (!generation || generation.broker.activeSessionIds.length > 0) return;
    generation.unsubscribe();
    await generation.broker.dispose();
    this.#generations.delete(id);
  }
}

export type { PiRuntimeBrokerOptions };
