import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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
import { isPathWithinRoot } from "../workspace/path-safety.js";

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

const DISCOVER_TIME_BUDGET_MS = 800;

export interface WorkContextDeps {
  /** Resolve a candidate against the actor's authorized scope (Host path authority). */
  authorize: (candidate: string, options: { allowMissing: boolean }) => Promise<HarnessAuthorizedPath | null>;
  /** Restore-only check for a relative-path anchor above a narrowed actor scope. */
  authorizeAnchor?: (candidate: string, options: { allowMissing: boolean }) => Promise<HarnessAuthorizedPath | null>;
  anchorScopeRoots?: readonly string[];
  /** Absolute authorized workspace root for the actor. */
  workspaceRoot: string;
  /** Absolute session launch directory (the initial operation dir). */
  sessionRoot: string;
  fs?: Pick<typeof fs, "access" | "readdir" | "stat">;
  now?: () => number;
  /** Reject work whose registered actor/session generation has been retired. */
  assertCurrent?: () => void;
  /** Binds continuation tokens to the actor/session generation that issued them. */
  cursorBinding?: string;
}

type DiscoverFrame = { path: string; depth: number; phase: "enter" | "children"; afterName: string | null };
type DiscoverCursor = {
  version: 1;
  binding: string;
  workspaceRoot: string;
  scopeRoots: string[];
  startPath: string | null;
  depth: number | null;
  stack: DiscoverFrame[];
};

// Continuations survive the caller's round-trip but are valid only for this
// Host process. A restart or a different actor generation must start a fresh scan.
const DISCOVER_CURSOR_KEY = randomBytes(32);

function encodeDiscoverCursor(cursor: DiscoverCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  const signature = createHmac("sha256", DISCOVER_CURSOR_KEY).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function decodeDiscoverCursor(token: string): DiscoverCursor {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) {
    throw new HarnessServiceError("invalid-params", "Invalid or expired project discovery cursor; restart discovery with path");
  }
  const expected = createHmac("sha256", DISCOVER_CURSOR_KEY).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    throw new HarnessServiceError("invalid-params", "Invalid or expired project discovery cursor; restart discovery with path");
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new HarnessServiceError("invalid-params", "Invalid or expired project discovery cursor; restart discovery with path");
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as DiscoverCursor;
    if (parsed?.version !== 1 || typeof parsed.binding !== "string"
      || typeof parsed.workspaceRoot !== "string" || !Array.isArray(parsed.scopeRoots)
      || !parsed.scopeRoots.every((root) => typeof root === "string")
      || !(parsed.startPath === null || typeof parsed.startPath === "string")
      || !(parsed.depth === null || (Number.isSafeInteger(parsed.depth) && parsed.depth >= 0))
      || !Array.isArray(parsed.stack)
      || !parsed.stack.every((frame) => frame && typeof frame.path === "string"
        && Number.isSafeInteger(frame.depth) && frame.depth >= 0
        && (frame.phase === "enter" || frame.phase === "children")
        && (frame.afterName === null || typeof frame.afterName === "string"))) {
      throw new Error("malformed cursor");
    }
    return parsed;
  } catch {
    throw new HarnessServiceError("invalid-params", "Invalid or expired project discovery cursor; restart discovery with path");
  }
}

const comparePath = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function isWithinRelativeRoot(root: string, candidate: string): boolean {
  if (root === "") {
    const normalized = candidate.replaceAll("\\", "/");
    return candidate === "" || (!path.isAbsolute(candidate) && !/^[A-Za-z]:\//.test(normalized)
      && !normalized.startsWith("../") && normalized !== "..");
  }
  return candidate === root || candidate.startsWith(`${root}/`);
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
    if (!authorized && deps.authorizeAnchor && deps.anchorScopeRoots?.length) {
      const anchor = await deps.authorizeAnchor(operation, { allowMissing: false });
      if (anchor) {
        for (const scopeRoot of deps.anchorScopeRoots) {
          const scope = await deps.authorizeAnchor(scopeRoot, { allowMissing: true });
          if (scope && isPathWithinRoot(scope.canonicalResourceId, anchor.canonicalResourceId)) {
            authorized = anchor;
            break;
          }
        }
      }
    }
  } catch {
    throw new HarnessServiceError("unavailable", "Stored operation directory is missing or inaccessible");
  }
  if (!authorized || authorized.resourceId !== state.operationDir) {
    throw new HarnessServiceError("unavailable", "Stored operation directory is no longer authorized");
  }
  const fsx = deps.fs ?? fs;
  try {
    if (!authorized.resolvedPath) throw new Error("missing resolved path");
    const stat = await fsx.stat(authorized.resolvedPath);
    if (!stat.isDirectory()) throw new Error("not a directory");
    await fsx.access(authorized.resolvedPath, constants.R_OK | constants.X_OK);
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
  if (!authorized.resolvedPath) throw new HarnessServiceError("unavailable", "Authorized operation directory has no resolved path");
  const stat = await (deps.fs ?? fs).stat(authorized.resolvedPath).catch((error: unknown) => {
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
  deps: WorkContextDeps & { authorizeScopeRoots: string[]; signal?: AbortSignal },
): Promise<ContextDiscoverResult> {
  const fsx = deps.fs ?? fs;
  const now = deps.now ?? Date.now;
  if (params.path !== undefined && typeof params.path !== "string") {
    throw new HarnessServiceError("invalid-params", "path must be a string");
  }
  if (params.cursor !== undefined && typeof params.cursor !== "string") {
    throw new HarnessServiceError("invalid-params", "cursor must be a string");
  }
  if (params.path !== undefined && params.cursor !== undefined) {
    throw new HarnessServiceError("invalid-params", "path cannot be combined with a project discovery cursor");
  }
  if (params.depth !== undefined && (!Number.isSafeInteger(params.depth) || params.depth < 0)) {
    throw new HarnessServiceError("invalid-params", "depth must be a non-negative safe integer");
  }
  const maxResults = params.maxResults ?? 50;
  if (!Number.isSafeInteger(maxResults) || maxResults < 1) {
    throw new HarnessServiceError("invalid-params", "maxResults must be a positive safe integer");
  }
  const workspaceRoot = path.resolve(deps.workspaceRoot);
  const binding = deps.cursorBinding ?? "";
  const scopeRoots = [...new Set(deps.authorizeScopeRoots.map((root) => path.resolve(root)))].sort(comparePath);
  const scopeRootRels = scopeRoots.map((root) => toRelativeRoot(workspaceRoot, root));
  if (scopeRootRels.some((root) => !isWithinRelativeRoot("", root)
    || toRelativeRoot(workspaceRoot, path.resolve(workspaceRoot, root)) !== root)) {
    throw new HarnessServiceError("forbidden", "A project discovery scope is outside the authorized workspace");
  }

  const assertActive = (): void => {
    deps.signal?.throwIfAborted();
    deps.assertCurrent?.();
  };
  const authorizeDirectory = async (relative: string): Promise<HarnessAuthorizedPath | null> => {
    assertActive();
    const absolute = relative === "" ? workspaceRoot : path.resolve(workspaceRoot, relative);
    if (toRelativeRoot(workspaceRoot, absolute) !== relative) {
      throw new HarnessServiceError("invalid-params", "Invalid project discovery cursor; restart discovery with path");
    }
    const authorized = await deps.authorize(absolute, { allowMissing: false });
    assertActive();
    if (!authorized || authorized.resourceId !== relative) {
      return null;
    }
    return authorized;
  };

  let startPath: string | null = null;
  let depth: number | null = params.depth ?? null;
  let stack: DiscoverFrame[];
  if (params.cursor !== undefined) {
    const cursor = decodeDiscoverCursor(params.cursor);
    if (cursor.binding !== binding || cursor.workspaceRoot !== workspaceRoot
      || JSON.stringify(cursor.scopeRoots) !== JSON.stringify(scopeRoots)) {
      throw new HarnessServiceError("invalid-params", "Project discovery cursor expired after an authority or session change; restart discovery with path");
    }
    if (params.depth !== undefined && params.depth !== cursor.depth) {
      throw new HarnessServiceError("invalid-params", "depth cannot change while continuing project discovery");
    }
    startPath = cursor.startPath;
    depth = cursor.depth;
    stack = cursor.stack.map((frame) => ({ ...frame }));
    if (stack.some((frame) => !isWithinRelativeRoot("", frame.path)
      || (depth !== null && frame.depth > depth))) {
      throw new HarnessServiceError("invalid-params", "Invalid project discovery cursor; restart discovery with path");
    }
  } else if (params.path !== undefined) {
    if (params.path.length === 0) throw new HarnessServiceError("invalid-params", "path must not be empty");
    const requested = resolveRelativeToRoot(workspaceRoot, params.path);
    const authorized = await deps.authorize(requested, { allowMissing: false });
    assertActive();
    if (!authorized) throw new HarnessServiceError("forbidden", `path is outside the authorized workspace scope: ${params.path}`);
    const relative = authorized.resourceId;
    if (!isWithinRelativeRoot("", relative)) {
      throw new HarnessServiceError("forbidden", `path is outside the authorized workspace: ${params.path}`);
    }
    const stat = await fsx.stat(authorized.canonicalResourceId);
    assertActive();
    if (!stat.isDirectory()) throw new HarnessServiceError("invalid-params", `not a directory: ${params.path}`);
    startPath = relative;
    stack = [{ path: relative, depth: 0, phase: "enter", afterName: null }];
  } else {
    // Remove nested roots already covered by an authorized parent. The cursor
    // still binds the original root set so a scope change invalidates it.
    const roots = scopeRootRels.filter((candidate, index) =>
      !scopeRootRels.some((other, otherIndex) => otherIndex !== index
        && other.length < candidate.length && isWithinRelativeRoot(other, candidate)));
    stack = roots.reverse().map((relative) => ({ path: relative, depth: 0, phase: "enter", afterName: null }));
  }

  const started = now();
  const candidates: ContextDiscoverCandidate[] = [];
  const unreadablePaths = new Set<string>();
  const loaded = new Map<string, Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>>();
  let stoppedForBudget = false;
  const eligibleDirectory = (entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }): boolean => (
    entry.isDirectory() && !entry.isSymbolicLink()
    && !entry.name.startsWith(".") && !SCAN_SKIP_DIRS.has(entry.name)
  );
  const nextEligibleDirectory = (
    entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>,
    afterName: string | null,
  ) => {
    let low = 0;
    let high = entries.length;
    if (afterName !== null) {
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (comparePath(entries[middle]!.name, afterName) <= 0) low = middle + 1;
        else high = middle;
      }
    }
    for (let index = low; index < entries.length; index++) {
      if (eligibleDirectory(entries[index]!)) return entries[index]!;
    }
    return undefined;
  };
  const hasPending = (): boolean => stack.some((frame) => {
    if (frame.phase === "enter") return true;
    if (depth !== null && frame.depth >= depth) return false;
    const entries = loaded.get(frame.path);
    return entries ? nextEligibleDirectory(entries, frame.afterName) !== undefined : true;
  });

  while (stack.length > 0) {
    if (now() - started > DISCOVER_TIME_BUDGET_MS) {
      stoppedForBudget = true;
      break;
    }
    assertActive();
    const frame = stack[stack.length - 1]!;
    const authorized = await authorizeDirectory(frame.path);
    if (!authorized) {
      if (params.cursor !== undefined) {
        throw new HarnessServiceError("invalid-params", "Project discovery authorization changed; restart discovery with path");
      }
      if (startPath !== null) {
        throw new HarnessServiceError("forbidden", "Project discovery path is no longer authorized");
      }
      // A restricted root that no longer resolves is not scanned or disclosed.
      stack.pop();
      loaded.delete(frame.path);
      continue;
    }
    let entries = loaded.get(frame.path);
    if (!entries) {
      try {
        const dirents = await fsx.readdir(authorized.canonicalResourceId, { withFileTypes: true });
        assertActive();
        entries = [...dirents].sort((a, b) => comparePath(a.name, b.name));
        loaded.set(frame.path, entries);
      } catch {
        if (deps.signal?.aborted) deps.signal.throwIfAborted();
        deps.assertCurrent?.();
        unreadablePaths.add(frame.path);
        stack.pop();
        continue;
      }
    }

    if (frame.phase === "enter") {
      frame.phase = "children";
      const names = new Set(entries.map((entry) => entry.name));
      const markers = PROJECT_MARKERS.filter((marker) => names.has(marker));
      if (markers.length > 0) {
        candidates.push({
          path: frame.path,
          label: frame.path === "" ? workspaceRoot : frame.path,
          markers: [...markers],
        });
        if (candidates.length >= maxResults && hasPending()) break;
      }
    }

    if (depth !== null && frame.depth >= depth) {
      stack.pop();
      loaded.delete(frame.path);
      continue;
    }
    const next = nextEligibleDirectory(entries, frame.afterName);
    if (!next) {
      stack.pop();
      loaded.delete(frame.path);
      continue;
    }
    frame.afterName = next.name;
    const childPath = frame.path === "" ? next.name : `${frame.path}/${next.name}`;
    stack.push({ path: childPath, depth: frame.depth + 1, phase: "enter", afterName: null });
  }

  const truncated = stack.length > 0 && (stoppedForBudget || candidates.length >= maxResults);
  const nextCursor = truncated
    ? encodeDiscoverCursor({
      version: 1,
      binding,
      workspaceRoot,
      scopeRoots,
      startPath,
      depth,
      stack,
    })
    : undefined;
  return {
    candidates,
    truncated,
    ...(nextCursor ? { nextCursor } : {}),
    ...(unreadablePaths.size > 0 ? { unreadablePaths: [...unreadablePaths].sort(comparePath) } : {}),
  };
}
