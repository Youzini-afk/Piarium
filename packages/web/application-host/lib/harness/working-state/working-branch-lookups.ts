import type { WorkingBranchReadProvenance } from "@piarium/protocol";
import type { SurfaceSnapshotOverlayEntry } from "../../documents/surface-snapshot-store.js";
import type { ExploreFileSnapshot } from "../explore-file-reader.js";
import type { HarnessDocumentPathOverlayLookup, HarnessDocumentReadLookup } from "../service-host.js";
import { listBranchView, listBranchTextFiles, readBranchFile } from "./branch-view.js";
import type { ThreadExecutionViewRegistry } from "./execution-view.js";
import type { WorkspaceWorkingStateAccess } from "./working-state-store.js";

export interface WorkingBranchLookups {
  readSource(sessionId: string, resourceId: string): Promise<HarnessDocumentReadLookup | null>;
  pathOverlay(sessionId: string, resourceId: string): Promise<HarnessDocumentPathOverlayLookup | null>;
  searchCorpus(sessionId: string): Promise<Array<{ path: string; text: string }> | null>;
  exploreFile(sessionId: string, resourceId: string): Promise<ExploreFileSnapshot | null>;
  pinQuery(sessionId: string, options?: WorkingBranchPinOptions): Promise<WorkingBranchQuerySnapshot | null>;
}

export interface WorkingBranchPinOptions {
  roots?: readonly string[];
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface WorkingBranchQuerySnapshot {
  sessionId: string;
  workspaceId: string;
  branchId: string;
  writeRevision: number;
  files: Array<{ path: string; text: string; revision: string }>;
}

const provenanceFor = (
  view: { branchId: string; writeRevision: number },
  origin: WorkingBranchReadProvenance["origin"],
): WorkingBranchReadProvenance => ({
  branchId: view.branchId,
  revision: view.writeRevision,
  origin,
});

export function createWorkingBranchLookups(options: {
  views: ThreadExecutionViewRegistry;
  workingStates: WorkspaceWorkingStateAccess;
}): WorkingBranchLookups {
  const withView = async <T>(
    sessionId: string,
    read: (view: NonNullable<ReturnType<ThreadExecutionViewRegistry["get"]>>, store: Parameters<Parameters<WorkspaceWorkingStateAccess["withStore"]>[2]>[0]) => Promise<T> | T,
  ): Promise<T | null> => {
    const bound = options.views.get(sessionId);
    if (!bound || bound.mode === "materialized") return null;
    return options.workingStates.withStore(
      bound.workspaceId,
      "working-branch-view",
      (store) => {
        const view = options.views.get(sessionId);
        if (!view || view.mode === "materialized") return null as T;
        return read(view, store);
      },
      "shared",
    );
  };

  return {
    async readSource(sessionId, resourceId) {
      return withView(sessionId, async (view, store) => {
        const result = await readBranchFile(store, view.branchId, resourceId);
        if ("unavailable" in result) {
          return {
            status: "working-branch" as const,
            revision: `working-branch:${view.branchId}@${view.writeRevision}:base`,
            provenance: provenanceFor(view, "base"),
            message: result.unavailable,
          };
        }
        if ("missing" in result) {
          return {
            status: "working-branch" as const,
            revision: result.revision,
            provenance: provenanceFor(view, result.origin),
            missing: true as const,
          };
        }
        return {
          status: "working-branch" as const,
          revision: result.revision,
          provenance: provenanceFor(view, result.origin),
          base64: result.bytes.toString("base64"),
        };
      });
    },

    async pathOverlay(sessionId, resourceId) {
      return withView(sessionId, (view, store) => {
        const states = store.effectiveState(view.branchId);
        if (!states) {
          return {
            status: "unavailable" as const,
            message: `Working branch ${view.branchId} is unavailable`,
          };
        }
        const entries: SurfaceSnapshotOverlayEntry[] = listBranchView(states, resourceId, {
          branchId: view.branchId,
          revision: view.writeRevision,
        }).map((entry) => ({
          path: entry.path,
          kind: entry.kind,
          ...(entry.revision === undefined ? {} : { revision: entry.revision }),
        }));
        return { status: "ready" as const, authority: "working-branch" as const, entries };
      });
    },

    async searchCorpus(sessionId) {
      return withView(sessionId, async (view, store) => {
        const files = await listBranchTextFiles(store, view.branchId, [""]);
        return files.map((file) => ({ path: file.path, text: file.text }));
      });
    },

    async exploreFile(sessionId, resourceId) {
      return withView(sessionId, async (view, store) => {
        const result = await readBranchFile(store, view.branchId, resourceId);
        if ("unavailable" in result) {
          return { status: "unavailable" as const, message: result.unavailable };
        }
        if ("missing" in result) {
          return { status: "unavailable" as const, message: `${result.path} is not present in this working branch` };
        }
        if (result.bytes.includes(0)) {
          return { status: "unavailable" as const, message: `${result.path} is not a text file in this working branch` };
        }
        return {
          status: "ready" as const,
          content: result.bytes.toString("utf8"),
          revision: result.revision,
          source: "working-branch" as const,
        };
      });
    },

    async pinQuery(sessionId, options) {
      return withView(sessionId, async (view, store) => {
        options?.signal?.throwIfAborted();
        if (options?.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
          throw new DOMException("Explore query deadline exceeded", "AbortError");
        }
        const writeRevision = store.branchWriteRevision(view.branchId);
        if (writeRevision === null) return null;
        const roots = options?.roots?.length ? [...options.roots] : [""];
        const files = await listBranchTextFiles(
          store,
          view.branchId,
          roots,
          undefined,
          {
            ...(options?.signal ? { signal: options.signal } : {}),
            ...(options?.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
          },
        );
        options?.signal?.throwIfAborted();
        return {
          sessionId,
          workspaceId: view.workspaceId,
          branchId: view.branchId,
          writeRevision,
          files: files.map((file) => ({ path: file.path, text: file.text, revision: file.revision })),
        };
      });
    },
  };
}

export function exploreFileFromSnapshot(
  snapshot: WorkingBranchQuerySnapshot,
  resourceId: string,
): ExploreFileSnapshot {
  const normalized = resourceId.replace(/\\/g, "/").replace(/^\.\//, "");
  const file = snapshot.files.find((entry) => entry.path === normalized);
  if (!file) {
    return { status: "unavailable", message: `${normalized} is not present in this working branch` };
  }
  return {
    status: "ready",
    content: file.text,
    revision: file.revision,
    source: "working-branch",
  };
}
