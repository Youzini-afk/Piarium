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

/** Attributes for the given worktree-relative paths, in one git invocation.
 * When `commit` is provided, attributes are resolved from that commit's tree
 * (D-243 rework: base/result must each bind to their own commit's attributes,
 * not the live worktree's `.gitattributes`). Uses `check-attr --source=<commit>`
 * (Git 2.43+); if `--source` is unavailable the probe fails rather than
 * silently using the wrong (live) attributes.
 */
export const probeGitAttributes = async (
  runGit: RunGitFn,
  cwd: string,
  paths: readonly string[],
  commit?: string,
): Promise<Map<string, GitPathAttributes>> => {
  if (paths.length === 0) return new Map();
  const args = ["check-attr", "-z", "--all"];
  if (commit) args.push(`--source=${commit}`);
  args.push("--", ...paths.map(normalizeRepoPath));
  const { stdout } = await runGit(args, cwd);
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
 * - `filter=lfs`: `cat-file --filters` runs the configured smudge process,
 *   respecting `GIT_LFS_SKIP_SMUDGE=1` exactly like checkout. When the
 *   filter process is unavailable AND `GIT_LFS_SKIP_SMUDGE=1`, the local LFS
 *   object store is probed directly (offline-safe, no remote download). A
 *   missing or corrupt local object with `GIT_LFS_SKIP_SMUDGE=1` degrades to
 *   the pointer bytes — exactly what checkout writes. A required filter that
 *   cannot run and is not skip-smudged throws (D-243 rework: required filter
 *   failure must fail/unavailable, not return raw blob).
 * - text/eol conversion: done in-process from the probed attributes (D-243
 *   rework: the conversion must bind to the commit's attributes, not the
 *   live worktree's `.gitattributes`). LF→CRLF for `eol=crlf` or
 *   `text=auto`+CRLF environment; CRLF→LF for `eol=lf`.
 * - working-tree-encoding: `cat-file --filters` runs the configured smudge
 *   side (encoding filters are less common and harder to replicate in-process).
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
  const lfsSkipSmudge = process.env.GIT_LFS_SKIP_SMUDGE === "1";
  if (attrs?.filter === "lfs") {
    // Try the configured smudge process first (respects GIT_LFS_SKIP_SMUDGE).
    try {
      const res = await runGit(["cat-file", "--filters", `--path=${normalized}`, blobHash], cwd);
      return res.stdoutBuffer ?? Buffer.from(res.stdout, "utf8");
    } catch {
      // The filter process failed. If GIT_LFS_SKIP_SMUDGE=1, probe the local
      // LFS object store directly (offline-safe). Otherwise this is a
      // required-filter failure — fail rather than return raw blob (D-243 rework).
      if (!lfsSkipSmudge) {
        throw new Error(`Required LFS filter failed for ${normalized} (blob ${blobHash}); set GIT_LFS_SKIP_SMUDGE=1 to probe local objects`);
      }
    }
    // GIT_LFS_SKIP_SMUDGE=1: probe the local LFS object store.
    const blob = await raw();
    const pointer = parseLfsPointer(blob);
    if (!pointer) return blob;
    try {
      const commonDir = (await runGit(["rev-parse", "--git-common-dir"], cwd)).stdout.trim();
      const absolute = commonDir && (io.isAbsolute ? io.isAbsolute(commonDir) : (commonDir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(commonDir)));
      const base = !commonDir ? cwd : absolute ? commonDir : io.join(cwd, commonDir);
      const objectBytes = await io.readFile(lfsObjectPath(base, pointer.oid, io));
      if (createHash("sha256").update(objectBytes).digest("hex") === pointer.oid) return objectBytes;
      return blob;
    } catch {
      return blob;
    }
  }
  // text/eol conversion: done in-process from the probed attributes (D-243
  // rework: bind to the commit's attributes, not the live worktree's).
  if (attrs?.eol || (attrs?.text !== undefined && attrs.text !== "unset")) {
    const blob = await raw();
    const wantCrlf = attrs?.eol === "crlf"
      || (attrs?.text === "auto" && process.platform === "win32" && attrs?.eol !== "lf")
      || (attrs?.text === "set" && process.platform === "win32");
    const wantLf = attrs?.eol === "lf";
    if (wantCrlf) {
      // LF → CRLF (do not double-convert existing CRLF)
      return Buffer.from(blob.toString("binary").replace(/\r?\n/g, "\r\n"), "binary");
    }
    if (wantLf) {
      // CRLF → LF
      return Buffer.from(blob.toString("binary").replace(/\r\n/g, "\n"), "binary");
    }
    return blob;
  }
  // working-tree-encoding or other custom filters: use cat-file --filters.
  const needsConversion = Boolean(attrs?.filter || attrs?.workingTreeEncoding);
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
