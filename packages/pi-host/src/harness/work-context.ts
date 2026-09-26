import path from "node:path";
import type { ContextGetResult } from "@varin/protocol";
import type { HostServicesBridge } from "./host-services-bridge.js";

/**
 * RR2/D-328+: pi-side mirror of the Host-owned session work context.
 * The Host is authoritative; this mirror lets tool wrappers anchor relative
 * paths at the session operation dir without a round-trip per call. The
 * mirror is refreshed whenever the Host reports a revision mismatch on a
 * harness.respond piggyback, and eagerly by the work_context tool.
 */
export interface WorkContextMirror {
  /** Absolute operation dir used to anchor relative tool paths locally. */
  operationDirAbs: string;
  /** Rel-to-root form reported by the Host ("" until the first sync). */
  operationDir: string;
  workspaceRoot: string | null;
  queryScope: readonly string[] | null;
  /** Host CAS revision; null until the first successful context.get. */
  revision: number | null;
}

export function createWorkContextMirror(sessionCwd: string): WorkContextMirror {
  return {
    operationDirAbs: path.resolve(sessionCwd),
    operationDir: "",
    workspaceRoot: null,
    queryScope: null,
    revision: null,
  };
}

export function applyWorkContextResult(mirror: WorkContextMirror, result: ContextGetResult): void {
  mirror.workspaceRoot = result.workspaceRoot;
  mirror.operationDir = result.context.operationDir;
  mirror.queryScope = result.context.queryScope === null ? null : [...result.context.queryScope];
  mirror.revision = result.context.revision;
  mirror.operationDirAbs = result.context.operationDir === ""
    ? result.workspaceRoot
    : path.resolve(result.workspaceRoot, result.context.operationDir);
}

/** Anchor a tool path at the current operation dir; absolute inputs pass through. */
export function resolveWorkContextPath(mirror: WorkContextMirror, input: string): string {
  return path.isAbsolute(input) ? input : path.resolve(mirror.operationDirAbs, input);
}

/**
 * Lazily re-pull the authoritative context when the Host piggybacked a
 * different revision on a harness.respond. Concurrent calls share one fetch.
 */
export class WorkContextSync {
  readonly #bridge: HostServicesBridge;
  readonly #mirror: WorkContextMirror;
  #inflight: Promise<void> | null = null;
  /** Latest revision the Host reported on a respond piggyback; null = unknown. */
  #hostRevision: number | null = null;

  constructor(bridge: HostServicesBridge, mirror: WorkContextMirror) {
    this.#bridge = bridge;
    this.#mirror = mirror;
  }

  get mirror(): WorkContextMirror {
    return this.#mirror;
  }

  /** Called with the revision piggybacked on a successful harness.respond. */
  noteRevision(revision: number): void {
    this.#hostRevision = revision;
    if (this.#mirror.revision === revision) return;
    void this.refresh();
  }

  /**
   * Pull the authoritative context once per observed divergence. A stale
   * piggyback converges with a single context.get: further calls are no-ops
   * until the Host reports a newer revision, so a refresh never loops.
   * `force` is reserved for the explicit work_context read path.
   */
  refresh(force = false): Promise<void> {
    if (!force && this.#hostRevision !== null && this.#mirror.revision === this.#hostRevision) {
      return Promise.resolve();
    }
    if (this.#inflight) return this.#inflight;
    this.#inflight = this.#bridge
      .request("context.get", {})
      .then((result) => {
        applyWorkContextResult(this.#mirror, result);
        this.#hostRevision = result.context.revision;
      })
      .catch(() => {
        // Keep the stale mirror; the next piggyback or explicit tool call retries.
      })
      .finally(() => {
        this.#inflight = null;
      });
    return this.#inflight;
  }

  /** Apply a context.* result issued by this session directly. */
  apply(result: ContextGetResult): void {
    applyWorkContextResult(this.#mirror, result);
    this.#hostRevision = result.context.revision;
  }
}
