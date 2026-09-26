import { constants, promises as fs } from "node:fs";
import path from "node:path";
import type {
  ContextDiscoverCandidate,
  ContextDiscoverParams,
  ContextDiscoverResult,
  ContextGetResult,
  ContextResetParams,
  ContextScopeParams,
  ContextSelectParams,
  HarnessWorkContextState,
} from "@varin/protocol";
import type { HarnessAuthorizedPath } from "./router.js";
import { HarnessServiceError } from "./service-error.js";

/**
 * RR2/D-328+: Host-owned per-session work context. The state lives on the
 * registered session entry; this module owns validation and mutation. Every
 * path crossing the boundary is re-checked against the actor's authorized
 * workspace scope — a context change can never widen access, only re-anchor
 * where relative tool paths resolve.
 */

/** Directory names that mark a directory as a discoverable project root. */
const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "CMakeLists.txt",
  "setup.py",
  "composer.json",
  "Gemfile",
  "mix.exs",
  "deno.json",
  "pubspec.yaml",
] as const;

/** Directories never descended into during discovery. */
const SCAN_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "out",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".idea",
  ".vscode",
  "__pycache__",
  "vendor",
]);

const DISCOVER_MAX_DEPTH = 3;
const DISCOVER_MAX_CANDIDATES = 200;
const DISCOVER_TIME_BUDGET_MS = 800;

export interface WorkContextDeps {
  /** Resolve a candidate against the actor's authorized scope (Host path authority). */
  authorize: (candidate: string, options: { allowMissing: boolean }) => Promise<HarnessAuthorizedPath | null>;
  /** Absolute authorized workspace root for the actor. */
  workspaceRoot: string;
  /** Absolute session launch directory (the initial operation dir). */
  sessionRoot: string;
  fs?: Pick<typeof fs, "access" | "readdir" | "stat">;
  now?: () => number;
  /** Reject work whose registered actor/session generation has been retired. */
  assertCurrent?: () => void;
}

const toRelativeRoot = (root: string, absolute: string): string => {
  const rel = path.relative(root, absolute);
  return rel === "" ? "" : rel.split(path.sep).join("/");
};

const resolveRelativeToRoot = (root: string, candidate: string): string => (
  path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate)
);

export function seedWorkContext(authorityRoot: string | undefined, sessionRoot: string): HarnessWorkContextState {
  // An invalid launch binding is an admission failure, never permission to
  // silently redirect relative writes to the workspace root.
  let operationDir = "";
  if (authorityRoot) {
    const rel = path.relative(authorityRoot, sessionRoot);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new HarnessServiceError("forbidden", "Session operation directory is outside its workspace authority");
    } else {
      operationDir = rel.split(path.sep).join("/");
    }
  }
  return { operationDir, queryScope: null, revision: 0 };
}

function assertExpectedRevision(state: HarnessWorkContextState, expected: number | undefined): void {
  if (expected === undefined) return;
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw new HarnessServiceError("invalid-params", "expectedRevision must be a non-negative safe integer");
  }
  if (expected !== state.revision) {
    throw new HarnessServiceError(
      "invalid-params",
      `work context changed concurrently (have revision ${state.revision}, expected ${expected}); re-read with context.get and retry`,
    );
  }
}

function result(state: HarnessWorkContextState, workspaceRoot: string): ContextGetResult {
  return {
    context: {
      operationDir: state.operationDir,
      queryScope: state.queryScope === null ? null : [...state.queryScope],
      revision: state.revision,
    },
    workspaceRoot,
  };
}

export function getWorkContext(state: HarnessWorkContextState, deps: Pick<WorkContextDeps, "workspaceRoot">): ContextGetResult {
  return result(state, deps.workspaceRoot);
}

/** Absolute operation dir for path resolution and shell anchoring. */
export function operationDirAbsolute(state: HarnessWorkContextState, workspaceRoot: string): string {
  return state.operationDir === "" ? workspaceRoot : path.resolve(workspaceRoot, state.operationDir);
}

/** Reauthorize journal state before activating an actor or accepting another tool request. */
export async function validateStoredWorkContext(
  state: HarnessWorkContextState,
  deps: WorkContextDeps,
): Promise<HarnessWorkContextState> {
  if (!Number.isSafeInteger(state.revision) || state.revision < 0
    || typeof state.operationDir !== "string"
    || (state.queryScope !== null && (!Array.isArray(state.queryScope)
      || !state.queryScope.every((item) => typeof item === "string")))) {
    throw new HarnessServiceError("unavailable", "Stored work context is malformed");
  }
  const operation = operationDirAbsolute(state, deps.workspaceRoot);
  let authorized: HarnessAuthorizedPath | null;
  try {
    authorized = await deps.authorize(operation, { allowMissing: false });
  } catch {
    throw new HarnessServiceError("unavailable", "Stored operation directory is missing or inaccessible");
  }
  if (!authorized || authorized.resourceId !== state.operationDir) {
    throw new HarnessServiceError("unavailable", "Stored operation directory is no longer authorized");
  }
  const fsx = deps.fs ?? fs;
  try {
    const stat = await fsx.stat(authorized.canonicalResourceId);
    if (!stat.isDirectory()) throw new Error("not a directory");
    await fsx.access(authorized.canonicalResourceId, constants.R_OK | constants.X_OK);
  } catch {
    throw new HarnessServiceError("unavailable", "Stored operation directory is missing or inaccessible");
  }
  if (state.queryScope !== null) {
    for (const item of state.queryScope) {
      let scope: HarnessAuthorizedPath | null;
      try {
        scope = await deps.authorize(path.resolve(deps.workspaceRoot, item), { allowMissing: true });
      } catch {
        throw new HarnessServiceError("unavailable", `Stored query scope is inaccessible: ${item}`);
      }
      if (!scope || scope.resourceId !== item) {
        throw new HarnessServiceError("unavailable", `Stored query scope is no longer authorized: ${item}`);
      }
    }
  }
  deps.assertCurrent?.();
  return { operationDir: state.operationDir, queryScope: state.queryScope === null ? null : [...state.queryScope], revision: state.revision };
}

export async function selectOperationDir(
  state: HarnessWorkContextState,
  params: ContextSelectParams,
  deps: WorkContextDeps,
): Promise<ContextGetResult> {
  if (typeof params.path !== "string" || params.path.length === 0) {
    throw new HarnessServiceError("invalid-params", "context.select requires a non-empty path");
  }
  assertExpectedRevision(state, params.expectedRevision);
  const revision = state.revision;
  deps.assertCurrent?.();
  const absolute = resolveRelativeToRoot(deps.workspaceRoot, params.path);
  const authorized = await deps.authorize(absolute, { allowMissing: false });
  if (!authorized) {
    throw new HarnessServiceError("forbidden", `path is outside the authorized workspace scope: ${params.path}`);
  }
  const stat = await (deps.fs ?? fs).stat(authorized.canonicalResourceId).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  });
  if (!stat?.isDirectory()) {
    throw new HarnessServiceError("invalid-params", `not a directory: ${params.path}`);
  }
  deps.assertCurrent?.();
  assertExpectedRevision(state, revision);
  state.operationDir = authorized.resourceId;
  state.revision += 1;
  return result(state, deps.workspaceRoot);
}

export async function setQueryScope(
  state: HarnessWorkContextState,
  params: ContextScopeParams,
  deps: WorkContextDeps,
): Promise<ContextGetResult> {
  if (!Array.isArray(params.paths)) {
    throw new HarnessServiceError("invalid-params", "context.scope requires a paths array");
  }
  assertExpectedRevision(state, params.expectedRevision);
  const revision = state.revision;
  deps.assertCurrent?.();
  if (params.paths.length === 0) {
    state.queryScope = null;
    state.revision += 1;
    return result(state, deps.workspaceRoot);
  }
  const resolved: string[] = [];
  for (const candidate of params.paths) {
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw new HarnessServiceError("invalid-params", "context.scope entries must be non-empty paths");
    }
    const absolute = resolveRelativeToRoot(deps.workspaceRoot, candidate);
    // Scope is a filter over existing or future content; allow missing paths
    // but never widen beyond the authorized scope.
    const authorized = await deps.authorize(absolute, { allowMissing: true });
    if (!authorized) {
      throw new HarnessServiceError("forbidden", `path is outside the authorized workspace scope: ${candidate}`);
    }
    resolved.push(authorized.resourceId);
  }
  deps.assertCurrent?.();
  assertExpectedRevision(state, revision);
  state.queryScope = [...new Set(resolved)];
  state.revision += 1;
  return result(state, deps.workspaceRoot);
}

export async function resetWorkContext(
  state: HarnessWorkContextState,
  params: ContextResetParams,
  deps: WorkContextDeps,
): Promise<ContextGetResult> {
  assertExpectedRevision(state, params.expectedRevision);
  const revision = state.revision;
  const candidate = { ...state, queryScope: null };
  // Revalidate a launch directory that may have been deleted, replaced or revoked.
  await selectOperationDir(candidate, { path: deps.sessionRoot, expectedRevision: revision }, deps);
  deps.assertCurrent?.();
  assertExpectedRevision(state, revision);
  Object.assign(state, candidate);
  return result(state, deps.workspaceRoot);
}

export async function discoverProjects(
  params: ContextDiscoverParams,
  deps: WorkContextDeps & { authorizeScopeRoots: string[] },
): Promise<ContextDiscoverResult> {
  const fsx = deps.fs ?? fs;
  const now = deps.now ?? Date.now;
  for (const [name, value] of [["depth", params.depth], ["maxResults", params.maxResults]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new HarnessServiceError("invalid-params", `${name} must be a positive safe integer`);
    }
  }
  const depth = Math.max(1, Math.min(DISCOVER_MAX_DEPTH, Math.trunc(params.depth ?? DISCOVER_MAX_DEPTH)));
  const maxResults = Math.max(1, Math.min(DISCOVER_MAX_CANDIDATES, Math.trunc(params.maxResults ?? 50)));
  const started = now();
  const candidates: ContextDiscoverCandidate[] = [];
  let truncated = false;

  // Scan the authorized scope roots (or the workspace root when unrestricted).
  const queue: Array<{ dir: string; rel: string; depth: number }> =
    deps.authorizeScopeRoots.map((root) => ({
      dir: root,
      rel: toRelativeRoot(deps.workspaceRoot, root),
      depth: 0,
    }));

  while (queue.length > 0 && candidates.length < maxResults) {
    if (now() - started > DISCOVER_TIME_BUDGET_MS) {
      truncated = true;
      break;
    }
    const { dir, rel, depth: level } = queue.shift()!;
    deps.assertCurrent?.();
    const authorized = await deps.authorize(dir, { allowMissing: false });
    if (!authorized) continue;
    deps.assertCurrent?.();
    let dirents;
    try {
      dirents = await fsx.readdir(authorized.canonicalResourceId, { withFileTypes: true });
    } catch {
      truncated = true;
      continue;
    }
    const names = new Set(dirents.map((entry) => entry.name));
    const markers = PROJECT_MARKERS.filter((marker) => names.has(marker));
    if (markers.length > 0) {
      candidates.push({
        path: rel,
        label: rel === "" ? deps.workspaceRoot : rel,
        markers: [...markers],
      });
    }
    if (level >= depth) continue;
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue;
      if (dirent.name.startsWith(".") || SCAN_SKIP_DIRS.has(dirent.name)) continue;
      queue.push({ dir: path.join(dir, dirent.name), rel: rel === "" ? dirent.name : `${rel}/${dirent.name}`, depth: level + 1 });
    }
  }
  if (queue.length > 0) truncated = true;
  return { candidates, truncated };
}
