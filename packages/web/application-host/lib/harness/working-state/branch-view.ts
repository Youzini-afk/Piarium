import type { WorkingBranchPathOrigin } from "@piarium/protocol";
import type { RecoveryState } from "./types.js";
import type { WorkingStateStore } from "./working-state-store.js";

export interface BranchViewEntry {
  path: string;
  kind: "file" | "directory";
  revision?: string;
}

export interface BranchViewFile {
  path: string;
  bytes: Buffer;
  origin: WorkingBranchPathOrigin;
  revision: string;
}

export interface ResolvedBranchPath {
  path: string;
  state: RecoveryState;
  origin: WorkingBranchPathOrigin;
  revision: string;
}

const normalizeRelative = (value: string): string => {
  const raw = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!raw || raw === ".") return "";
  const segments = raw.split("/").filter((segment) => segment && segment !== ".");
  if (raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || segments.includes("..")) {
    throw new Error(`Invalid branch view path: ${value}`);
  }
  return segments.join("/");
};

const isTextBytes = (bytes: Buffer): boolean => {
  if (bytes.includes(0)) return false;
  try {
    bytes.toString("utf8");
    return true;
  } catch {
    return false;
  }
};

const descendantOf = (file: string, root: string): boolean => (
  !root || file === root || file.startsWith(`${root}/`)
);

const hiddenByTombstone = (states: Record<string, RecoveryState>, file: string): boolean => {
  if (states[file]?.kind === "missing") return true;
  let parent = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  while (parent) {
    if (states[parent]?.kind === "missing") return true;
    parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
  }
  return false;
};

export const branchViewRevision = (branchId: string, revision: number, origin: WorkingBranchPathOrigin): string => (
  `working-branch:${branchId}@${revision}:${origin}`
);

export function listBranchView(
  states: Record<string, RecoveryState>,
  root: string,
  options: { branchId: string; revision: number; immediate?: boolean },
): BranchViewEntry[] {
  const normalizedRoot = normalizeRelative(root);
  const entries = new Map<string, BranchViewEntry>();
  const addDirectory = (relative: string): void => {
    const path = relative || ".";
    if (!entries.has(path)) {
      entries.set(path, { path, kind: "directory", revision: branchViewRevision(options.branchId, options.revision, "base") });
    }
  };
  if (!normalizedRoot || states[normalizedRoot]?.kind === "directory") addDirectory(normalizedRoot || ".");
  if (normalizedRoot && hiddenByTombstone(states, normalizedRoot)) return [];
  if (normalizedRoot && states[normalizedRoot]?.kind === "regular-file") {
    return [{
      path: ".",
      kind: "file",
      revision: branchViewRevision(options.branchId, options.revision, "base"),
    }];
  }

  for (const [file, state] of Object.entries(states)) {
    if (!descendantOf(file, normalizedRoot) || hiddenByTombstone(states, file)) continue;
    if (state.kind === "missing") continue;
    const relative = normalizedRoot ? (file === normalizedRoot ? "." : file.slice(normalizedRoot.length + 1)) : file;
    if (!relative) continue;
    if (options.immediate && relative.includes("/")) {
      const child = relative.slice(0, relative.indexOf("/"));
      addDirectory(child);
      continue;
    }
    if (state.kind === "directory") {
      addDirectory(relative);
      continue;
    }
    if (state.kind === "regular-file" || state.kind === "symlink" || state.kind === "unsupported") {
      entries.set(relative, {
        path: relative,
        kind: "file",
        revision: branchViewRevision(options.branchId, options.revision, "base"),
      });
      if (!options.immediate) {
        let ancestor = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
        while (ancestor) {
          addDirectory(ancestor);
          ancestor = ancestor.includes("/") ? ancestor.slice(0, ancestor.lastIndexOf("/")) : "";
        }
      }
    }
  }
  return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
}

export function resolveBranchPath(
  store: Pick<WorkingStateStore, "effectiveState" | "pathOrigin" | "getBranch">,
  branchId: string,
  file: string,
  revision?: number,
): ResolvedBranchPath | null {
  const states = store.effectiveState(branchId, revision);
  const branch = store.getBranch(branchId);
  if (!states || !branch) return null;
  const path = normalizeRelative(file);
  const origin = store.pathOrigin(branchId, path)
    ?? (branch.draftBasePaths.includes(path) ? "draft-base" : "base");
  if (hiddenByTombstone(states, path)) {
    return {
      path,
      state: { kind: "missing" },
      origin,
      revision: branchViewRevision(branchId, revision ?? branch.headRevision, origin),
    };
  }
  const state = states[path] ?? (path === "" ? { kind: "directory" as const } : { kind: "missing" as const });
  return {
    path,
    state,
    origin,
    revision: branchViewRevision(branchId, revision ?? branch.headRevision, origin),
  };
}

export async function readBranchFile(
  store: Pick<WorkingStateStore, "effectiveState" | "pathOrigin" | "getBranch" | "getObject">,
  branchId: string,
  file: string,
  revision?: number,
): Promise<BranchViewFile | { missing: true; path: string; revision: string; origin: WorkingBranchPathOrigin } | { unavailable: string }> {
  const resolved = resolveBranchPath(store, branchId, file, revision);
  if (!resolved) return { unavailable: `Working branch ${branchId} is unavailable` };
  if (resolved.state.kind === "missing") {
    return { missing: true, path: resolved.path, revision: resolved.revision, origin: resolved.origin };
  }
  if (resolved.state.kind === "directory") {
    return { unavailable: `${resolved.path || "."} is a directory` };
  }
  if (resolved.state.kind === "unsupported") {
    return { unavailable: `${resolved.path} is not a readable file in this branch` };
  }
  if (resolved.state.kind === "symlink") {
    const target = resolved.state.symlinkTarget;
    if (!target || target.startsWith("/") || /^[A-Za-z]:/.test(target) || target.includes("..")) {
      return { unavailable: `${resolved.path} is a symlink that cannot be resolved inside the branch view` };
    }
    const parent = resolved.path.includes("/") ? resolved.path.slice(0, resolved.path.lastIndexOf("/")) : "";
    const joined = parent ? `${parent}/${target}` : target;
    return readBranchFile(store, branchId, joined, revision);
  }
  const bytes = await store.getObject(resolved.state.objectHash);
  if (!bytes) return { unavailable: `Working-state object is missing for ${resolved.path}` };
  return {
    path: resolved.path,
    bytes,
    origin: resolved.origin,
    revision: resolved.revision,
  };
}

export async function listBranchTextFiles(
  store: Pick<WorkingStateStore, "effectiveState" | "pathOrigin" | "getBranch" | "getObject">,
  branchId: string,
  prefixes: readonly string[],
  revision?: number,
): Promise<Array<BranchViewFile & { text: string }>> {
  const states = store.effectiveState(branchId, revision);
  const branch = store.getBranch(branchId);
  if (!states || !branch) return [];
  const roots = prefixes.length > 0 ? prefixes.map(normalizeRelative) : [""];
  const files: Array<BranchViewFile & { text: string }> = [];
  for (const [file, state] of Object.entries(states)) {
    if (state.kind !== "regular-file" || hiddenByTombstone(states, file)) continue;
    if (!roots.some((root) => descendantOf(file, root))) continue;
    const bytes = await store.getObject(state.objectHash);
    if (!bytes || !isTextBytes(bytes)) continue;
    const origin = store.pathOrigin(branchId, file) ?? "base";
    files.push({
      path: file,
      bytes,
      text: bytes.toString("utf8"),
      origin,
      revision: branchViewRevision(branchId, revision ?? branch.headRevision, origin),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}
