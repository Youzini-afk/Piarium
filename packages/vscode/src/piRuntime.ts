import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as vscode from 'vscode';
import {
  PiRuntimeBroker,
  type PiRuntimeBrokerEvent,
} from '@piarium/runtime-broker/core';

export type PiRuntimeConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface PiRuntimeStatusSnapshot {
  error?: string;
  status: PiRuntimeConnectionStatus;
}

export interface VSCodePiRuntimeDependencies {
  createBroker: (options: ConstructorParameters<typeof PiRuntimeBroker>[0]) => PiRuntimeBroker;
  resolveHostEntry: (extensionPath: string) => string;
  resolveNodeExecutable: () => string;
}

const MINIMUM_NODE = [22, 19, 0] as const;

const parseNodeVersion = (value: string): [number, number, number] | null => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const supportsPiHost = (version: readonly number[]): boolean => {
  for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
    const part = version[index] ?? 0;
    if (part !== MINIMUM_NODE[index]) return part > MINIMUM_NODE[index];
  }
  return true;
};

const readNodeVersion = (executable: string): [number, number, number] | null => {
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return parseNodeVersion(result.stdout || result.stderr || '');
};

const configuredNodeCandidates = (): string[] => {
  const configured = vscode.workspace.getConfiguration('piarium').get<string>('nodePath')?.trim();
  return [configured, process.env.PIARIUM_NODE_PATH]
    .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
    .map((candidate) => candidate.trim());
};

const pathNodeCandidates = (): string[] => {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(command, ['node'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  const discovered = result.status === 0
    ? result.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)
    : [];
  if (process.platform !== 'win32') return discovered;
  return [
    ...discovered,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'nodejs', 'node.exe') : '',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe') : '',
    process.env.SCOOP ? join(process.env.SCOOP, 'apps', 'nodejs', 'current', 'node.exe') : '',
  ].filter(Boolean);
};

export const resolvePiNodeExecutable = (): string => {
  const currentVersion = parseNodeVersion(process.versions.node);
  const configuredCandidates = configuredNodeCandidates();
  const relativeCandidate = configuredCandidates.find((candidate) => !isAbsolute(candidate));
  if (relativeCandidate) {
    throw new Error(
      `Piarium Node.js overrides must be absolute paths; received ${JSON.stringify(relativeCandidate)}`,
    );
  }
  const candidates = [
    ...configuredCandidates,
    ...(currentVersion && supportsPiHost(currentVersion) ? [process.execPath] : []),
    ...pathNodeCandidates(),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    const absolute = resolve(candidate);
    const key = process.platform === 'win32' ? absolute.toLocaleLowerCase() : absolute;
    if (seen.has(key) || !existsSync(absolute)) continue;
    seen.add(key);
    const version = absolute === process.execPath && currentVersion
      ? currentVersion
      : readNodeVersion(absolute);
    if (version && supportsPiHost(version)) return absolute;
  }
  throw new Error(
    'Piarium requires Node.js 22.19 or newer for the Pi host. Install a current Node.js release or set piarium.nodePath.',
  );
};

export const resolveVSCodePiHostEntry = (extensionPath: string): string => {
  const candidates = [
    join(extensionPath, 'dist', 'pi-runtime', 'node_modules', '@piarium', 'pi-host', 'dist', 'main.js'),
    join(extensionPath, '..', 'pi-host', 'dist', 'main.js'),
  ];
  const entry = candidates.find((candidate) => existsSync(candidate));
  if (entry) return resolve(entry);
  throw new Error(`Pi host build is missing; checked ${candidates.join(', ')}`);
};

export class VSCodePiRuntime implements vscode.Disposable {
  readonly #context: vscode.ExtensionContext;
  readonly #dependencies: VSCodePiRuntimeDependencies;
  readonly #listeners = new Set<(snapshot: PiRuntimeStatusSnapshot) => void>();
  readonly #output: vscode.OutputChannel;
  #broker: PiRuntimeBroker | null = null;
  #disposed = false;
  #lifecycleTail: Promise<void> = Promise.resolve();
  #status: PiRuntimeStatusSnapshot = { status: 'connecting' };

  constructor(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    dependencies: VSCodePiRuntimeDependencies = {
      createBroker: (options) => new PiRuntimeBroker(options),
      resolveHostEntry: resolveVSCodePiHostEntry,
      resolveNodeExecutable: resolvePiNodeExecutable,
    },
  ) {
    this.#context = context;
    this.#dependencies = dependencies;
    this.#output = output;
  }

  getStatus(): PiRuntimeStatusSnapshot {
    return this.#status;
  }

  onStatusChange(listener: (snapshot: PiRuntimeStatusSnapshot) => void): vscode.Disposable {
    this.#listeners.add(listener);
    return new vscode.Disposable(() => this.#listeners.delete(listener));
  }

  start(): Promise<PiRuntimeBroker> {
    return this.#enqueueLifecycle(() => this.#startLocked());
  }

  async restart(): Promise<void> {
    await this.#enqueueLifecycle(async () => {
      if (this.#disposed) throw new Error('Pi runtime is disposed');
      await this.#stopRuntimeLocked();
      await this.#startLocked();
    });
  }

  async stop(): Promise<void> {
    await this.#enqueueLifecycle(async () => {
      await this.#stopRuntimeLocked();
      if (!this.#disposed) this.#setStatus({ status: 'disconnected' });
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
    void this.#enqueueLifecycle(() => this.#stopRuntimeLocked());
  }

  async #startLocked(): Promise<PiRuntimeBroker> {
    if (this.#disposed) throw new Error('Pi runtime is disposed');
    if (this.#broker && this.#status.status === 'connected') return this.#broker;
    this.#setStatus({ status: 'connecting' });
    try {
      const broker = await this.#startRuntime();
      if (this.#disposed) {
        if (this.#broker === broker) this.#broker = null;
        await broker.dispose();
        throw new Error('Pi runtime is disposed');
      }
      this.#setStatus({ status: 'connected' });
      return broker;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#output.appendLine(`[Pi runtime] ${message}`);
      const broker = this.#broker;
      this.#broker = null;
      if (broker) await broker.dispose();
      if (!this.#disposed) this.#setStatus({ error: message, status: 'error' });
      throw error;
    }
  }

  async #startRuntime(): Promise<PiRuntimeBroker> {
    const previous = this.#broker;
    this.#broker = null;
    if (previous) await previous.dispose();
    const nodePath = this.#dependencies.resolveNodeExecutable();
    const hostEntry = this.#dependencies.resolveHostEntry(this.#context.extensionPath);
    this.#output.appendLine(`[Pi runtime] Node: ${nodePath}`);
    this.#output.appendLine(`[Pi runtime] Host: ${hostEntry}`);
    const broker = this.#dependencies.createBroker({
      client: {
        clientName: 'piarium-vscode',
        clientVersion: String(this.#context.extension?.packageJSON?.version || '0.1.0'),
        mode: 'vscode',
      },
      emit: (event) => {
        if (this.#broker === broker) this.#handleBrokerEvent(event);
      },
      hostEntry,
      nodePath,
    });
    this.#broker = broker;
    const handshake = await broker.warmup();
    this.#output.appendLine(
      `[Pi runtime] Connected: Pi ${handshake.runtime.piVersion}, host ${handshake.hostVersion}, Node ${handshake.runtime.nodeVersion}`,
    );
    return broker;
  }

  async #stopRuntimeLocked(): Promise<void> {
    const broker = this.#broker;
    this.#broker = null;
    if (broker) await broker.dispose();
  }

  #enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#lifecycleTail.then(operation, operation);
    this.#lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #handleBrokerEvent(event: PiRuntimeBrokerEvent): void {
    if (event.kind === 'diagnostic') {
      this.#output.appendLine(`[Pi ${event.role}:${event.workerId}] ${event.message}`);
      return;
    }
    if (event.kind === 'worker.exit' && !event.expected) {
      const suffix = event.signal ? `signal ${event.signal}` : `code ${String(event.code)}`;
      this.#output.appendLine(`[Pi ${event.role}:${event.workerId}] Worker exited unexpectedly (${suffix})`);
      if (event.role === 'catalog') {
        this.#setStatus({ error: `Pi catalog worker exited unexpectedly (${suffix})`, status: 'error' });
      }
    }
  }

  #setStatus(snapshot: PiRuntimeStatusSnapshot): void {
    this.#status = snapshot;
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch {
        // Status observers must not destabilize runtime ownership.
      }
    }
  }
}
