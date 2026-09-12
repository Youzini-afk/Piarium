import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyIndexModes,
  gitIndexModes,
  parseCheckAttrOutput,
  parseLfsPointer,
  probeGitAttributes,
  smudgeBlobForWorktree,
  portableMode,
} from "./git-adaptation.js";
import { importGitPathsToStore, type RunGitFn } from "./git-migration.js";
import { sameState, stateIdentity } from "../../recovery/journal-files.js";

let root = "";
let gitDir = "";

const git = (args: string[], cwd = root) =>
  execFileSync("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

const runGit: RunGitFn = async (args, cwd = root) => {
  const stdoutBuffer = git(args, cwd);
  return { stdoutBuffer, stdout: stdoutBuffer.toString("utf8"), stderr: "", exitCode: 0 };
};

const io = { readFile: fs.readFile, join: path.join, isAbsolute: path.isAbsolute };

const commitAll = () => {
  git(["add", "-A"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
};

const lfsPointerText = (oid: string, size: number) =>
  `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;

const fakeStore = () => {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    putObject: async (bytes: Buffer) => {
      const hash = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
      objects.set(hash, bytes);
      return { hash, byteLength: bytes.length };
    },
  };
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "piarium-git-adapt-"));
  git(["init", "--quiet"]);
  git(["config", "core.autocrlf", "false"]);
  gitDir = path.join(root, ".git");
});

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("parseLfsPointer", () => {
  it("parses a valid pointer and rejects content or malformed blobs", () => {
    const oid = createHash("sha256").update("payload").digest("hex");
    expect(parseLfsPointer(Buffer.from(lfsPointerText(oid, 7)))).toEqual({ oid, size: 7 });
    expect(parseLfsPointer(Buffer.from("real file content\n"))).toBeNull();
    expect(parseLfsPointer(Buffer.alloc(4096, 1))).toBeNull();
    expect(parseLfsPointer(Buffer.from("version https://git-lfs.github.com/spec/v1\noid sha256:nope\n"))).toBeNull();
  });
});

describe("parseCheckAttrOutput", () => {
  it("parses NUL-separated path/attr/value triples and drops unset values", () => {
    const out = "a.bin\0filter\0lfs\0a.bin\0text\0unset\0b.txt\0eol\0crlf\0b.txt\0text\0set\0c.md\0filter\0unspecified\0";
    const parsed = parseCheckAttrOutput(out);
    expect(parsed.get("a.bin")).toMatchObject({ filter: "lfs", text: "unset" });
    expect(parsed.get("b.txt")).toMatchObject({ eol: "crlf", text: "set" });
    expect(parsed.get("c.md")?.filter).toBeUndefined();
  });
});

describe("git worktree adaptation", () => {
  it("imports the real LFS object bytes when the local object store has them", async () => {
    await fs.writeFile(path.join(root, ".gitattributes"), "*.bin filter=lfs\n");
    const content = Buffer.from("binary-payload-\u0000\u0001");
    const oid = createHash("sha256").update(content).digest("hex");
    await fs.writeFile(path.join(root, "model.bin"), lfsPointerText(oid, content.length));
    commitAll();
    // LFS objects live under the common git dir — worktrees share it.
    const objectPath = path.join(gitDir, "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
    await fs.mkdir(path.dirname(objectPath), { recursive: true });
    await fs.writeFile(objectPath, content);

    const store = fakeStore();
    const states = await importGitPathsToStore(store as never, runGit, "HEAD", ["model.bin"], root, io);
    const state = states["model.bin"];
    expect(state?.kind).toBe("regular-file");
    expect(store.objects.get((state as { objectHash: string }).objectHash)?.equals(content)).toBe(true);
  });

  it("degrades to the pointer bytes when the local LFS object is missing (GIT_LFS_SKIP_SMUDGE=1)", async () => {
    await fs.writeFile(path.join(root, ".gitattributes"), "*.bin filter=lfs\n");
    const pointer = lfsPointerText("a".repeat(64), 12345);
    await fs.writeFile(path.join(root, "model.bin"), pointer);
    commitAll();

    const store = fakeStore();
    // D-243 rework: LFS filter failure without GIT_LFS_SKIP_SMUDGE=1 throws.
    // With GIT_LFS_SKIP_SMUDGE=1, the local object store is probed; a missing
    // object degrades to the pointer bytes (what checkout writes).
    const previousSkipSmudge = process.env.GIT_LFS_SKIP_SMUDGE;
    process.env.GIT_LFS_SKIP_SMUDGE = "1";
    try {
      const states = await importGitPathsToStore(store as never, runGit, "HEAD", ["model.bin"], root, io);
      const state = states["model.bin"];
      expect(state?.kind).toBe("regular-file");
      expect(store.objects.get((state as { objectHash: string }).objectHash)?.toString()).toBe(pointer);
    } finally {
      if (previousSkipSmudge === undefined) delete process.env.GIT_LFS_SKIP_SMUDGE;
      else process.env.GIT_LFS_SKIP_SMUDGE = previousSkipSmudge;
    }
  });

  it("throws on required LFS filter failure without GIT_LFS_SKIP_SMUDGE (D-243 rework)", async () => {
    await fs.writeFile(path.join(root, ".gitattributes"), "*.bin filter=lfs\n");
    const pointer = lfsPointerText("b".repeat(64), 67890);
    await fs.writeFile(path.join(root, "model.bin"), pointer);
    commitAll();

    const store = fakeStore();
    // Without GIT_LFS_SKIP_SMUDGE=1, a required LFS filter that cannot run
    // (no LFS installed) must throw, not return raw blob (D-243 rework).
    const previousSkipSmudge = process.env.GIT_LFS_SKIP_SMUDGE;
    delete process.env.GIT_LFS_SKIP_SMUDGE;
    try {
      await expect(importGitPathsToStore(store as never, runGit, "HEAD", ["model.bin"], root, io))
        .rejects.toThrow(/Required LFS filter failed/);
    } finally {
      if (previousSkipSmudge !== undefined) process.env.GIT_LFS_SKIP_SMUDGE = previousSkipSmudge;
    }
  });

  it("smudges text blobs to the configured worktree eol", async () => {
    await fs.writeFile(path.join(root, ".gitattributes"), "*.txt text eol=crlf\n");
    await fs.writeFile(path.join(root, "note.txt"), "line-one\nline-two\n");
    commitAll();

    const store = fakeStore();
    const states = await importGitPathsToStore(store as never, runGit, "HEAD", ["note.txt"], root, io);
    const bytes = store.objects.get((states["note.txt"] as { objectHash: string }).objectHash);
    expect(bytes?.toString()).toBe("line-one\r\nline-two\r\n");
  });

  it("keeps raw blob bytes for unfiltered paths", async () => {
    await fs.writeFile(path.join(root, "plain.bin"), "line\n");
    commitAll();
    const store = fakeStore();
    const states = await importGitPathsToStore(store as never, runGit, "HEAD", ["plain.bin"], root, io);
    expect(store.objects.get((states["plain.bin"] as { objectHash: string }).objectHash)?.toString()).toBe("line\n");
  });

  it("falls back to raw blob bytes when the configured filter cannot run", async () => {
    // Commit without the attribute first: a required clean filter that fails
    // would reject `git add`. Attributes resolve from the working tree, so an
    // uncommitted .gitattributes still governs the import probe.
    await fs.writeFile(path.join(root, "data.flt"), "filtered-content\n");
    commitAll();
    await fs.writeFile(path.join(root, ".gitattributes"), "*.flt filter=missing-filter\n");
    git(["config", "filter.missing-filter.smudge", "definitely-not-a-real-command-xyz"]);

    const store = fakeStore();
    const states = await importGitPathsToStore(store as never, runGit, "HEAD", ["data.flt"], root, io);
    expect(store.objects.get((states["data.flt"] as { objectHash: string }).objectHash)?.toString()).toBe("filtered-content\n");
  });
});

describe("index modes", () => {
  it("reads index modes and restores exec intent on platforms without it", async () => {
    await fs.writeFile(path.join(root, "script.sh"), "echo hi\n");
    await fs.writeFile(path.join(root, "data.txt"), "data\n");
    commitAll();
    git(["update-index", "--chmod=+x", "script.sh"]);

    const modes = await gitIndexModes(runGit, root);
    expect(modes.get("script.sh")).toBe("100755");
    expect(modes.get("data.txt")).toBe("100644");

    const states = {
      "script.sh": { kind: "regular-file" as const, objectHash: "sha256-x", byteLength: 1, mode: 0o666 },
      "data.txt": { kind: "regular-file" as const, objectHash: "sha256-y", byteLength: 1, mode: 0o666 },
    };
    const adapted = applyIndexModes(states, modes);
    const expected = process.platform === "win32" ? 0o755 : 0o666;
    expect((adapted["script.sh"] as { mode?: number }).mode).toBe(expected);
    expect((adapted["data.txt"] as { mode?: number }).mode).toBe(process.platform === "win32" ? 0o644 : 0o666);
  });

  it("compares an index-adapted state to a filesystem capture on the current platform", () => {
    const adapted = { kind: "regular-file" as const, objectHash: "sha256-a", byteLength: 4, mode: 0o755 };
    const captured = { kind: "regular-file" as const, objectHash: "sha256-a", byteLength: 4, mode: 0o666 };
    // On Windows the exec bit is unrepresentable; sameState must not report drift.
    // On POSIX the bits are real and 0o755 vs 0o666 genuinely differ.
    expect(sameState(adapted, captured)).toBe(process.platform !== "win32" ? false : true);
  });
});

describe("portableMode", () => {
  it("masks unrepresentable permission bits on Windows", () => {
    if (process.platform === "win32") {
      expect(portableMode("regular-file", 0o755)).toBe(0o666);
      expect(portableMode("regular-file", 0o444)).toBe(0o444);
      expect(portableMode("symlink", 0o777)).toBeNull();
    } else {
      expect(portableMode("regular-file", 0o755)).toBe(0o755);
      expect(portableMode("regular-file", 0o644)).toBe(0o644);
    }
    expect(portableMode("regular-file", undefined)).toBeNull();
  });
});

describe("probeGitAttributes", () => {
  it("reports filter and eol attributes for repo paths", async () => {
    await fs.writeFile(path.join(root, ".gitattributes"), "*.bin filter=lfs\n*.txt eol=crlf\n");
    commitAll();
    const attrs = await probeGitAttributes(runGit, root, ["model.bin", "note.txt"]);
    expect(attrs.get("model.bin")?.filter).toBe("lfs");
    expect(attrs.get("note.txt")?.eol).toBe("crlf");
  });

  it("throws on check-attr failure (D-243 rework)", async () => {
    // probeGitAttributes must not silently return empty attributes on failure
    // (D-243 rework). A failure means we cannot know whether a required filter
    // applies, so the import must fail.
    const brokenGit: RunGitFn = async () => {
      throw new Error("git not found");
    };
    await expect(probeGitAttributes(brokenGit, root, ["model.bin"])).rejects.toThrow(/git not found/);
  });
});

describe("D-243 rework: base/result attribute binding", () => {
  it("base has no eol, result adds eol=crlf — result is smudged, base stays raw", async () => {
    // Base commit: no .gitattributes, plain LF content.
    await fs.writeFile(path.join(root, "note.txt"), "line-one\nline-two\n");
    commitAll();
    const baseCommit = git(["rev-parse", "HEAD"]).toString("utf8").trim();

    // Result commit: add eol=crlf attribute, same content.
    await fs.writeFile(path.join(root, ".gitattributes"), "*.txt eol=crlf\n");
    await fs.writeFile(path.join(root, "note.txt"), "line-one\nline-two\n");
    commitAll();
    const resultCommit = git(["rev-parse", "HEAD"]).toString("utf8").trim();

    const store = fakeStore();
    // Import base (no eol): raw LF bytes.
    const baseStates = await importGitPathsToStore(store as never, runGit, baseCommit, ["note.txt"], root, io);
    expect(store.objects.get((baseStates["note.txt"] as { objectHash: string }).objectHash)?.toString()).toBe("line-one\nline-two\n");

    // Import result (eol=crlf): smudged CRLF bytes.
    const resultStates = await importGitPathsToStore(store as never, runGit, resultCommit, ["note.txt"], root, io);
    expect(store.objects.get((resultStates["note.txt"] as { objectHash: string }).objectHash)?.toString()).toBe("line-one\r\nline-two\r\n");
  });

  it("base/result have opposite eol attributes — each is smudged to its own", async () => {
    // Base: eol=crlf
    await fs.writeFile(path.join(root, ".gitattributes"), "*.txt eol=crlf\n");
    await fs.writeFile(path.join(root, "note.txt"), "line-one\nline-two\n");
    commitAll();
    const baseCommit = git(["rev-parse", "HEAD"]).toString("utf8").trim();

    // Result: eol=lf (opposite)
    await fs.writeFile(path.join(root, ".gitattributes"), "*.txt eol=lf\n");
    await fs.writeFile(path.join(root, "note.txt"), "line-one\r\nline-two\r\n");
    commitAll();
    const resultCommit = git(["rev-parse", "HEAD"]).toString("utf8").trim();

    const store = fakeStore();
    const baseStates = await importGitPathsToStore(store as never, runGit, baseCommit, ["note.txt"], root, io);
    expect(store.objects.get((baseStates["note.txt"] as { objectHash: string }).objectHash)?.toString()).toBe("line-one\r\nline-two\r\n");

    const resultStates = await importGitPathsToStore(store as never, runGit, resultCommit, ["note.txt"], root, io);
    expect(store.objects.get((resultStates["note.txt"] as { objectHash: string }).objectHash)?.toString()).toBe("line-one\nline-two\n");
  });
});

describe("D-243 rework: persistent mode identity", () => {
  it("stateIdentity distinguishes 0644 from 0755 on every platform", () => {
    // The persistent hash must include the full mode, not the platform-
    // comparable mode. On Windows, 0644 and 0755 must produce different
    // stateIdentity values even though sameState considers them equal.
    const state644 = { kind: "regular-file" as const, objectHash: "sha256-a", byteLength: 4, mode: 0o644 };
    const state755 = { kind: "regular-file" as const, objectHash: "sha256-a", byteLength: 4, mode: 0o755 };
    expect(stateIdentity(state644)).not.toBe(stateIdentity(state755));
  });

  it("sameState still compares 0644 and 0755 as equal on Windows", () => {
    const state644 = { kind: "regular-file" as const, objectHash: "sha256-a", byteLength: 4, mode: 0o644 };
    const state755 = { kind: "regular-file" as const, objectHash: "sha256-a", byteLength: 4, mode: 0o755 };
    if (process.platform === "win32") {
      expect(sameState(state644, state755)).toBe(true);
    } else {
      expect(sameState(state644, state755)).toBe(false);
    }
  });
});
