import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type {
  PiConfigWatchChangeReason,
  PiConfigWatchSubscription,
  PiConfigWatchTarget,
} from "@piarium/protocol";
import { HostError } from "./errors.js";

const COALESCE_DELAY_MS = 20;

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT"
  );
}

function reasonPriority(reason: PiConfigWatchChangeReason): number {
  return reason === "error" ? 3 : reason === "rename" ? 2 : 1;
}

async function deepestExistingDirectory(filePath: string): Promise<string> {
  let candidate = dirname(resolve(filePath));
  while (true) {
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) {
        throw new HostError(
          "invalid_config_path",
          "Configuration watch path cannot traverse a symbolic link",
        );
      }
      if (info.isDirectory()) return candidate;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new HostError(
        "config_watch_failed",
        `No existing directory is available for configuration watch: ${filePath}`,
      );
    }
    candidate = parent;
  }
}

class ConfigPathWatcher {
  readonly #filePath: string;
  readonly #notify: (reason: PiConfigWatchChangeReason) => void;
  #disposed = false;
  #generation = 0;
  #watcher: FSWatcher | undefined;

  constructor(filePath: string, notify: (reason: PiConfigWatchChangeReason) => void) {
    this.#filePath = resolve(filePath);
    this.#notify = notify;
  }

  async start(): Promise<void> {
    await this.#bind(++this.#generation);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#watcher?.close();
    this.#watcher = undefined;
  }

  async #bind(generation: number): Promise<void> {
    const directory = await deepestExistingDirectory(this.#filePath);
    if (this.#disposed || generation !== this.#generation) return;
    const relativePath = relative(directory, this.#filePath);
    const watchedSegment = relativePath.split(/[\\/]/, 1)[0];
    if (!watchedSegment) {
      throw new HostError("config_watch_failed", "Configuration watch target must be a file");
    }
    let watcher: FSWatcher;
    try {
      watcher = watch(directory, (eventType, filename) => {
        if (this.#disposed || generation !== this.#generation) return;
        const changedName = filename === null
          ? undefined
          : filename.split(/[\\/]/, 1)[0];
        if (changedName !== undefined && changedName !== watchedSegment) return;
        const reason = eventType === "rename" ? "rename" : "change";
        this.#notify(reason);
        if (reason === "rename") void this.#rebind(generation);
      });
      watcher.unref();
    } catch (error) {
      throw new HostError(
        "config_watch_failed",
        `Failed to watch configuration path: ${this.#filePath}`,
        { cause: error },
      );
    }
    watcher.on("error", () => {
      if (this.#disposed || generation !== this.#generation) return;
      this.#notify("error");
      void this.#rebind(generation);
    });
    if (this.#disposed || generation !== this.#generation) {
      watcher.close();
      return;
    }
    this.#watcher?.close();
    this.#watcher = watcher;
  }

  async #rebind(expectedGeneration: number): Promise<void> {
    if (this.#disposed || expectedGeneration !== this.#generation) return;
    const generation = ++this.#generation;
    this.#watcher?.close();
    this.#watcher = undefined;
    try {
      await this.#bind(generation);
    } catch {
      if (!this.#disposed && generation === this.#generation) this.#notify("error");
    }
  }
}

class ConfigWatchEntry {
  readonly #emit: (reason: PiConfigWatchChangeReason) => void;
  readonly #paths: readonly string[];
  #pendingReason: PiConfigWatchChangeReason | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #watchers: ConfigPathWatcher[] = [];

  constructor(paths: readonly string[], emit: (reason: PiConfigWatchChangeReason) => void) {
    this.#emit = emit;
    this.#paths = paths;
  }

  async start(): Promise<void> {
    const watchers = this.#paths.map((path) => new ConfigPathWatcher(path, (reason) => {
      this.#schedule(reason);
    }));
    this.#watchers = watchers;
    try {
      await Promise.all(watchers.map((watcher) => watcher.start()));
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  dispose(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pendingReason = undefined;
    for (const watcher of this.#watchers) watcher.dispose();
    this.#watchers = [];
  }

  #schedule(reason: PiConfigWatchChangeReason): void {
    if (
      this.#pendingReason === undefined
      || reasonPriority(reason) > reasonPriority(this.#pendingReason)
    ) {
      this.#pendingReason = reason;
    }
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const pending = this.#pendingReason;
      this.#pendingReason = undefined;
      if (pending !== undefined) this.#emit(pending);
    }, COALESCE_DELAY_MS);
    this.#timer.unref?.();
  }
}

export class ConfigWatchManager {
  readonly #emit: (
    subscription: PiConfigWatchSubscription,
    reason: PiConfigWatchChangeReason,
  ) => void;
  readonly #entries = new Map<string, ConfigWatchEntry>();

  constructor(
    emit: (
      subscription: PiConfigWatchSubscription,
      reason: PiConfigWatchChangeReason,
    ) => void,
  ) {
    this.#emit = emit;
  }

  async watch(
    target: PiConfigWatchTarget,
    paths: readonly string[],
  ): Promise<PiConfigWatchSubscription> {
    const watchId = randomUUID();
    const subscription = { target, watchId } satisfies PiConfigWatchSubscription;
    const entry = new ConfigWatchEntry(paths, (reason) => this.#emit(subscription, reason));
    await entry.start();
    this.#entries.set(watchId, entry);
    return subscription;
  }

  unwatch(watchId: string): boolean {
    const entry = this.#entries.get(watchId);
    if (!entry) return false;
    this.#entries.delete(watchId);
    entry.dispose();
    return true;
  }

  close(): void {
    for (const entry of this.#entries.values()) entry.dispose();
    this.#entries.clear();
  }
}
