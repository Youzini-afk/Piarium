import type { WorkingBranchReadProvenance } from "@piarium/protocol";
import type { SurfaceSnapshotOverlayEntry } from "../../documents/surface-snapshot-store.js";
import type { ExploreFileSnapshot } from "../explore-file-reader.js";
import type { HarnessDocumentPathOverlayLookup, HarnessDocumentReadLookup } from "../service-host.js";
import { listBranchTextFiles, listBranchViewFromStore, readBranchFile } from "./branch-view.js";
import type { ThreadExecutionViewRegistry } from "./execution-view.js";
import type { WorkingStateRootStore, WorkspaceWorkingStateRootAccess } from "./types.js";

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
  revision: number;
  root: string;
  pinId: string;
  files: Array<{ path: string; text: string; revision: string }>;
  readFile(resourceId: string): Promise<ExploreFileSnapshot>;
  release(): Promise<void>;
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
  workingStates: WorkspaceWorkingStateRootAccess;
}): WorkingBranchLookups {
  const withView = async <T>(
    sessionId: string,
    read: (view: NonNullable<ReturnType<ThreadExecutionViewRegistry["get"]>>, store: WorkingStateRootStore) => Promise<T> | T,
  ): Promise<T | null> => {
    const bound = options.views.get(sessionId);
    if (!bound || bound.mode === "materialized") return null;
    return options.workingStates.withBranchStore(
      bound.workspaceId,
      "working-branch-view",
      async (store): Promise<T | null> => {
        const view = options.views.get(sessionId);
        if (!view || view.mode === "materialized") return null;
        return read(view, store);
      },
      "shared",
      { sessionId: bound.sessionId, threadId: bound.threadId, runId: bound.runId },
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
            provenance: provenanceFor({ ...view, writeRevision: result.viewRevision }, result.origin),
            missing: true as const,
          };
        }
        return {
          status: "working-branch" as const,
          revision: result.revision,
          provenance: provenanceFor({ ...view, writeRevision: result.viewRevision }, result.origin),
          base64: result.bytes.toString("base64"),
        };
      });
    },

    async pathOverlay(sessionId, resourceId) {
      return withView(sessionId, async (view, store) => {
        const listed = await listBranchViewFromStore(store, view.branchId, resourceId);
        if (!listed) {
          return {
            status: "unavailable" as const,
            message: `Working branch ${view.branchId} is unavailable`,
          };
        }
        const entries: SurfaceSnapshotOverlayEntry[] = listed.map((entry) => ({
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
        const branch = await store.getBranchRoot(view.branchId, options?.signal ? { signal: options.signal } : undefined);
        if (!branch) return null;
        const pin = await store.pinBranch(view.branchId, options?.signal ? { signal: options.signal } : undefined);
        let releasePromise: Promise<void> | undefined;
        const release = async (): Promise<void> => {
          releasePromise ??= pin.release().finally(() => {
            options?.signal?.removeEventListener("abort", onAbort);
          });
          await releasePromise;
        };
        const onAbort = (): void => { void release(); };
        if (options?.signal?.aborted) {
          await release();
          options.signal.throwIfAborted();
        }
        options?.signal?.addEventListener("abort", onAbort, { once: true });
        const roots = options?.roots?.length ? [...options.roots] : [""];
        const fixedRead = {
          pinId: pin.pinId,
          branchId: pin.branchId,
          workspaceId: pin.workspaceId,
          view: pin.view,
          revision: pin.revision,
          writeRevision: pin.writeRevision,
          root: pin.root,
          branch: pin.branch,
        };
        try {
          const files = await listBranchTextFiles(
            store,
            view.branchId,
            roots,
            undefined,
            {
              pin: fixedRead,
              ...(options?.signal ? { signal: options.signal } : {}),
              ...(options?.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
            },
          );
          options?.signal?.throwIfAborted();
          return {
            sessionId,
            workspaceId: view.workspaceId,
            branchId: view.branchId,
            writeRevision: pin.writeRevision,
            revision: pin.revision,
            root: pin.root,
            pinId: pin.pinId,
            files: files.map((file) => ({ path: file.path, text: file.text, revision: file.revision })),
            readFile: async (resourceId: string): Promise<ExploreFileSnapshot> => {
              const result = await readBranchFile(store, view.branchId, resourceId, undefined, {
                read: { pin: fixedRead, ...(options?.signal ? { signal: options.signal } : {}) },
              });
              if ("unavailable" in result) return { status: "unavailable", message: result.unavailable };
              if ("missing" in result) return { status: "unavailable", message: `${result.path} is not present in this working branch` };
              if (result.bytes.includes(0)) return { status: "unavailable", message: `${result.path} is not a text file in this working branch` };
              return { status: "ready", content: result.bytes.toString("utf8"), revision: result.revision, source: "working-branch" };
            },
            release,
          };
        } catch (error) {
          await release();
          throw error;
        }
      });
    },
  };
}

export async function exploreFileFromSnapshot(
  snapshot: WorkingBranchQuerySnapshot,
  resourceId: string,
): Promise<ExploreFileSnapshot> {
  return snapshot.readFile(resourceId);
}
