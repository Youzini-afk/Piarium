/**
 * Git worktree adaptation for WorkingState capture/import (D-243).
 *
 * WorkingState records the bytes tools actually see — the smudged worktree
 * view — while Git stores cleaned blobs. This module is the only place that
 * translates between the two: it probes path attributes (`check-attr`),
 * smudges blobs to worktree bytes (`cat-file --filters`, LFS local objects),
 * and restores executable intent from the index on platforms whose
 * filesystem cannot express it (Windows).
 */

import { createHash } from "node:crypto";
import type fs from "node:fs";
import type path from "node:path";
import type { RecoveryState } from "./types.js";
import type { RunGitFn } from "./git-migration.js";

export interface GitPathAttributes {
  /** Value of the `filter` attribute, e.g. "lfs". Absent when unset/unspecified. */
  filter?: string;
  /** Raw `text` attribute: "set" | "unset" | "auto" | "unspecified". */
  text?: string;
  /** `eol` attribute when explicitly set. */
  eol?: "lf" | "crlf";
  /** `working-tree-encoding` attribute when set. */
  workingTreeEncoding?: string;
}

export type GitAdaptationIo = {
  readFile: typeof fs.promises.readFile;
  join: typeof path.join;
  isAbsolute?: typeof path.isAbsolute;
};

const normalizeRepoPath = (value: string): string => value.replace(/\\/g, "/").replace(/^\.\//, "");

/**
 * Parse `git check-attr -z --all` output. With -z each record is
 * `path\0attr\0value\0`; values are "set", "unset", "unspecified" or an
 * explicit value (e.g. "crlf", "lfs").
 */
export const parseCheckAttrOutput = (output: string): Map<string, GitPathAttributes> => {
  const result = new Map<string, GitPathAttributes>();
  const tokens = output.split("\0");
  for (let index = 0; index + 2 < tokens.length; index += 3) {
    const file = tokens[index] ?? "";
    const attribute = tokens[index + 1] ?? "";
    const value = tokens[index + 2] ?? "";
    if (!file || !attribute) continue;
    const entry = result.get(file) ?? {};
    if (attribute === "filter" && value !== "unspecified" && value !== "unset") entry.filter = value;
    else if (attribute === "text") entry.text = value;
    else if (attribute === "eol" && (value === "lf" || value === "crlf")) entry.eol = value;
    else if (attribute === "working-tree-encoding" && value !== "unspecified" && value !== "unset") {
      entry.workingTreeEncoding = value;
    }
    result.set(file, entry);
  }
  return result;
};

/** Attributes for the given worktree-relative paths, in one git invocation. */
export const probeGitAttributes = async (
  runGit: RunGitFn,
  cwd: string,
  paths: readonly string[],
): Promise<Map<string, GitPathAttributes>> => {
  if (paths.length === 0) return new Map();
  const { stdout } = await runGit(
    ["check-attr", "-z", "--all", "--", ...paths.map(normalizeRepoPath)],
    cwd,
  );
  return parseCheckAttrOutput(stdout);
};

export interface LfsPointer {
  oid: string;
  size: number;
}

const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

/** Parse a Git LFS pointer blob. Returns null when the bytes are real content. */
export const parseLfsPointer = (bytes: Buffer): LfsPointer | null => {
  // Pointer files are tiny; cap the probe so a large binary is not scanned.
  if (bytes.length > 1024) return null;
  const text = bytes.toString("utf8");
  if (!text.startsWith(LFS_POINTER_PREFIX)) return null;
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
  const size = /^size (\d+)$/m.exec(text)?.[1];
  if (!oid || size === undefined) return null;
  return { oid, size: Number.parseInt(size, 10) };
};

const lfsObjectPath = (gitCommonDir: string, oid: string, io: GitAdaptationIo): string =>
  io.join(gitCommonDir, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);

/**
 * Bytes a Git worktree would hold for `blobHash` at `path`.
 *
 * - `filter=lfs`: the pointer blob is resolved against the local LFS object
 *   store (`<git-common-dir>/lfs/objects/…`) so import never downloads from a
 *   remote. A missing or corrupt local object degrades to the pointer bytes —
 *   exactly what `git checkout` writes when LFS content is unavailable — so
 *   `git status` stays clean either way.
 * - Any other filter, text/eol conversion, or working-tree-encoding:
 *   `git cat-file --filters --path=<path>` runs the configured smudge side,
 *   identical to checkout. If the configured filter cannot run the raw blob
 *   bytes are used — again what checkout leaves behind.
 * - Unfiltered paths: raw blob bytes.
 */
export const smudgeBlobForWorktree = async (
  runGit: RunGitFn,
  cwd: string,
  path: string,
  blobHash: string,
  attrs: GitPathAttributes | undefined,
  io: GitAdaptationIo,
): Promise<Buffer> => {
  const raw = async (): Promise<Buffer> => {
    const res = await runGit(["cat-file", "-p", blobHash], cwd);
    return res.stdoutBuffer ?? Buffer.from(res.stdout, "utf8");
  };
  const normalized = normalizeRepoPath(path);
  if (attrs?.filter === "lfs") {
    const blob = await raw();
    const pointer = parseLfsPointer(blob);
    if (!pointer) return blob;
    try {
      const commonDir = (await runGit(["rev-parse", "--git-common-dir"], cwd)).stdout.trim();
      // --git-common-dir is relative to the work tree when it is just ".git".
      const absolute = commonDir && (io.isAbsolute ? io.isAbsolute(commonDir) : (commonDir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(commonDir)));
      const base = !commonDir ? cwd : absolute ? commonDir : io.join(cwd, commonDir);
      const objectBytes = await io.readFile(lfsObjectPath(base, pointer.oid, io));
      // Verify the local object before trusting it as the worktree view.
      if (createHash("sha256").update(objectBytes).digest("hex") === pointer.oid) return objectBytes;
      return blob;
    } catch {
      return blob;
    }
  }
  const needsConversion = Boolean(
    attrs?.filter
      || attrs?.workingTreeEncoding
      || attrs?.eol
      || (attrs?.text !== undefined && attrs.text !== "unset"),
  );
  if (!needsConversion) return raw();
  try {
    const res = await runGit(["cat-file", "--filters", `--path=${normalized}`, blobHash], cwd);
    return res.stdoutBuffer ?? Buffer.from(res.stdout, "utf8");
  } catch {
    return raw();
  }
};

/** `git ls-files -s -z` → path → index mode ("100644" | "100755" | …). */
export const gitIndexModes = async (
  runGit: RunGitFn,
  cwd: string,
): Promise<Map<string, string>> => {
  const { stdout } = await runGit(["ls-files", "-s", "-z"], cwd);
  const modes = new Map<string, string>();
  for (const token of stdout.split("\0")) {
    if (!token) continue;
    const tab = token.indexOf("\t");
    if (tab === -1) continue;
    const mode = token.slice(0, tab).trim().split(/\s+/)[0];
    const file = token.slice(tab + 1);
    if (mode && file) modes.set(normalizeRepoPath(file), mode);
  }
  return modes;
};

const gitIndexFileMode = (indexMode: string): number | undefined => {
  if (indexMode === "100755") return 0o755;
  if (indexMode === "100644") return 0o644;
  return undefined;
};

/**
 * Overlay Git index modes onto captured states on platforms whose filesystem
 * cannot express the executable bit (Windows reports every regular file as
 * 0o666). POSIX keeps the filesystem truth — that is what tools observed.
 * Only regular-file blob modes (100644/100755) apply; symlinks and gitlinks
 * keep their captured kind.
 */
export const applyIndexModes = (
  states: Record<string, RecoveryState>,
  indexModes: Map<string, string> | Record<string, string> | undefined,
): Record<string, RecoveryState> => {
  if (!indexModes || process.platform !== "win32") return states;
  const lookup = indexModes instanceof Map ? (key: string) => indexModes.get(key) : (key: string) => indexModes[key];
  const result: Record<string, RecoveryState> = {};
  for (const [file, state] of Object.entries(states)) {
    if (state.kind !== "regular-file") {
      result[file] = state;
      continue;
    }
    const mode = gitIndexFileMode(lookup(normalizeRepoPath(file)) ?? "");
    result[file] = mode === undefined ? state : { ...state, mode };
  }
  return result;
};

/**
 * Mode identity usable for comparisons. On Windows the filesystem cannot
 * express POSIX permission bits (lstat reports 0o666 for writable files), so
 * only the writability dimension is observable there; the full mode is still
 * stored for materialization on capable platforms.
 */
export const portableMode = (kind: RecoveryState["kind"], mode: number | undefined): number | null => {
  if (mode === undefined) return null;
  if (kind === "symlink") return null;
  if (process.platform !== "win32") return mode;
  // Reduce to the single bit Windows can represent: readonly vs writable.
  return (mode & 0o222) === 0 ? 0o444 : 0o666;
};
