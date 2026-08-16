import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type {
  PiRuntimeInstallPlan,
  PiRuntimeInstallation,
  PiRuntimeManagerStatus,
  PiRuntimeSnapshot,
  RuntimeSourceKind,
} from "@piarium/protocol";
import {
  discoverPiRuntimes,
  readPinnedPiVersion,
  toRuntimeInstallation,
  type CustomRuntimeConfig,
  type RuntimeDiscoveryOptions,
} from "@piarium/pi-host/discovery";
import { resolveBundledPiHostEntry } from "./host-entry.js";
import { detectInstallManagers, planPiInstall } from "./runtime-install-plan.js";
import {
  describeInstallFailure,
  executePiInstallPlan,
  type RuntimeInstallerOptions,
} from "./runtime-installer.js";
import { probePiRuntime } from "./runtime-probe.js";
import {
  loadRuntimeSelection,
  saveRuntimeSelection,
  type PersistedRuntimeSelection,
} from "./runtime-selection-store.js";
import { standalonePayloadLooksPresent } from "./standalone-runtime.js";

export interface PiRuntimeManagerOptions {
  dataDir: string;
  discover?: typeof discoverPiRuntimes;
  discovery?: Omit<RuntimeDiscoveryOptions, "customRuntimes">;
  hostEntry?: string;
  installer?: RuntimeInstallerOptions;
  planInstall?: typeof planPiInstall;
  probe?: typeof probePiRuntime;
  targetVersion?: string;
}

const execFileAsync = promisify(execFile);

function installationSourceToRuntimeSource(source: PiRuntimeInstallation["source"]): RuntimeSourceKind {
  return source;
}

async function defaultInstallRunner(
  command: string,
  args: string[],
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
    return { exitCode: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    const failure = error as Error & { code?: number | string; stderr?: string; stdout?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stderr: failure.stderr ?? failure.message,
      stdout: failure.stdout ?? "",
    };
  }
}

export class PiRuntimeManager {
  readonly #dataDir: string;
  readonly #discover: typeof discoverPiRuntimes;
  readonly #discovery: Omit<RuntimeDiscoveryOptions, "customRuntimes">;
  readonly #hostEntry: string;
  readonly #installer: RuntimeInstallerOptions;
  readonly #listeners = new Set<(snapshot: PiRuntimeSnapshot) => void>();
  readonly #planInstall: typeof planPiInstall;
  readonly #probe: typeof probePiRuntime;
  readonly #targetVersion: string;
  #active: PiRuntimeInstallation | undefined;
  #installations: PiRuntimeInstallation[] = [];
  #installPlan: PiRuntimeInstallPlan | undefined;
  #issue: string | undefined;
  #operationId: string | undefined;
  #revision = 0;
  #selectedId: string | undefined;
  #status: PiRuntimeManagerStatus = "discovering";

  constructor(options: PiRuntimeManagerOptions) {
    this.#dataDir = options.dataDir;
    this.#discover = options.discover ?? discoverPiRuntimes;
    this.#discovery = options.discovery ?? {};
    this.#hostEntry = options.hostEntry ?? resolveBundledPiHostEntry();
    this.#installer = options.installer ?? {};
    this.#planInstall = options.planInstall ?? planPiInstall;
    this.#probe = options.probe ?? probePiRuntime;
    this.#targetVersion = options.targetVersion ?? readPinnedPiVersion();
  }

  get snapshot(): PiRuntimeSnapshot {
    return {
      revision: this.#revision,
      status: this.#status,
      installations: this.#installations,
      ...(this.#selectedId === undefined ? {} : { selectedId: this.#selectedId }),
      ...(this.#active === undefined ? {} : { active: this.#active }),
      ...(this.#operationId === undefined ? {} : { operationId: this.#operationId }),
      ...(this.#issue === undefined ? {} : { issue: this.#issue }),
      ...(this.#installPlan === undefined ? {} : { installPlan: this.#installPlan }),
    };
  }

  subscribe(listener: (snapshot: PiRuntimeSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async refresh(): Promise<PiRuntimeSnapshot> {
    return this.#run("discovering", async () => {
      const loaded = await loadRuntimeSelection(this.#dataDir);
      if (loaded.status === "malformed") {
        this.#installations = [];
        this.#active = undefined;
        this.#selectedId = undefined;
        this.#status = "failed";
        this.#issue = loaded.issue;
        return;
      }
      const selection = loaded.status === "ok" ? loaded.selection : {};
      this.#selectedId = selection.selectedId;
      const candidates = await this.#discover({
        ...this.#discovery,
        ...(this.#customRuntimes(selection).length === 0
          ? {}
          : { customRuntimes: this.#customRuntimes(selection) }),
      });
      this.#installations = candidates.map(toRuntimeInstallation);
      this.#installPlan = await this.#createInstallPlan();
      const preferred = this.#preferredInstallation();
      if (!preferred) {
        this.#active = undefined;
        this.#status = this.#installations.some((entry) => entry.state === "upgrade-required")
          ? "upgrade-required"
          : "missing";
        return;
      }
      if (preferred.state === "upgrade-required") {
        this.#active = undefined;
        this.#status = "upgrade-required";
        this.#issue = preferred.issue;
        return;
      }
      await this.#probeInstallation(preferred);
    });
  }

  async activate(id: string): Promise<PiRuntimeSnapshot> {
    return this.#run("probing", async () => {
      const installation = this.#installations.find((entry) => entry.id === id);
      if (!installation) {
        this.#status = "failed";
        this.#issue = `Pi runtime ${id} was not found`;
        return;
      }
      this.#selectedId = id;
      await saveRuntimeSelection(this.#dataDir, {
        selectedId: id,
        ...(installation.source === "custom" && installation.packageRoot
          ? { customPackageRoot: installation.packageRoot }
          : {}),
        ...(installation.source === "custom" && installation.nodePath
          ? { customNodePath: installation.nodePath }
          : {}),
      });
      await this.#probeInstallation(installation);
    });
  }

  async rediscover(): Promise<PiRuntimeSnapshot> {
    return this.refresh();
  }

  async install(): Promise<PiRuntimeSnapshot> {
    return this.#applyInstall("install");
  }

  async upgrade(): Promise<PiRuntimeSnapshot> {
    return this.#applyInstall("upgrade");
  }

  async activateCustom(packageRoot: string, nodePath?: string): Promise<PiRuntimeSnapshot> {
    const selection: PersistedRuntimeSelection = {
      selectedId: "custom:selected",
      customPackageRoot: packageRoot,
      ...(nodePath === undefined ? {} : { customNodePath: nodePath }),
    };
    await saveRuntimeSelection(this.#dataDir, selection);
    this.#selectedId = selection.selectedId;
    return this.refresh();
  }

  async #applyInstall(requested: "install" | "upgrade"): Promise<PiRuntimeSnapshot> {
    const plan = this.#installPlan ?? await this.#createInstallPlan();
    this.#installPlan = plan;
    if (plan.action === "none" || plan.action === "keep-newer") {
      return this.refresh();
    }
    if (requested === "upgrade" && plan.action === "install") {
      return this.#run("failed", async () => {
        this.#status = "missing";
        this.#issue = "Pi is not installed";
      });
    }
    if (!plan.manager) {
      return this.#run("failed", async () => {
        this.#status = plan.currentVersion ? "upgrade-required" : "missing";
        this.#issue = plan.reason;
      });
    }
    return this.#run(plan.action === "upgrade" ? "upgrading" : "installing", async () => {
      const result = await executePiInstallPlan(plan, this.#installer);
      await this.#rediscoverInstallations();
      this.#installPlan = await this.#createInstallPlan();
      if (result.exitCode !== 0) {
        this.#status = "failed";
        this.#issue = describeInstallFailure(result);
        return;
      }
      const preferred = this.#preferredInstallation();
      if (!preferred || preferred.state === "missing") {
        this.#status = "failed";
        this.#issue = "Pi install finished but the runtime could not be discovered";
        return;
      }
      if (preferred.state === "upgrade-required") {
        this.#status = "upgrade-required";
        this.#issue = preferred.issue;
        return;
      }
      await this.#probeInstallation(preferred);
    });
  }

  async #createInstallPlan(): Promise<PiRuntimeInstallPlan> {
    const current = this.#installations.find(
      (entry) => entry.id === "system" || entry.id === "standalone",
    );
    const runner = this.#discovery.commandRunner ?? defaultInstallRunner;
    const managers = await detectInstallManagers({
      ...(this.#discovery.env === undefined ? {} : { env: this.#discovery.env }),
      ...(this.#discovery.platform === undefined ? {} : { platform: this.#discovery.platform }),
      runner,
    });
    return this.#planInstall({
      ...(current === undefined ? {} : { current }),
      ...(this.#discovery.env === undefined ? {} : { env: this.#discovery.env }),
      managers,
      ...(this.#discovery.platform === undefined ? {} : { platform: this.#discovery.platform }),
      standaloneAvailable: Boolean(
        this.#installer.standalonePayloadDir
        && standalonePayloadLooksPresent(this.#installer.standalonePayloadDir),
      ),
      targetVersion: this.#targetVersion,
    });
  }

  async #rediscoverInstallations(): Promise<void> {
    const loaded = await loadRuntimeSelection(this.#dataDir);
    const selection = loaded.status === "ok" ? loaded.selection : {};
    const candidates = await this.#discover({
      ...this.#discovery,
      ...(this.#customRuntimes(selection).length === 0
        ? {}
        : { customRuntimes: this.#customRuntimes(selection) }),
    });
    this.#installations = candidates.map(toRuntimeInstallation);
  }

  #customRuntimes(selection: PersistedRuntimeSelection): CustomRuntimeConfig[] {
    if (!selection.customPackageRoot) return [];
    return [
      {
        id: "selected",
        packageRoot: selection.customPackageRoot,
        ...(selection.customNodePath === undefined ? {} : { nodePath: selection.customNodePath }),
      },
    ];
  }

  #preferredInstallation(): PiRuntimeInstallation | undefined {
    const byId = new Map(this.#installations.map((entry) => [entry.id, entry]));
    const selected = this.#selectedId ? byId.get(this.#selectedId) : undefined;
    if (selected && selected.state !== "missing") return selected;
    const usable = (entry: PiRuntimeInstallation) =>
      entry.state === "ready" || entry.state === "upgrade-required";
    return (
      this.#installations.find((entry) => (entry.id === "system" || entry.id === "standalone") && usable(entry))
      ?? this.#installations.find((entry) => entry.id === "bundled" && entry.state === "ready")
      ?? this.#installations.find((entry) => usable(entry))
    );
  }

  async #probeInstallation(installation: PiRuntimeInstallation): Promise<void> {
    if (installation.state === "upgrade-required") {
      this.#active = undefined;
      this.#status = "upgrade-required";
      this.#issue = installation.issue;
      return;
    }
    if (installation.source !== "bundled" && !installation.packageRoot) {
      this.#active = {
        ...installation,
        state: "failed",
        issue: installation.issue ?? "Pi package root could not be resolved",
      };
      this.#status = "failed";
      this.#issue = this.#active.issue;
      return;
    }
    this.#status = "probing";
    this.#emit();
    try {
      const probed = await this.#probe({
        hostEntry: this.#hostEntry,
        ...(installation.nodePath === undefined ? {} : { nodePath: installation.nodePath }),
        ...(installation.packageRoot === undefined ? {} : { packageRoot: installation.packageRoot }),
        runtimeSource: installationSourceToRuntimeSource(installation.source),
      });
      const runtime = probed.handshake.runtime;
      this.#active = {
        ...installation,
        state: "ready",
        nodePath: runtime.nodePath,
        ...(runtime.packageRoot === undefined ? {} : { packageRoot: runtime.packageRoot }),
        version: runtime.piVersion,
        source: runtime.source === "source" ? "development" : runtime.source,
      };
      this.#status = "ready";
    } catch (error) {
      const issue = error instanceof Error ? error.message : String(error);
      this.#active = { ...installation, state: "failed", issue };
      this.#status = "failed";
      this.#issue = issue;
    }
  }

  async #run(
    status: PiRuntimeManagerStatus,
    work: () => Promise<void>,
  ): Promise<PiRuntimeSnapshot> {
    this.#operationId = randomUUID();
    this.#status = status;
    this.#issue = undefined;
    this.#emit();
    try {
      await work();
    } catch (error) {
      this.#status = "failed";
      this.#issue = error instanceof Error ? error.message : String(error);
    }
    this.#emit();
    return this.snapshot;
  }

  #emit(): void {
    this.#revision += 1;
    const snapshot = this.snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }
}
