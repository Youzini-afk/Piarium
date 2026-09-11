import { createHash, randomUUID } from "node:crypto";
import type {
  AgentInputContext,
  DocumentSurfaceWriteChange,
  DocumentSurfaceWritePathResult,
  DocumentSurfaceWriteResult,
} from "@piarium/protocol";
import type {
  DirtyBufferPublication,
  DocumentSurfaceOperationRequest,
  DocumentSurfaceOperationResult,
  MutationToken,
} from "./authority.js";
import type { SurfaceSnapshotInspectResult } from "./surface-snapshot-store.js";

export interface AgentSurfaceWriteChange {
  resourceId: string;
  action: DocumentSurfaceWriteChange["action"];
  content?: string;
  edits?: ReadonlyArray<{ oldText: string; newText: string }>;
}

export interface AgentMutationRecord {
  operationId: string;
  sessionId: string;
  workspaceId: string;
  targetKinds: Record<string, "surface" | "disk">;
  results: DocumentSurfaceWritePathResult[];
}

export interface SurfaceMutationDiskWriteResult {
  status: "written" | "conflict" | "missing";
  revision?: string;
  message?: string;
}

export interface SurfaceMutationDiskDeleteResult {
  status: "deleted" | "conflict" | "missing";
  message?: string;
}

export interface SurfaceMutationDependencies {
  inspectSnapshot: (
    sessionId: string,
    context: AgentInputContext,
    resourceId: string,
  ) => SurfaceSnapshotInspectResult;
  surfaceOwner: (
    sessionId: string,
    context: AgentInputContext,
  ) => { ownerId: string; generation: number; workspaceId: string } | null;
  inspectDirtyBuffers: (workspaceId: string) => Promise<DirtyBufferPublication[]>;
  requestSurfaceOperation: (
    request: DocumentSurfaceOperationRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<DocumentSurfaceOperationResult[]>;
  inspectWorkspace: (workspaceId: string) => Promise<{ epoch: number }>;
  readDisk: (workspaceId: string, resourceId: string) => Promise<{
    status: "ready" | "missing" | "binary" | "unsupported-encoding";
    content?: string;
    revision?: string;
  }>;
  writeDisk: (input: {
    workspaceId: string;
    resourceId: string;
    content: string;
    encoding: string;
    bom: boolean;
    expectedRevision: string | null;
    token: MutationToken;
    operationId: string;
  }) => Promise<SurfaceMutationDiskWriteResult>;
  deleteDisk: (input: {
    workspaceId: string;
    resourceId: string;
    expectedRevision: string;
    token: MutationToken;
    operationId: string;
  }) => Promise<SurfaceMutationDiskDeleteResult>;
}

type PlannedClass = "surface" | "disk" | "conflict" | "unavailable";

interface PlannedPath {
  change: AgentSurfaceWriteChange;
  class: PlannedClass;
  inspect?: Extract<SurfaceSnapshotInspectResult, { status: "ready" }>;
  newText?: string;
  binding?: NonNullable<DirtyBufferPublication["resources"][number]>;
  publication?: DirtyBufferPublication;
  result?: DocumentSurfaceWritePathResult;
  diskBefore?: { content: string; revision: string | null };
}

const contentHash = (content: string): string => (
  `sha256-${createHash("sha256").update(content, "utf8").digest("hex")}`
);

const sameResource = (left: string, right: string): boolean => (
  process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
);

export const applyTextEdits = (
  text: string,
  edits: ReadonlyArray<{ oldText: string; newText: string }>,
): string => {
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

const isBinaryText = (content: string): boolean => content.includes("\0");

const findPublished = (
  publication: DirtyBufferPublication | undefined,
  resourceId: string,
): DirtyBufferPublication["resources"][number] | undefined => (
  publication?.resources.find((resource) => sameResource(resource.resource.resourceId, resourceId))
);

const liveMismatch = (
  inspect: Extract<SurfaceSnapshotInspectResult, { status: "ready" }>,
  binding: DirtyBufferPublication["resources"][number] | undefined,
  publication: DirtyBufferPublication | undefined,
): string | null => {
  if (!publication?.registrationId) {
    return `${inspect.resource.resourceId} has unsaved editor changes but its surface owner is no longer connected. Nothing was written.`;
  }
  if (!binding || !binding.documentInstanceId || !binding.bufferHash) {
    return `${inspect.resource.resourceId} has unsaved editor changes but its live buffer identity is incomplete. Nothing was written.`;
  }
  if (binding.baseRevision !== inspect.baseRevision
    || binding.localEditRevision !== inspect.localEditRevision
    || binding.bufferHash !== contentHash(inspect.content)
    || binding.documentInstanceId.length === 0) {
    return `${inspect.resource.resourceId} changed in the editor after this turn fixed its draft. `
      + "The live buffer was left untouched and nothing was written to disk.";
  }
  return null;
};

const contextWorkspaceId = (context: AgentInputContext): string => (
  context.source === "surface" ? context.workspaceId : ""
);

const pathResult = (
  base: Omit<DocumentSurfaceWritePathResult, "revision" | "message"> & {
    revision?: string | undefined;
    message?: string | undefined;
  },
): DocumentSurfaceWritePathResult => ({
  path: base.path,
  target: base.target,
  status: base.status,
  ...(base.revision === undefined ? {} : { revision: base.revision }),
  ...(base.message === undefined ? {} : { message: base.message }),
});

const summarize = (
  planned: PlannedPath[],
  operationId: string,
): DocumentSurfaceWriteResult => {
  const results = planned.map((item) => {
    if (item.result) return item.result;
    const fallbackMessage = item.class === "conflict" || item.class === "unavailable"
      ? "The planned mutation could not be applied."
      : undefined;
    return pathResult({
      path: item.change.resourceId,
      target: item.class === "disk" ? "disk" : "surface",
      status: item.class === "disk" ? "disk"
        : item.class === "unavailable" ? "unavailable"
          : "conflict",
      ...(item.inspect && item.class !== "unavailable" ? { revision: item.inspect.revision } : {}),
      ...(fallbackMessage === undefined ? {} : { message: fallbackMessage }),
    });
  });
  const written = results.some((result) => result.status === "applied");
  const blocked = results.filter((result) => (
    result.status === "conflict" || result.status === "unavailable"
      || result.status === "needs-attention" || result.status === "compensated"
  ));
  const allBlocked = !written && blocked.length === results.length;
  const allUnavailable = allBlocked && blocked.every((result) => result.status === "unavailable");
  const status = written && blocked.length === 0 ? "applied"
    : written ? "partial"
      : allUnavailable ? "unavailable"
        : "conflict";
  const message = status === "applied"
    ? undefined
    : results.map((result) => (
      `${result.status} ${result.path} (${result.target})${result.message ? `: ${result.message}` : ""}`
    )).join("\n");
  return {
    status,
    results,
    operationId,
    ...(message ? { message } : {}),
  };
};

export async function applyAgentSurfaceMutation(
  deps: SurfaceMutationDependencies,
  input: {
    sessionId: string;
    context: AgentInputContext;
    changes: readonly AgentSurfaceWriteChange[];
    signal?: AbortSignal;
  },
): Promise<{ result: DocumentSurfaceWriteResult; record: AgentMutationRecord | null }> {
  if (input.changes.length === 0) {
    return { result: { status: "disk" }, record: null };
  }

  const planned: PlannedPath[] = [];
  for (const change of input.changes) {
    const inspect = deps.inspectSnapshot(input.sessionId, input.context, change.resourceId);
    if (inspect.status === "unavailable") {
      planned.push({
        change,
        class: "unavailable",
        result: {
          path: change.resourceId,
          target: "surface",
          status: "unavailable",
          message: `${change.resourceId} has unsaved editor changes but its fixed draft is unavailable (${inspect.message}). Nothing was written.`,
        },
      });
      continue;
    }
    if (inspect.status === "disk") {
      planned.push({ change, class: "disk" });
      continue;
    }
    if (change.action === "delete") {
      planned.push({
        change,
        class: "unavailable",
        inspect,
        result: {
          path: change.resourceId,
          target: "surface",
          status: "unavailable",
          revision: inspect.revision,
          message: `${change.resourceId} is an editor buffer and cannot be deleted, have its mode changed, or be treated as a symlink. Nothing was written.`,
        },
      });
      continue;
    }
    let newText: string;
    try {
      if (change.action === "write") {
        if (typeof change.content !== "string") throw new Error("write requires text content");
        newText = change.content;
      } else {
        const edits = change.edits ?? [];
        if (edits.length === 0) throw new Error("edit requires at least one replacement");
        newText = applyTextEdits(inspect.content, edits);
      }
    } catch (error) {
      planned.push({
        change,
        class: "conflict",
        inspect,
        result: {
          path: change.resourceId,
          target: "surface",
          status: "conflict",
          revision: inspect.revision,
          message: error instanceof Error ? error.message : String(error),
        },
      });
      continue;
    }
    if (isBinaryText(newText)) {
      planned.push({
        change,
        class: "unavailable",
        inspect,
        result: {
          path: change.resourceId,
          target: "surface",
          status: "unavailable",
          revision: inspect.revision,
          message: `${change.resourceId} is not a text file. Nothing was written.`,
        },
      });
      continue;
    }
    planned.push({ change, class: "surface", inspect, newText });
  }

  if (planned.every((item) => item.class === "disk")) {
    return { result: { status: "disk" }, record: null };
  }

  const owner = deps.surfaceOwner(input.sessionId, input.context);
  const surfaceItems = planned.filter((item) => item.class === "surface");
  if (surfaceItems.length > 0 && !owner) {
    for (const item of surfaceItems) {
      item.class = "unavailable";
      item.result = {
        path: item.change.resourceId,
        target: "surface",
        status: "unavailable",
        message: `${item.change.resourceId} has unsaved editor changes but its fixed draft expired. Nothing was written.`,
      };
    }
  }

  const publications = owner ? await deps.inspectDirtyBuffers(owner.workspaceId) : [];
  const publication = owner
    ? publications.find((entry) => entry.ownerId === owner.ownerId && entry.generation === owner.generation)
    : undefined;

  for (const item of planned.filter((entry) => entry.class === "surface")) {
    const binding = findPublished(publication, item.change.resourceId);
    const mismatch = liveMismatch(item.inspect!, binding, publication);
    if (mismatch || !binding || !publication) {
      item.class = "conflict";
      item.result = pathResult({
        path: item.change.resourceId,
        target: "surface",
        status: "conflict",
        revision: item.inspect!.revision,
        message: mismatch ?? "The planned mutation could not be applied.",
      });
      continue;
    }
    item.binding = binding;
    item.publication = publication;
  }

  const toApplySurface = planned.filter((item) => item.class === "surface");
  const toApplyDisk = planned.filter((item) => item.class === "disk");
  const operationId = randomUUID();
  const applied: Array<
    | { kind: "surface"; item: PlannedPath; receipt: DocumentSurfaceOperationResult }
    | { kind: "disk"; item: PlannedPath; before: { content: string; revision: string | null } }
  > = [];

  const compensate = async (): Promise<void> => {
    for (const entry of [...applied].reverse()) {
      if (entry.kind === "surface") {
        const binding = entry.item.binding!;
        const inspect = entry.item.inspect!;
        const afterRevision = entry.receipt.afterLocalEditRevision;
        const afterHash = entry.receipt.afterHash;
        if (afterRevision === undefined || !afterHash || !entry.item.publication?.registrationId) {
          entry.item.result = {
            path: entry.item.change.resourceId,
            target: "surface",
            status: "needs-attention",
            message: `${entry.item.change.resourceId} was written to the editor buffer but could not be compensated.`,
          };
          continue;
        }
        try {
          const undone = await deps.requestSurfaceOperation({
            action: "undo",
            generation: owner!.generation,
            operationId: `${operationId}:undo`,
            ownerId: owner!.ownerId,
            registrationId: entry.item.publication.registrationId,
            workspaceId: owner!.workspaceId,
            targets: [{
              baseRevision: inspect.baseRevision,
              bufferHash: binding.bufferHash!,
              documentInstanceId: binding.documentInstanceId!,
              encoding: binding.encoding ?? inspect.encoding,
              bom: binding.bom ?? inspect.bom,
              lineEnding: binding.lineEnding ?? "lf",
              localEditRevision: inspect.localEditRevision,
              expectedAppliedRevision: afterRevision,
              expectedAppliedHash: afterHash,
              resource: { workspaceId: owner!.workspaceId, resourceId: entry.item.change.resourceId },
            }],
          }, input.signal ? { signal: input.signal } : {});
          const receipt = undone[0];
          entry.item.result = receipt?.status === "undone"
            ? {
                path: entry.item.change.resourceId,
                target: "surface",
                status: "compensated",
                message: `${entry.item.change.resourceId} was restored to the editor buffer from before this mutation.`,
              }
            : {
                path: entry.item.change.resourceId,
                target: "surface",
                status: "needs-attention",
                message: `${entry.item.change.resourceId} changed after it was written, so compensation left the live buffer untouched.`,
              };
        } catch {
          entry.item.result = {
            path: entry.item.change.resourceId,
            target: "surface",
            status: "needs-attention",
            message: `${entry.item.change.resourceId} changed after it was written, so compensation left the live buffer untouched.`,
          };
        }
        continue;
      }
      if (entry.before.revision === null && entry.before.content === "") {
        const workspaceId = owner?.workspaceId ?? contextWorkspaceId(input.context);
        const removed = await deps.deleteDisk({
          workspaceId,
          resourceId: entry.item.change.resourceId,
          expectedRevision: entry.item.result?.revision ?? "",
          token: await diskToken(deps, workspaceId),
          operationId: `${operationId}:compensate`,
        });
        entry.item.result = removed.status === "deleted"
          ? {
              path: entry.item.change.resourceId,
              target: "disk",
              status: "compensated",
              message: `${entry.item.change.resourceId} was removed after a later path failed.`,
            }
          : {
              path: entry.item.change.resourceId,
              target: "disk",
              status: "needs-attention",
              message: `${entry.item.change.resourceId} changed after it was written, so compensation left disk untouched.`,
            };
        continue;
      }
      const workspaceId = owner?.workspaceId ?? contextWorkspaceId(input.context);
      const restored = await deps.writeDisk({
        workspaceId,
        resourceId: entry.item.change.resourceId,
        content: entry.before.content,
        encoding: "utf-8",
        bom: false,
        expectedRevision: entry.item.result?.revision ?? null,
        token: await diskToken(deps, workspaceId),
        operationId: `${operationId}:compensate`,
      });
      entry.item.result = restored.status === "written"
        ? pathResult({
            path: entry.item.change.resourceId,
            target: "disk",
            status: "compensated",
            revision: restored.revision,
            message: `${entry.item.change.resourceId} was restored on disk after a later path failed.`,
          })
        : {
            path: entry.item.change.resourceId,
            target: "disk",
            status: "needs-attention",
            message: `${entry.item.change.resourceId} changed after it was written, so compensation left disk untouched.`,
          };
    }
    applied.length = 0;
  };

  let failed = false;
  if (toApplySurface.length > 0 && owner && publication?.registrationId) {
    try {
      input.signal?.throwIfAborted();
      const receipts = await deps.requestSurfaceOperation({
        action: "apply",
        generation: owner.generation,
        operationId,
        ownerId: owner.ownerId,
        registrationId: publication.registrationId,
        workspaceId: owner.workspaceId,
        targets: toApplySurface.map((item) => {
          const binding = item.binding!;
          const inspect = item.inspect!;
          return {
            baseRevision: inspect.baseRevision,
            bufferHash: binding.bufferHash!,
            documentInstanceId: binding.documentInstanceId!,
            encoding: binding.encoding ?? inspect.encoding,
            bom: binding.bom ?? inspect.bom,
            lineEnding: binding.lineEnding ?? "lf",
            localEditRevision: inspect.localEditRevision,
            newText: item.newText!,
            resource: { workspaceId: owner.workspaceId, resourceId: item.change.resourceId },
          };
        }),
      }, input.signal ? { signal: input.signal } : {});
      const byPath = new Map(receipts.map((receipt) => [receipt.resource.resourceId, receipt]));
      for (const item of toApplySurface) {
        const receipt = [...byPath.entries()].find(([path]) => sameResource(path, item.change.resourceId))?.[1];
        if (receipt?.status === "applied" && receipt.afterLocalEditRevision !== undefined) {
          item.result = {
            path: item.change.resourceId,
            target: "surface",
            status: "applied",
            revision: `surface-draft:${input.context.source === "surface" && input.context.snapshot.status === "ready"
              ? input.context.snapshot.ref
              : "applied"}:${receipt.afterLocalEditRevision}`,
          };
          applied.push({ kind: "surface", item, receipt });
          continue;
        }
        item.result = pathResult({
          path: item.change.resourceId,
          target: "surface",
          status: "conflict",
          revision: item.inspect?.revision,
          message: receipt?.message
            ?? `${item.change.resourceId} could not be written to the editor buffer.`,
        });
        failed = true;
        break;
      }
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      for (const item of toApplySurface) {
        if (!item.result) {
          item.result = pathResult({
            path: item.change.resourceId,
            target: "surface",
            status: "conflict",
            revision: item.inspect?.revision,
            message: /stale|changed|disconnected|binding/iu.test(message)
              ? `${item.change.resourceId} changed in the editor after this turn fixed its draft. `
                + "The live buffer was left untouched and nothing was written to disk."
              : message,
          });
        }
      }
    }
    if (failed) await compensate();
  }

  if (!failed && toApplyDisk.length > 0) {
    const workspaceId = owner?.workspaceId
      ?? (input.context.source === "surface" ? input.context.workspaceId : "");
    const token = await diskToken(deps, workspaceId);
    for (const item of toApplyDisk) {
      input.signal?.throwIfAborted();
      if (item.change.action === "delete") {
        const current = await deps.readDisk(workspaceId, item.change.resourceId);
        if (current.status !== "ready" || !current.revision) {
          item.result = {
            path: item.change.resourceId,
            target: "disk",
            status: current.status === "missing" ? "conflict" : "unavailable",
            message: `${item.change.resourceId} is not a writable text file on disk.`,
          };
          failed = true;
          await compensate();
          break;
        }
        const deleted = await deps.deleteDisk({
          workspaceId,
          resourceId: item.change.resourceId,
          expectedRevision: current.revision,
          token,
          operationId,
        });
        if (deleted.status !== "deleted") {
          item.result = {
            path: item.change.resourceId,
            target: "disk",
            status: deleted.status === "conflict" ? "conflict" : "unavailable",
            message: deleted.message ?? `${item.change.resourceId} could not be deleted on disk.`,
          };
          failed = true;
          await compensate();
          break;
        }
        item.diskBefore = { content: current.content ?? "", revision: current.revision };
        item.result = { path: item.change.resourceId, target: "disk", status: "applied" };
        applied.push({ kind: "disk", item, before: item.diskBefore });
        continue;
      }
      let nextText = item.change.content;
      const current = await deps.readDisk(workspaceId, item.change.resourceId);
      if (item.change.action === "edit") {
        if (current.status !== "ready" || typeof current.content !== "string") {
          item.result = {
            path: item.change.resourceId,
            target: "disk",
            status: "conflict",
            message: `${item.change.resourceId} is not a writable text file on disk.`,
          };
          failed = true;
          await compensate();
          break;
        }
        try {
          nextText = applyTextEdits(current.content, item.change.edits ?? []);
        } catch (error) {
          item.result = {
            path: item.change.resourceId,
            target: "disk",
            status: "conflict",
            message: error instanceof Error ? error.message : String(error),
          };
          failed = true;
          await compensate();
          break;
        }
      }
      if (typeof nextText !== "string") {
        item.result = {
          path: item.change.resourceId,
          target: "disk",
          status: "unavailable",
          message: "write requires text content",
        };
        failed = true;
        await compensate();
        break;
      }
      if (isBinaryText(nextText) || current.status === "binary") {
        item.result = {
          path: item.change.resourceId,
          target: "disk",
          status: "unavailable",
          message: `${item.change.resourceId} is not a text file.`,
        };
        failed = true;
        await compensate();
        break;
      }
      const written = await deps.writeDisk({
        workspaceId,
        resourceId: item.change.resourceId,
        content: nextText,
        encoding: "utf-8",
        bom: false,
        expectedRevision: current.status === "ready" ? current.revision ?? null : null,
        token,
        operationId,
      });
      if (written.status !== "written") {
        item.result = {
          path: item.change.resourceId,
          target: "disk",
          status: written.status === "conflict" ? "conflict" : "unavailable",
          message: written.message ?? `${item.change.resourceId} could not be written on disk.`,
        };
        failed = true;
        await compensate();
        break;
      }
      item.diskBefore = {
        content: current.status === "ready" ? current.content ?? "" : "",
        revision: current.status === "ready" ? current.revision ?? null : null,
      };
      item.result = pathResult({
        path: item.change.resourceId,
        target: "disk",
        status: "applied",
        revision: written.revision,
      });
      applied.push({ kind: "disk", item, before: item.diskBefore });
    }
  } else if (failed) {
    for (const item of toApplyDisk) {
      if (!item.result) {
        item.result = {
          path: item.change.resourceId,
          target: "disk",
          status: "conflict",
          message: `${item.change.resourceId} was not written because an earlier path in this mutation failed.`,
        };
      }
    }
  }

  const result = summarize(planned, operationId);
  const record: AgentMutationRecord = {
    operationId,
    sessionId: input.sessionId,
    workspaceId: owner?.workspaceId ?? contextWorkspaceId(input.context),
    targetKinds: Object.fromEntries(planned.map((item) => [
      item.change.resourceId,
      item.result?.target ?? (item.class === "disk" ? "disk" : "surface"),
    ])),
    results: result.status === "disk" ? [] : result.results,
  };
  return { result, record };
}

const diskToken = async (
  deps: SurfaceMutationDependencies,
  workspaceId: string,
): Promise<MutationToken> => {
  const state = await deps.inspectWorkspace(workspaceId);
  return {
    workspaceId,
    epoch: state.epoch,
    owner: { kind: "harness", id: "agent-surface-write" },
  };
};
