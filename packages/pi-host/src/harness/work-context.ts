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
  contextEntryId: string | null;
  /** Host CAS revision; null until the first successful context.get. */
  revision: number | null;
}

export function createWorkContextMirror(sessionCwd: string): WorkContextMirror {
  return {
    operationDirAbs: path.resolve(sessionCwd),
    operationDir: "",
    workspaceRoot: null,
    queryScope: null,
    contextEntryId: null,
    revision: null,
  };
}

export function applyWorkContextResult(mirror: WorkContextMirror, result: ContextGetResult): void {
  if (!Number.isSafeInteger(result.context.revision) || result.context.revision < 0) throw new Error("Invalid work-context revision");
  if (mirror.workspaceRoot !== null && path.resolve(mirror.workspaceRoot) !== path.resolve(result.workspaceRoot)) {
    throw new Error("Work-context authority changed; reopen this session before using relative paths");
  }
  // A Pi conversation navigation may restore a lower revision. The custom
  // entry identifies which branch-local selection this result belongs to.
  if (mirror.revision !== null && result.context.revision < mirror.revision
    && (result.contextEntryId === undefined || mirror.contextEntryId === result.contextEntryId)) return;
  mirror.workspaceRoot = result.workspaceRoot;
  mirror.operationDir = result.context.operationDir;
  mirror.queryScope = result.context.queryScope === null ? null : [...result.context.queryScope];
  mirror.revision = result.context.revision;
  if (result.contextEntryId !== undefined) mirror.contextEntryId = result.contextEntryId;
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
  readonly #getCurrentEntryId: (() => string | null) | undefined;
  #inflight: Promise<void> | null = null;
  /** Latest revision the Host reported on a respond piggyback; null = unknown. */
  #hostRevision: number | null = null;
  #hostEntryId: string | null | undefined;

  constructor(bridge: HostServicesBridge, mirror: WorkContextMirror, getCurrentEntryId?: () => string | null) {
    this.#bridge = bridge;
    this.#mirror = mirror;
    this.#getCurrentEntryId = getCurrentEntryId;
  }

  get mirror(): WorkContextMirror {
    return this.#mirror;
  }

  /** Called with the revision piggybacked on a successful harness.respond. */
  noteRevision(revision: number, entryId?: string | null): void {
    if (!Number.isSafeInteger(revision) || revision < 0) return;
    this.#hostRevision = revision;
    this.#hostEntryId = entryId;
    if (this.#mirror.revision === revision
      && (entryId === undefined || this.#mirror.contextEntryId === entryId)) return;
    // Notifications are best effort; execution awaits ensureCurrent and surfaces
    // a failed refresh instead of silently using stale path state.
    void this.refresh().catch(() => undefined);
  }

  /**
   * Pull the authoritative context once per observed divergence. A stale
   * piggyback converges with a single context.get: further calls are no-ops
   * until the Host reports a newer revision, so a refresh never loops.
   * `force` is reserved for the explicit work_context read path.
   */
  refresh(force = false): Promise<void> {
    if (!force && this.#mirror.revision !== null
      && (this.#hostRevision === null || this.#mirror.revision === this.#hostRevision)
      && (this.#hostEntryId === undefined || this.#mirror.contextEntryId === this.#hostEntryId)
      && (!this.#getCurrentEntryId || this.#mirror.contextEntryId === this.#getCurrentEntryId())) {
      return Promise.resolve();
    }
    if (this.#inflight) return force ? this.#inflight.then(() => this.refresh(true)) : this.#inflight;
    this.#inflight = this.#bridge
      .request("context.get", {})
      .then((result) => {
        this.apply(result);
      })
      .finally(() => {
        this.#inflight = null;
      });
    return this.#inflight;
  }

  async ensureCurrent(): Promise<void> {
    await this.refresh();
    if (this.#mirror.revision === null
      || (this.#hostRevision !== null && this.#mirror.revision !== this.#hostRevision)
      || (this.#hostEntryId !== undefined && this.#mirror.contextEntryId !== this.#hostEntryId)
      || (this.#getCurrentEntryId && this.#mirror.contextEntryId !== this.#getCurrentEntryId())) {
      throw new Error("Work context changed while preparing this tool; refresh work_context and retry");
    }
  }

  /** Apply a context.* result issued by this session directly. */
  apply(result: ContextGetResult): void {
    applyWorkContextResult(this.#mirror, result);
    this.#hostRevision = result.context.revision;
    this.#hostEntryId = result.contextEntryId;
  }
}
