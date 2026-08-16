import { randomUUID } from "node:crypto";
import type {
  PiRuntimeInstallation,
  PiRuntimeManagerStatus,
  PiRuntimeSnapshot,
  RuntimeSourceKind,
} from "@piarium/protocol";
import {
  discoverPiRuntimes,
  toRuntimeInstallation,
  type CustomRuntimeConfig,
  type RuntimeDiscoveryOptions,
} from "@piarium/pi-host/discovery";
import { resolveBundledPiHostEntry } from "./host-entry.js";
import { probePiRuntime } from "./runtime-probe.js";
import {
  loadRuntimeSelection,
  saveRuntimeSelection,
  type PersistedRuntimeSelection,
} from "./runtime-selection-store.js";

export interface PiRuntimeManagerOptions {
  dataDir: string;
  discover?: typeof discoverPiRuntimes;
  discovery?: Omit<RuntimeDiscoveryOptions, "customRuntimes">;
  hostEntry?: string;
  probe?: typeof probePiRuntime;
}

function installationSourceToRuntimeSource(source: PiRuntimeInstallation["source"]): RuntimeSourceKind {
  return source;
}

export class PiRuntimeManager {
  readonly #dataDir: string;
  readonly #discover: typeof discoverPiRuntimes;
  readonly #discovery: Omit<RuntimeDiscoveryOptions, "customRuntimes">;
  readonly #hostEntry: string;
  readonly #listeners = new Set<(snapshot: PiRuntimeSnapshot) => void>();
  readonly #probe: typeof probePiRuntime;
  #active: PiRuntimeInstallation | undefined;
  #installations: PiRuntimeInstallation[] = [];
  #issue: string | undefined;
  #operationId: string | undefined;
  #selectedId: string | undefined;
  #status: PiRuntimeManagerStatus = "discovering";

  constructor(options: PiRuntimeManagerOptions) {
    this.#dataDir = options.dataDir;
    this.#discover = options.discover ?? discoverPiRuntimes;
    this.#discovery = options.discovery ?? {};
    this.#hostEntry = options.hostEntry ?? resolveBundledPiHostEntry();
    this.#probe = options.probe ?? probePiRuntime;
  }

  get snapshot(): PiRuntimeSnapshot {
    return {
      status: this.#status,
      installations: this.#installations,
      ...(this.#selectedId === undefined ? {} : { selectedId: this.#selectedId }),
      ...(this.#active === undefined ? {} : { active: this.#active }),
      ...(this.#operationId === undefined ? {} : { operationId: this.#operationId }),
      ...(this.#issue === undefined ? {} : { issue: this.#issue }),
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
      this.#installations.find((entry) => entry.id === "system" && usable(entry))
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
    const snapshot = this.snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }
}
