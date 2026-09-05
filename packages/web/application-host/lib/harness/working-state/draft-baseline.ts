import type { RecoveryState, RegularFileState, WorkingBranch } from "./types.js";
import type { WorkingStateStore } from "./working-state-store.js";

export interface EditorDraft {
  path: string;
  content?: string | Buffer | null | undefined;
  mode?: number | undefined;
}

export interface OverlayDraftsOptions {
  baseState: Record<string, RecoveryState>;
  drafts: EditorDraft[] | Record<string, EditorDraft | string | Buffer | null>;
  putObject: (bytes: Buffer) => Promise<{ hash: string; byteLength: number }>;
}

export interface DraftBaselineResult {
  effectiveState: Record<string, RecoveryState>;
  modifiedPaths: string[];
  deletedPaths: string[];
  addedPaths: string[];
  changedPaths: string[];
}

const normalizeRelPath = (p: string): string => p.replace(/\\/g, "/");

/**
 * Overlays in-memory editor dirty drafts onto a disk or git baseline.
 * Produces the coherent effective RecoveryState dictionary.
 */
export async function overlayDraftsOnBaseline(
  options: OverlayDraftsOptions,
): Promise<DraftBaselineResult> {
  const { baseState, putObject } = options;
  const effectiveState: Record<string, RecoveryState> = { ...baseState };

  const modifiedPaths: string[] = [];
  const deletedPaths: string[] = [];
  const addedPaths: string[] = [];

  // Normalize drafts input into EditorDraft[]
  const draftList: EditorDraft[] = Array.isArray(options.drafts)
    ? options.drafts
    : Object.entries(options.drafts).map(([p, val]): EditorDraft => {
        if (val && typeof val === "object" && !Buffer.isBuffer(val) && "content" in val) {
          const draftObj = val as EditorDraft;
          const entry: EditorDraft = {
            path: draftObj.path ?? p,
          };
          if (draftObj.content !== undefined) entry.content = draftObj.content;
          if (draftObj.mode !== undefined) entry.mode = draftObj.mode;
          return entry;
        }
        return { path: p, content: val as string | Buffer | null };
      });

  for (const draft of draftList) {
    const rel = normalizeRelPath(draft.path);
    const existing = baseState[rel];

    if (draft.content === null) {
      // Draft represents file deletion
      effectiveState[rel] = { kind: "missing" };
      if (existing && existing.kind !== "missing") {
        deletedPaths.push(rel);
      }
      continue;
    }

    if (draft.content !== undefined) {
      const bytes = typeof draft.content === "string"
        ? Buffer.from(draft.content, "utf8")
        : draft.content;

      const { hash, byteLength } = await putObject(bytes);
      const existingMode = existing && existing.kind === "regular-file" ? existing.mode : undefined;
      const fileMode = draft.mode ?? existingMode;

      const newState: RegularFileState = {
        kind: "regular-file",
        objectHash: hash,
        byteLength,
        ...(fileMode !== undefined ? { mode: fileMode } : {}),
      };

      effectiveState[rel] = newState;

      if (existing && existing.kind !== "missing") {
        modifiedPaths.push(rel);
      } else {
        addedPaths.push(rel);
      }
    }
  }

  const changedPaths = [...addedPaths, ...modifiedPaths, ...deletedPaths];

  return {
    effectiveState,
    modifiedPaths,
    deletedPaths,
    addedPaths,
    changedPaths,
  };
}

/**
 * Helper to initialize a WorkingBranch in WorkingStateStore with dirty editor drafts already merged.
 */
export async function createBranchWithDraftBaseline(
  store: WorkingStateStore,
  workspaceId: string,
  branchId: string,
  baseState: Record<string, RecoveryState>,
  drafts: EditorDraft[] | Record<string, EditorDraft | string | Buffer | null>,
  baseRef?: string,
): Promise<WorkingBranch> {
  const { effectiveState, changedPaths } = await overlayDraftsOnBaseline({
    baseState,
    drafts,
    putObject: (bytes) => store.putObject(bytes),
  });

  const branch = await store.createBranch(workspaceId, branchId, baseState, baseRef);

  if (changedPaths.length > 0) {
    // Publish the draft overlay as the first immutable revision; callers that
    // only need the branch can still read the returned branch baseline.
    await store.publishStates(branchId, effectiveState, changedPaths);
  }

  return store.getBranch(branchId) ?? branch;
}
