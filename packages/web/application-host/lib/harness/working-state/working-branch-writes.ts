import type {
  DocumentBranchWriteAction,
  DocumentBranchWriteResult,
  WorkingBranchReadProvenance,
} from "@piarium/protocol";
import type { RecoveryState } from "./types.js";
import { readBranchFile } from "./branch-view.js";
import type { ThreadExecutionViewRegistry } from "./execution-view.js";
import type { VirtualWriteGate } from "./virtual-write-gate.js";
import type { WorkspaceWorkingStateAccess } from "./working-state-store.js";

export interface WorkingBranchWriteChange {
  resourceId: string;
  action: DocumentBranchWriteAction;
  content?: string;
  edits?: ReadonlyArray<{ oldText: string; newText: string }>;
}

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
} {
  return {
    async branchWrite(sessionId, changes, expectedRevision) {
      const view = options.views.get(sessionId);
      if (!view || view.mode !== "virtual") return { status: "disk" };
      const ticket = options.writeGate.begin(sessionId);
      if (ticket === "switching") {
        await options.writeGate.waitSwitch(sessionId);
        return { status: "disk" };
      }
      const expected = expectedRevision ?? view.writeRevision;
      try {
        return await options.workingStates.withStore(view.workspaceId, "working-branch-write", async (store) => {
          const live = options.views.get(sessionId);
          if (!live || live.mode !== "virtual") return { status: "disk" as const };
          const files: Record<string, RecoveryState> = {};
          for (const change of changes) {
            const current = await readBranchFile(store, view.branchId, change.resourceId);
            const resolved = store.effectiveState(view.branchId)?.[
              "path" in current && !("unavailable" in current) && !("missing" in current)
                ? current.path
                : change.resourceId.replace(/\\/g, "/")
            ];
            if (change.action === "delete") {
              if ("unavailable" in current) return rejected(current.unavailable);
              if ("missing" in current) return rejected(`${change.resourceId} is not present in this working branch`);
              if (resolved && resolved.kind !== "regular-file") {
                return rejected(`${change.resourceId} is a ${resolved.kind} and cannot be deleted by a text tool`);
              }
              files[current.path] = { kind: "missing" };
              continue;
            }
            if (change.action === "write") {
              if (typeof change.content !== "string") return rejected("write requires text content");
              const bytes = Buffer.from(change.content, "utf8");
              if (!isTextBytes(bytes)) return rejected(`${change.resourceId} is not a text file`);
              if ("unavailable" in current) return rejected(current.unavailable);
              if (resolved && resolved.kind !== "missing" && resolved.kind !== "regular-file") {
                return rejected(`${change.resourceId} is a ${resolved.kind} and cannot be rewritten as text`);
              }
              const object = await store.putObject(bytes);
              const path = "missing" in current ? current.path : "path" in current ? current.path : change.resourceId.replace(/\\/g, "/");
              files[path] = {
                kind: "regular-file",
                objectHash: object.hash,
                byteLength: object.byteLength,
                ...(resolved?.kind === "regular-file" && resolved.mode !== undefined ? { mode: resolved.mode } : {}),
              };
              continue;
            }
            const edits = change.edits ?? [];
            if (edits.length === 0) return rejected("edit requires at least one replacement");
            if ("unavailable" in current) return rejected(current.unavailable);
            if ("missing" in current) return rejected(`${change.resourceId} is not present in this working branch`);
            if (!isTextBytes(current.bytes)) return rejected(`${change.resourceId} is not a text file`);
            if (resolved && resolved.kind !== "regular-file") {
              return rejected(`${change.resourceId} is a ${resolved.kind} and cannot be edited as text`);
            }
            let text: string;
            try {
              text = applyEdits(current.bytes.toString("utf8"), edits);
            } catch (error) {
              return rejected(error instanceof Error ? error.message : String(error));
            }
            const object = await store.putObject(Buffer.from(text, "utf8"));
            files[current.path] = {
              kind: "regular-file",
              objectHash: object.hash,
              byteLength: object.byteLength,
              ...(resolved?.kind === "regular-file" && resolved.mode !== undefined ? { mode: resolved.mode } : {}),
            };
          }
          const committed = await store.commitVirtualWrites(view.branchId, expected, files);
          if (committed.status === "conflict") {
            return {
              status: "conflict",
              revision: committed.writeRevision,
              message: `Working branch revision ${expected} is stale; current revision is ${committed.writeRevision}`,
            };
          }
          const origin: WorkingBranchReadProvenance["origin"] = "delta";
          options.views.bind({ ...live, writeRevision: committed.writeRevision });
          return {
            status: "committed",
            revision: committed.writeRevision,
            provenance: { branchId: view.branchId, revision: committed.writeRevision, origin },
          };
        });
      } finally {
        ticket.finish();
      }
    },
  };
}
