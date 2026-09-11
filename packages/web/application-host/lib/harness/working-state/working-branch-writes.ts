import type {
  DocumentBranchWriteAction,
  DocumentBranchWriteResult,
  WorkingBranchReadProvenance,
} from "@piarium/protocol";
import type { RecoveryState } from "./types.js";
import { readBranchFile, resolveBranchPath } from "./branch-view.js";
import type { ThreadExecutionView, ThreadExecutionViewRegistry } from "./execution-view.js";
import type { VirtualWriteGate } from "./virtual-write-gate.js";
import { assertTextUtf8, VirtualWriteTreeError } from "./virtual-write-tree.js";
import type { WorkingStateStore, WorkspaceWorkingStateAccess } from "./working-state-store.js";

export interface WorkingBranchWriteChange {
  resourceId: string;
  action: DocumentBranchWriteAction;
  content?: string;
  edits?: ReadonlyArray<{ oldText: string; newText: string }>;
}

export type WorkingBranchFilesCommitResult =
  | { status: "disk" }
  | { status: "committed"; writeRevision: number }
  | { status: "conflict"; writeRevision: number }
  | { status: "rejected"; message: string };

const isTextBytes = (bytes: Buffer): boolean => !bytes.includes(0);

const applyEdits = (text: string, edits: ReadonlyArray<{ oldText: string; newText: string }>): string => {
  let next = text;
  for (const edit of edits) {
    if (!edit.oldText) throw new Error("Edit oldText must not be empty");
    const index = next.indexOf(edit.oldText);
    if (index < 0) throw new Error("Could not find the exact text to replace");
    if (next.indexOf(edit.oldText, index + edit.oldText.length) >= 0) {
      throw new Error("Edit oldText matched more than once; make the text unique");
    }
    next = `${next.slice(0, index)}${edit.newText}${next.slice(index + edit.oldText.length)}`;
  }
  return next;
};

const rejected = (message: string): DocumentBranchWriteResult => ({ status: "rejected", message });

const symlinkRejected = (file: string, action: DocumentBranchWriteAction): DocumentBranchWriteResult => (
  rejected(`${file} is a symlink and cannot be ${
    action === "delete" ? "deleted" : action === "write" ? "rewritten" : "edited"
  } by a text tool`)
);

export function createWorkingBranchWriteServices(options: {
  views: ThreadExecutionViewRegistry;
  workingStates: WorkspaceWorkingStateAccess;
  writeGate: VirtualWriteGate;
}): {
  branchWrite(
    sessionId: string,
    changes: readonly WorkingBranchWriteChange[],
    expectedRevision?: number,
  ): Promise<DocumentBranchWriteResult>;
  commitBranchWrites(
    sessionId: string,
    files: Record<string, RecoveryState>,
    expectedWriteRevision?: number,
    store?: WorkingStateStore,
  ): Promise<WorkingBranchFilesCommitResult>;
} {
  const runWhenVirtual = async <T extends DocumentBranchWriteResult | WorkingBranchFilesCommitResult>(
    sessionId: string,
    apply: (view: ThreadExecutionView) => Promise<T>,
  ): Promise<T | { status: "disk" } | { status: "rejected"; message: string }> => {
    const initial = options.views.get(sessionId);
    if (!initial || initial.mode !== "virtual") return { status: "disk" };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ticket = options.writeGate.begin(sessionId);
      if (ticket === "switching") {
        await options.writeGate.waitSwitch(sessionId);
        const after = options.views.get(sessionId);
        if (!after || after.mode !== "virtual") return { status: "disk" };
        continue;
      }
      try {
        const live = options.views.get(sessionId);
        if (!live || live.mode !== "virtual") return { status: "disk" };
        return await apply(live);
      } catch (error) {
        if (error instanceof VirtualWriteTreeError) {
          return { status: "rejected", message: error.message };
        }
        throw error;
      } finally {
        ticket.finish();
      }
    }
    const latest = options.views.get(sessionId);
    return (!latest || latest.mode !== "virtual")
      ? { status: "disk" }
      : { status: "rejected", message: "Working-branch write could not proceed while materialization is in progress" };
  };

  const persistFiles = async (
    sessionId: string,
    store: WorkingStateStore,
    files: Record<string, RecoveryState>,
    expected: number,
  ): Promise<WorkingBranchFilesCommitResult> => {
    const live = options.views.get(sessionId);
    if (!live || live.mode !== "virtual") return { status: "disk" };
    const committed = await store.commitVirtualWrites(live.branchId, expected, files);
    if (committed.status === "conflict") return committed;
    options.views.bind({ ...live, writeRevision: committed.writeRevision });
    return committed;
  };

  return {
    async branchWrite(sessionId, changes, expectedRevision) {
      return runWhenVirtual(sessionId, async (view) => (
        options.workingStates.withStore(view.workspaceId, "working-branch-write", async (store) => {
          const live = options.views.get(sessionId);
          if (!live || live.mode !== "virtual") return { status: "disk" as const };
          const expected = expectedRevision ?? live.writeRevision;
          const files: Record<string, RecoveryState> = {};
          for (const change of changes) {
            let resolved;
            try {
              resolved = resolveBranchPath(store, live.branchId, change.resourceId);
            } catch (error) {
              return rejected(error instanceof Error ? error.message : String(error));
            }
            if (!resolved) return rejected(`Working branch ${live.branchId} is unavailable`);
            if (resolved.state.kind === "symlink") return symlinkRejected(change.resourceId, change.action);
            const current = await readBranchFile(store, live.branchId, change.resourceId, undefined, {
              followSymlinks: false,
            });
            const pathState = store.effectiveState(live.branchId)?.[resolved.path];
            if (change.action === "delete") {
              if ("unavailable" in current) return rejected(current.unavailable);
              if ("missing" in current) return rejected(`${change.resourceId} is not present in this working branch`);
              if (pathState && pathState.kind !== "regular-file") {
                return rejected(`${change.resourceId} is a ${pathState.kind} and cannot be deleted by a text tool`);
              }
              files[resolved.path] = { kind: "missing" };
              continue;
            }
            if (change.action === "write") {
              if (typeof change.content !== "string") return rejected("write requires text content");
              const bytes = Buffer.from(change.content, "utf8");
              if (!isTextBytes(bytes)) return rejected(`${change.resourceId} is not a text file`);
              try {
                assertTextUtf8(bytes, change.resourceId);
              } catch (error) {
                return rejected(error instanceof Error ? error.message : String(error));
              }
              if ("unavailable" in current) return rejected(current.unavailable);
              if (pathState && pathState.kind !== "missing" && pathState.kind !== "regular-file") {
                return rejected(`${change.resourceId} is a ${pathState.kind} and cannot be rewritten as text`);
              }
              const object = await store.putObject(bytes);
              files[resolved.path] = {
                kind: "regular-file",
                objectHash: object.hash,
                byteLength: object.byteLength,
                ...(pathState?.kind === "regular-file" && pathState.mode !== undefined ? { mode: pathState.mode } : {}),
              };
              continue;
            }
            const edits = change.edits ?? [];
            if (edits.length === 0) return rejected("edit requires at least one replacement");
            if ("unavailable" in current) return rejected(current.unavailable);
            if ("missing" in current) return rejected(`${change.resourceId} is not present in this working branch`);
            if (!isTextBytes(current.bytes)) return rejected(`${change.resourceId} is not a text file`);
            try {
              assertTextUtf8(current.bytes, change.resourceId);
            } catch (error) {
              return rejected(error instanceof Error ? error.message : String(error));
            }
            if (pathState && pathState.kind !== "regular-file") {
              return rejected(`${change.resourceId} is a ${pathState.kind} and cannot be edited as text`);
            }
            let text: string;
            try {
              text = applyEdits(new TextDecoder("utf-8", { fatal: true }).decode(current.bytes), edits);
            } catch (error) {
              return rejected(error instanceof Error ? error.message : String(error));
            }
            const object = await store.putObject(Buffer.from(text, "utf8"));
            files[current.path] = {
              kind: "regular-file",
              objectHash: object.hash,
              byteLength: object.byteLength,
              ...(pathState?.kind === "regular-file" && pathState.mode !== undefined ? { mode: pathState.mode } : {}),
            };
          }
          const committed = await persistFiles(sessionId, store, files, expected);
          if (committed.status === "disk") return committed;
          if (committed.status === "rejected") return rejected(committed.message);
          if (committed.status === "conflict") {
            return {
              status: "conflict",
              revision: committed.writeRevision,
              message: `Working branch revision ${expected} is stale; current revision is ${committed.writeRevision}`,
            };
          }
          const origin: WorkingBranchReadProvenance["origin"] = "delta";
          return {
            status: "committed",
            revision: committed.writeRevision,
            provenance: { branchId: live.branchId, revision: committed.writeRevision, origin },
          };
        })
      ));
    },

    async commitBranchWrites(sessionId, files, expectedWriteRevision, store) {
      return runWhenVirtual(sessionId, async (view) => {
        const apply = async (openStore: WorkingStateStore) => {
          const live = options.views.get(sessionId);
          if (!live || live.mode !== "virtual") return { status: "disk" as const };
          return persistFiles(sessionId, openStore, files, expectedWriteRevision ?? live.writeRevision);
        };
        return store
          ? apply(store)
          : options.workingStates.withStore(view.workspaceId, "working-branch-write", apply);
      });
    },
  };
}
