import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PiWorkContextCommit, PiWorkContextSnapshot } from "@varin/protocol";
import { HostError } from "./errors.js";

export const VARIN_WORK_CONTEXT_ENTRY_TYPE = "varin.work-context/v1";

type JournalManager = Pick<SessionManager, "getBranch" | "getLeafId" | "appendCustomEntry">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseContext(value: unknown): NonNullable<PiWorkContextSnapshot["context"]> {
  if (!isRecord(value)
    || typeof value.workspaceId !== "string" || !value.workspaceId
    || typeof value.authorityRoot !== "string" || !value.authorityRoot
    || typeof value.sessionRoot !== "string" || !value.sessionRoot
    || typeof value.operationDir !== "string"
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || (value.queryScope !== null && (!Array.isArray(value.queryScope)
      || !value.queryScope.every((path) => typeof path === "string")))) {
    throw new HostError("session_work_context_corrupt", "The active branch contains an invalid work-context entry");
  }
  return {
    workspaceId: value.workspaceId,
    authorityRoot: value.authorityRoot,
    sessionRoot: value.sessionRoot,
    operationDir: value.operationDir,
    queryScope: value.queryScope === null ? null : [...value.queryScope] as string[],
    revision: Number(value.revision),
  };
}

/** Read only the active branch; a sibling branch's selection is never inherited. */
export function readSessionWorkContext(manager: JournalManager): PiWorkContextSnapshot {
  const branch = manager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "custom" && entry.customType === VARIN_WORK_CONTEXT_ENTRY_TYPE) {
      return { leafId: manager.getLeafId(), entryId: entry.id, context: parseContext(entry.data) };
    }
  }
  return { leafId: manager.getLeafId(), entryId: null, context: null };
}

/** Exact-leaf CAS prevents a branch navigation or append from redirecting a validated Host selection. */
export function commitSessionWorkContext(manager: JournalManager, input: PiWorkContextCommit): PiWorkContextSnapshot {
  const current = readSessionWorkContext(manager);
  if (current.leafId !== input.expectedLeafId || (current.context?.revision ?? 0) !== input.expectedRevision) {
    throw new HostError("session_work_context_conflict", "The active conversation branch changed before the work context was committed", { retryable: true });
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
    || input.context.revision !== input.expectedRevision + 1) {
    throw new HostError("invalid_params", "Work-context revision must advance exactly once");
  }
  const context = parseContext(input.context);
  if (current.context && (current.context.workspaceId !== context.workspaceId
    || current.context.authorityRoot !== context.authorityRoot
    || current.context.sessionRoot !== context.sessionRoot)) {
    throw new HostError("session_work_context_conflict", "Work-context authority binding changed", { retryable: false });
  }
  const leafId = manager.appendCustomEntry(VARIN_WORK_CONTEXT_ENTRY_TYPE, context);
  return { leafId, entryId: leafId, context };
}
