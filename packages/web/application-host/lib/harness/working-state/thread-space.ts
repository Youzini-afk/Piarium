import { statfs } from "node:fs/promises";
import type { HarnessWorktreeBudget, Thread, ThreadOccupancy, ThreadSpaceMeasurement, WorkspaceThreadSpace } from "@piarium/protocol";
import type { RecoveryState } from "./types.js";
import type { WorkingStateStore } from "./working-state-store.js";

const emptyMeasurement = (unknown = false): ThreadSpaceMeasurement => ({
  logicalBytes: unknown ? null : 0,
  allocatedBytes: unknown ? null : 0,
  unknown,
});

const addHash = (
  hashes: Map<string, number | null>,
  state: RecoveryState | undefined,
): void => {
  if (state?.kind !== "regular-file") return;
  if (!hashes.has(state.objectHash)) hashes.set(state.objectHash, state.byteLength);
};

export const collectDraftBaselineHashes = (
  store: WorkingStateStore,
  draftBaselineId: string | null | undefined,
): Map<string, number | null> => {
  const hashes = new Map<string, number | null>();
  if (!draftBaselineId) return hashes;
  const baseline = store.getDraftBaselineRecord(draftBaselineId);
  if (!baseline) return hashes;
  for (const state of Object.values(baseline.pathStates)) addHash(hashes, state);
  return hashes;
};

export const mergeHashMaps = (
  ...groups: Array<Map<string, number | null>>
): Map<string, number | null> => {
  const merged = new Map<string, number | null>();
  for (const group of groups) {
    for (const [hash, size] of group) {
      if (!merged.has(hash)) merged.set(hash, size);
      else if (merged.get(hash) === null || size === null) merged.set(hash, null);
    }
  }
  return merged;
};

export const assembleKeepReasons = (input: {
  thread: Thread;
  runActive: boolean;
  unfinishedIntegration: string[];
  writerReason?: string;
  matchesResult: boolean | null;
  hasPublishedResult: boolean;
  hasActiveCommands: boolean;
}): string[] => {
  const reasons: string[] = [];
  if (input.thread.keepWorktree) reasons.push("User requested keep_worktree");
  if (input.runActive) reasons.push("Thread still has an active run");
  if (input.thread.lifecycle === "active" || input.thread.lifecycle === "queued") {
    reasons.push(`Thread lifecycle is ${input.thread.lifecycle}`);
  }
  reasons.push(...input.unfinishedIntegration);
  if (input.writerReason) reasons.push(input.writerReason);
  if (input.hasActiveCommands) reasons.push("A background command is still using this directory");
  if (!input.hasPublishedResult) reasons.push("No published result is available to rebuild from");
  if (input.matchesResult === false) reasons.push("Directory content does not match the published result");
  if (input.matchesResult === null && input.thread.worktree?.materialized !== false && input.thread.worktree) {
    reasons.push("Unable to verify directory against the published result");
  }
  return [...new Set(reasons)];
};

export const collectBranchObjectHashes = (
  store: WorkingStateStore,
  branchId: string,
): Map<string, number | null> => {
  const hashes = new Map<string, number | null>();
  const branch = store.getBranch(branchId);
  if (branch) {
    for (const state of Object.values(branch.baseState)) addHash(hashes, state);
    for (const state of Object.values(branch.deltas)) addHash(hashes, state);
  }
  for (const result of store.listResults(branchId)) {
    for (const state of Object.values(result.baseStates)) addHash(hashes, state);
    for (const state of Object.values(result.pathStates)) addHash(hashes, state);
  }
  return hashes;
};

export const measurementFromHashes = (hashes: Map<string, number | null>): ThreadSpaceMeasurement => {
  let logical = 0;
  let unknown = false;
  for (const size of hashes.values()) {
    if (size === null || !Number.isFinite(size)) unknown = true;
    else logical += size;
  }
  return {
    logicalBytes: unknown ? null : logical,
    allocatedBytes: null,
    unknown,
  };
};

export const measureDirectory = async (directory: string): Promise<ThreadSpaceMeasurement> => {
  const { promises: fsPromises } = await import("node:fs");
  const path = await import("node:path");
  let logical = 0;
  let allocated = 0;
  let sawAllocated = false;
  let unknown = false;
  const scan = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        unknown = true;
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          await scan(full);
          continue;
        }
        const stat = await fsPromises.lstat(full);
        logical += stat.size;
        if ("blocks" in stat && typeof stat.blocks === "number" && stat.blocks > 0) {
          allocated += stat.blocks * 512;
          sawAllocated = true;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") unknown = true;
        else throw error;
      }
    }
  };
  await scan(directory);
  return {
    logicalBytes: unknown ? null : logical,
    allocatedBytes: sawAllocated ? allocated : null,
    unknown,
  };
};

export const readVolumeSpace = async (directory: string): Promise<{ freeBytes: number; totalBytes: number } | null> => {
  try {
    const stats = await statfs(directory);
    const bsize = Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * bsize;
    const totalBytes = Number(stats.blocks) * bsize;
    if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;
    return { freeBytes, totalBytes };
  } catch {
    return null;
  }
};

export const projectThreadOccupancy = (input: {
  thread: Thread;
  materialized: ThreadSpaceMeasurement;
  exclusive: Map<string, number | null>;
  shared: Map<string, number | null>;
  keepReasons: string[];
}): ThreadOccupancy => {
  const exclusiveObjects = measurementFromHashes(input.exclusive);
  const sharedObjects = measurementFromHashes(input.shared);
  const reclaimable = input.keepReasons.length === 0 && input.thread.worktree?.materialized !== false;
  return {
    threadId: input.thread.id,
    materialized: input.materialized,
    exclusiveObjects,
    sharedObjects,
    reclaimable,
    reclaimableLogicalBytes: reclaimable ? input.materialized.logicalBytes : 0,
    keepReasons: input.keepReasons,
  };
};

export const projectWorkspaceSpace = (
  workspaceId: string,
  threads: ThreadOccupancy[],
  uniqueObjects: ThreadSpaceMeasurement,
  budget: HarnessWorktreeBudget | undefined,
  volume: { freeBytes: number; totalBytes: number } | null,
): WorkspaceThreadSpace => {
  let materializedLogical = 0;
  let materializedUnknown = false;
  for (const thread of threads) {
    if (thread.materialized.unknown || thread.materialized.logicalBytes === null) materializedUnknown = true;
    else materializedLogical += thread.materialized.logicalBytes;
  }
  const overBudget = budget?.maxBytes !== undefined
    && !materializedUnknown
    && materializedLogical > budget.maxBytes;
  const freeRatio = volume ? volume.freeBytes / volume.totalBytes : null;
  const lowFree = budget?.minFreeRatio !== undefined && freeRatio !== null && freeRatio < budget.minFreeRatio;
  const status = overBudget
    ? "over-budget"
    : lowFree
      ? "low-free"
      : uniqueObjects.unknown || materializedUnknown || (budget && volume === null)
        ? "unknown"
        : "ok";
  return {
    workspaceId,
    threads,
    uniqueObjectLogicalBytes: uniqueObjects.logicalBytes,
    uniqueObjectUnknown: uniqueObjects.unknown,
    materializedLogicalBytes: materializedUnknown ? null : materializedLogical,
    ...(budget ? { budget } : {}),
    freeBytes: volume?.freeBytes ?? null,
    status,
    note: overBudget
      ? "User worktree budget is already exceeded by measured materialized occupancy"
      : lowFree
        ? "Free space ratio is below the user-configured minimum"
        : uniqueObjects.unknown || materializedUnknown
          ? "Some occupancy could not be measured; unknown sizes are not treated as zero"
          : "Occupancy distinguishes materialized directories from shared native objects; it is not an exact physical allocation",
  };
};
