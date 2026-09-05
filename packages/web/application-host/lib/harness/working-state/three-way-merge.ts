import type {
  RecoveryState,
  RegularFileState,
  SymlinkState,
  ThreeWayMergePlan,
  ThreeWayPathDecision,
  ThreeWayPathPlan,
} from "./types.js";
import type { ThreadDiffStats } from "@piarium/protocol";

export interface TextMergeResult {
  clean: boolean;
  text: string;
}

export const isBinaryBuffer = (buffer: Buffer): boolean => {
  const checkLen = Math.min(buffer.length, 8000);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
};

const splitLines = (text: string): { lines: string[]; eol: string } => {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  return { lines, eol };
};

/**
 * Computes the Longest Common Subsequence of lines between a and b.
 * Returns array of [aIndex, bIndex] matches.
 */
export const lcsMatches = (a: string[], b: string[]): Array<[number, number]> => {
  const m = a.length;
  const n = b.length;
  // If either is empty, no matches
  if (m === 0 || n === 0) return [];

  // Standard DP matrix
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (a[i] === b[j]) {
        dp[i + 1]![j + 1] = dp[i]![j]! + 1;
      } else {
        dp[i + 1]![j + 1] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
  }

  // Backtrace
  const matches: Array<[number, number]> = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      matches.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      i--;
    } else {
      j--;
    }
  }
  matches.reverse();
  return matches;
};

interface ChunkMapping {
  baseStart: number;
  baseEnd: number;
  lines: string[];
}

const computeChunks = (baseLines: string[], targetLines: string[]): ChunkMapping[] => {
  const matches = lcsMatches(baseLines, targetLines);
  const chunks: ChunkMapping[] = [];

  let lastBase = 0;
  let lastTarget = 0;

  for (const [bIdx, tIdx] of matches) {
    if (bIdx > lastBase || tIdx > lastTarget) {
      chunks.push({
        baseStart: lastBase,
        baseEnd: bIdx,
        lines: targetLines.slice(lastTarget, tIdx),
      });
    }
    lastBase = bIdx + 1;
    lastTarget = tIdx + 1;
  }

  if (lastBase < baseLines.length || lastTarget < targetLines.length) {
    chunks.push({
      baseStart: lastBase,
      baseEnd: baseLines.length,
      lines: targetLines.slice(lastTarget),
    });
  }

  return chunks;
};

/**
 * 3-way line-based text merge.
 * Returns merged text and clean flag. If conflicting, injects conflict markers.
 */
export const mergeText3Way = (
  baseText: string,
  parentText: string,
  childText: string,
  options: { parentLabel?: string; childLabel?: string } = {},
): TextMergeResult => {
  if (parentText === childText) return { clean: true, text: parentText };
  if (parentText === baseText) return { clean: true, text: childText };
  if (childText === baseText) return { clean: true, text: parentText };

  const { lines: baseLines, eol } = splitLines(baseText);
  const { lines: parentLines } = splitLines(parentText);
  const { lines: childLines } = splitLines(childText);

  const parentChunks = computeChunks(baseLines, parentLines);
  const childChunks = computeChunks(baseLines, childLines);

  const pLabel = options.parentLabel ?? "parent";
  const cLabel = options.childLabel ?? "child";

  let clean = true;
  const resultLines: string[] = [];

  // Align base line by line
  let bIdx = 0;
  let pChunkIdx = 0;
  let cChunkIdx = 0;

  while (bIdx <= baseLines.length) {
    const nextP = parentChunks[pChunkIdx];
    const nextC = childChunks[cChunkIdx];

    const pAffects = nextP && nextP.baseStart <= bIdx && bIdx <= nextP.baseEnd;
    const cAffects = nextC && nextC.baseStart <= bIdx && bIdx <= nextC.baseEnd;

    if (pAffects && cAffects) {
      // Overlapping changes
      const maxEnd = Math.max(nextP.baseEnd, nextC.baseEnd);
      // Gather all overlapping parent/child chunks up to maxEnd
      const pCombined: string[] = [...nextP.lines];
      pChunkIdx++;
      while (pChunkIdx < parentChunks.length && parentChunks[pChunkIdx]!.baseStart <= maxEnd) {
        pCombined.push(...parentChunks[pChunkIdx]!.lines);
        pChunkIdx++;
      }

      const cCombined: string[] = [...nextC.lines];
      cChunkIdx++;
      while (cChunkIdx < childChunks.length && childChunks[cChunkIdx]!.baseStart <= maxEnd) {
        cCombined.push(...childChunks[cChunkIdx]!.lines);
        cChunkIdx++;
      }

      if (pCombined.join(eol) === cCombined.join(eol)) {
        // Both made the exact same change
        resultLines.push(...pCombined);
      } else {
        clean = false;
        resultLines.push(`<<<<<<< ${pLabel}`);
        resultLines.push(...pCombined);
        resultLines.push("=======");
        resultLines.push(...cCombined);
        resultLines.push(`>>>>>>> ${cLabel}`);
      }
      bIdx = maxEnd;
    } else if (pAffects) {
      resultLines.push(...nextP.lines);
      bIdx = nextP.baseEnd;
      pChunkIdx++;
    } else if (cAffects) {
      resultLines.push(...nextC.lines);
      bIdx = nextC.baseEnd;
      cChunkIdx++;
    } else {
      if (bIdx < baseLines.length) {
        resultLines.push(baseLines[bIdx]!);
      }
      bIdx++;
    }
  }

  return { clean, text: resultLines.join(eol) };
};

export const statesEqual = (a?: RecoveryState | null, b?: RecoveryState | null): boolean => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "missing") return true;
  if (a.kind === "directory") return a.mode === (b as typeof a).mode;
  if (a.kind === "symlink") {
    return a.symlinkTarget === (b as SymlinkState).symlinkTarget;
  }
  if (a.kind === "regular-file") {
    return a.objectHash === (b as RegularFileState).objectHash && a.mode === (b as RegularFileState).mode;
  }
  return false;
};

export interface PathMergeContext {
  path: string;
  baseState: RecoveryState;
  parentState: RecoveryState;
  childState: RecoveryState;
  readContent(state: RecoveryState): Promise<Buffer | null>;
}

export const planThreeWayPath = async (ctx: PathMergeContext): Promise<ThreeWayPathPlan> => {
  const { path, baseState, parentState, childState, readContent } = ctx;

  // 1. parentNow == child
  if (statesEqual(parentState, childState)) {
    return {
      path,
      decision: "identical",
      baseState,
      parentState,
      childState,
      isText: childState.kind === "regular-file",
    };
  }

  // 2. parentNow == base -> cleanly apply child
  if (statesEqual(parentState, baseState)) {
    return {
      path,
      decision: "apply-child",
      baseState,
      parentState,
      childState,
      isText: childState.kind === "regular-file",
    };
  }

  // 3. child == base -> keep parent (parent was edited, child did not touch)
  if (statesEqual(childState, baseState)) {
    return {
      path,
      decision: "keep-parent",
      baseState,
      parentState,
      childState,
      isText: parentState.kind === "regular-file",
    };
  }

  // 4. Both sides diverged from base
  // Check if both are regular files
  if (parentState.kind === "regular-file" && childState.kind === "regular-file") {
    const parentBuf = await readContent(parentState);
    const childBuf = await readContent(childState);
    const baseBuf = baseState.kind === "regular-file" ? await readContent(baseState) : Buffer.from("");

    if (!parentBuf || !childBuf) {
      return {
        path,
        decision: "conflict",
        conflictReason: "Unable to read file content for three-way merge",
        baseState,
        parentState,
        childState,
        isText: false,
      };
    }

    const isBinary = isBinaryBuffer(parentBuf) || isBinaryBuffer(childBuf) || isBinaryBuffer(baseBuf ?? Buffer.from(""));
    if (isBinary) {
      return {
        path,
        decision: "conflict",
        conflictReason: "Binary file modified on both sides",
        baseState,
        parentState,
        childState,
        isText: false,
      };
    }

    const baseStr = (baseBuf ?? Buffer.from("")).toString("utf8");
    const parentStr = parentBuf.toString("utf8");
    const childStr = childBuf.toString("utf8");

    const merged = mergeText3Way(baseStr, parentStr, childStr);
    if (merged.clean) {
      return {
        path,
        decision: "merge-clean",
        baseState,
        parentState,
        childState,
        mergedText: merged.text,
        isText: true,
      };
    }

    return {
      path,
      decision: "conflict",
      conflictMarkers: merged.text,
      conflictReason: "Text divergence with conflicting chunks",
      baseState,
      parentState,
      childState,
      isText: true,
    };
  }

  // Non-text divergence (type mismatch, delete vs edit, symlink divergence)
  let reason = "Structural divergence";
  if (parentState.kind === "missing" && childState.kind !== "missing") {
    reason = "File deleted in parent but modified in child";
  } else if (parentState.kind !== "missing" && childState.kind === "missing") {
    reason = "File modified in parent but deleted in child";
  } else if (parentState.kind === "symlink" && childState.kind === "symlink") {
    reason = "Symbolic link target changed to different destinations";
  } else if (parentState.kind !== childState.kind) {
    reason = `Type conflict: parent is ${parentState.kind}, child is ${childState.kind}`;
  }

  return {
    path,
    decision: "conflict",
    conflictReason: reason,
    baseState,
    parentState,
    childState,
    isText: false,
  };
};

export interface BuildPlanInput {
  operationId: string;
  workspaceId: string;
  threadId: string;
  resultRevision: number | string;
  allPaths: string[];
  baseState: Record<string, RecoveryState>;
  parentState: Record<string, RecoveryState>;
  childState: Record<string, RecoveryState>;
  readContent(state: RecoveryState): Promise<Buffer | null>;
}

export const buildThreeWayMergePlan = async (input: BuildPlanInput): Promise<ThreeWayMergePlan> => {
  const paths: ThreeWayPathPlan[] = [];
  const appliedPaths: string[] = [];
  const conflictPaths: string[] = [];
  let insertions = 0;
  let deletions = 0;

  for (const p of input.allPaths) {
    const bState = input.baseState[p] ?? { kind: "missing" };
    const pState = input.parentState[p] ?? { kind: "missing" };
    const cState = input.childState[p] ?? { kind: "missing" };

    const pathPlan = await planThreeWayPath({
      path: p,
      baseState: bState,
      parentState: pState,
      childState: cState,
      readContent: input.readContent,
    });

    paths.push(pathPlan);

    if (pathPlan.decision === "apply-child" || pathPlan.decision === "merge-clean") {
      appliedPaths.push(p);
      insertions += 1;
    } else if (pathPlan.decision === "conflict") {
      conflictPaths.push(p);
    }
  }

  const clean = conflictPaths.length === 0;
  const diffStats: ThreadDiffStats = {
    files: appliedPaths.length + conflictPaths.length,
    insertions,
    deletions,
  };

  return {
    operationId: input.operationId,
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    resultRevision: input.resultRevision,
    clean,
    paths,
    appliedPaths,
    conflictPaths,
    diffStats,
  };
};
