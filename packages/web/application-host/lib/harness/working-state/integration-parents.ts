import type { ThreadSurfaceParent } from "@piarium/protocol";
import { sameState, type RecoveryState } from "../../recovery/journal-files.js";

export interface DirtyBufferInspectResource {
  resourceId: string;
  baseRevision: string | null;
  localEditRevision: number;
  ownerId: string;
}

/** Matches Documents `DirtyBufferPublication` without importing authority. */
export interface DirtyBufferInspectPublication {
  ownerId: string;
  resources: Array<{
    baseRevision: string | null;
    localEditRevision: number;
    resource: { resourceId: string };
  }>;
}

export type IntegrationParentTarget = "disk" | "surface" | "unavailable";

export const dirtyResourceMap = (
  publications: readonly DirtyBufferInspectPublication[],
): Map<string, DirtyBufferInspectResource> => {
  const found = new Map<string, DirtyBufferInspectResource>();
  for (const publication of publications) {
    for (const resource of publication.resources) {
      const resourceId = resource.resource.resourceId;
      if (!found.has(resourceId)) {
        found.set(resourceId, {
          resourceId,
          baseRevision: resource.baseRevision,
          localEditRevision: resource.localEditRevision,
          ownerId: publication.ownerId,
        });
      }
    }
  }
  return found;
};

export const classifyIntegrationTarget = (input: {
  draftBasePath: boolean;
  dirty?: DirtyBufferInspectResource;
  inspectDirtyBuffers: boolean;
  parentState: RecoveryState;
  baseState: RecoveryState;
  childState: RecoveryState;
}): IntegrationParentTarget => {
  if (input.dirty) return "surface";
  if (input.inspectDirtyBuffers) return "disk";
  if (
    input.draftBasePath
    && !sameState(input.parentState, input.baseState)
    && !sameState(input.parentState, input.childState)
  ) {
    return "surface";
  }
  return "disk";
};

export const parentRevisionOf = (state: RecoveryState, dirty?: DirtyBufferInspectResource): string => {
  if (dirty) return `surface:${dirty.localEditRevision}:${dirty.baseRevision ?? "none"}`;
  if (state.kind === "regular-file") return `disk:${state.objectHash}`;
  if (state.kind === "symlink") return `symlink:${state.symlinkTarget}`;
  if (state.kind === "missing") return "missing";
  if (state.kind === "directory") return `directory:${state.mode ?? ""}`;
  return `${state.kind}`;
};

export const surfaceParentContent = (
  path: string,
  supplied: readonly ThreadSurfaceParent[] | undefined,
): ThreadSurfaceParent | undefined => supplied?.find((entry) => entry.resourceId === path);
