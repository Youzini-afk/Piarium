import fs from "node:fs";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFilePreferReflink, verifyObjectIntegrity } from "./reflink.js";
import { materializeWorkingState } from "../harness/working-state/materializer.js";
import type { RecoveryState } from "../harness/working-state/types.js";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) await fsp.rm(dir, { recursive: true, force: true });
});

const scratch = async (): Promise<string> => {
  const dir = await fsp.mkdtemp(path.join(tmpdir(), "piarium-reflink-"));
  cleanup.push(dir);
  return dir;
};

describe("copyFilePreferReflink", () => {
  it("copies content on the real filesystem and reports the backend honestly", async () => {
    const dir = await scratch();
    const src = path.join(dir, "a.bin");
    const dst = path.join(dir, "b.bin");
    await fsp.writeFile(src, "reflink-payload\n");
    const backend = await copyFilePreferReflink(src, dst);
    expect(["reflink", "copy"]).toContain(backend);
    expect(await fsp.readFile(dst, "utf8")).toBe("reflink-payload\n");
  });

  it("falls back to a plain copy when the filesystem cannot clone blocks", async () => {
    const dir = await scratch();
    const src = path.join(dir, "a.bin");
    const dst = path.join(dir, "b.bin");
    await fsp.writeFile(src, "x".repeat(64));
    const failing = {
      ...fsp,
      copyFile: vi.fn(async (s: string, d: string, mode?: number) => {
        if (mode === fs.constants.COPYFILE_FICLONE_FORCE) {
          const error = new Error("unsupported") as NodeJS.ErrnoException;
          error.code = "EOPNOTSUPP";
          throw error;
        }
        return fsp.copyFile(s, d, mode);
      }),
    } as unknown as typeof fs.promises;
    expect(await copyFilePreferReflink(src, dst, failing)).toBe("copy");
    expect((await fsp.readFile(dst)).length).toBe(64);
    expect(failing.copyFile).toHaveBeenCalledTimes(2);
  });

  it("does not retry real failures or missing sources", async () => {
    const dir = await scratch();
    const src = path.join(dir, "missing.bin");
    const dst = path.join(dir, "b.bin");
    const copyFile = vi.fn(async () => {
      const error = new Error("no such file") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });
    await expect(copyFilePreferReflink(src, dst, { ...fsp, copyFile } as unknown as typeof fs.promises))
      .rejects.toThrow("no such file");
    expect(copyFile).toHaveBeenCalledTimes(1);
  });
});

describe("materializeWorkingState object reflink", () => {
  it("materializes regular files from the object path and reports CoW accounting", async () => {
    const dir = await scratch();
    const objectDir = path.join(dir, "objects");
    const target = path.join(dir, "worktree");
    await fsp.mkdir(objectDir, { recursive: true });
    const objectFile = path.join(objectDir, "blob-a");
    const objectContent = "object-bytes\n";
    const objectHash = createHash("sha256").update(objectContent).digest("hex");
    await fsp.writeFile(objectFile, objectContent);

    const states: Record<string, RecoveryState> = {
      "src/a.txt": { kind: "regular-file", objectHash, byteLength: objectContent.length, mode: 0o644 },
      "src/dir": { kind: "directory" },
    };
    const result = await materializeWorkingState({
      targetDir: target,
      states,
      objectPathFor: (state) => (state.kind === "regular-file" ? objectFile : null),
      readContent: async () => { throw new Error("readContent should not run when the object path exists"); },
    });
    expect(await fsp.readFile(path.join(target, "src", "a.txt"), "utf8")).toBe(objectContent);
    expect(result.cow.reflink + result.cow.copy).toBe(1);
  });

  it("uses readContent when the object path is absent", async () => {
    const dir = await scratch();
    const target = path.join(dir, "worktree");
    const states: Record<string, RecoveryState> = {
      "a.txt": { kind: "regular-file", objectHash: "sha256-x", byteLength: 4 },
    };
    const result = await materializeWorkingState({
      targetDir: target,
      states,
      objectPathFor: () => null,
      readContent: async () => Buffer.from("data"),
    });
    expect(await fsp.readFile(path.join(target, "a.txt"), "utf8")).toBe("data");
    expect(result.cow.copy).toBe(1);
  });

  it("falls back to readContent when the object file is missing", async () => {
    const dir = await scratch();
    const target = path.join(dir, "worktree");
    const states: Record<string, RecoveryState> = {
      "a.txt": { kind: "regular-file", objectHash: "sha256-x", byteLength: 8 },
    };
    await materializeWorkingState({
      targetDir: target,
      states,
      objectPathFor: () => path.join(dir, "objects", "absent"),
      readContent: async () => Buffer.from("fallback"),
    });
    expect(await fsp.readFile(path.join(target, "a.txt"), "utf8")).toBe("fallback");
  });
});

describe("D-250 rework: object integrity verification", () => {
  it("rejects a corrupt object (wrong hash) before materializing", async () => {
    const dir = await scratch();
    const objectDir = path.join(dir, "objects");
    const target = path.join(dir, "worktree");
    await fsp.mkdir(objectDir, { recursive: true });
    const objectFile = path.join(objectDir, "blob-corrupt");
    await fsp.writeFile(objectFile, "corrupt-bytes\n");

    const states: Record<string, RecoveryState> = {
      "a.txt": { kind: "regular-file", objectHash: "a".repeat(64), byteLength: 13, mode: 0o644 },
    };
    await expect(materializeWorkingState({
      targetDir: target,
      states,
      objectPathFor: () => objectFile,
      readContent: async () => Buffer.from("fallback"),
    })).rejects.toThrow(/corrupt/);
  });

  it("rejects a corrupt object (wrong byteLength) before materializing", async () => {
    const dir = await scratch();
    const objectDir = path.join(dir, "objects");
    const target = path.join(dir, "worktree");
    await fsp.mkdir(objectDir, { recursive: true });
    const objectFile = path.join(objectDir, "blob-wrong-size");
    const objectContent = "hello\n";
    const objectHash = createHash("sha256").update(objectContent).digest("hex");
    await fsp.writeFile(objectFile, objectContent);

    const states: Record<string, RecoveryState> = {
      "a.txt": { kind: "regular-file", objectHash, byteLength: 999, mode: 0o644 },
    };
    await expect(materializeWorkingState({
      targetDir: target,
      states,
      objectPathFor: () => objectFile,
      readContent: async () => Buffer.from("fallback"),
    })).rejects.toThrow(/corrupt.*expected 999.*got 6/);
  });

  it("verifyObjectIntegrity throws on corrupt object", async () => {
    const dir = await scratch();
    const objectFile = path.join(dir, "bad.bin");
    await fsp.writeFile(objectFile, "not-the-right-content\n");
    await expect(verifyObjectIntegrity(objectFile, "b".repeat(64), 21))
      .rejects.toThrow(/corrupt/);
  });
});

describe("D-250 rework: EACCES/EPERM are permission errors, not unsupported reflink", () => {
  it("propagates EACCES instead of falling back to copy", async () => {
    const dir = await scratch();
    const src = path.join(dir, "a.bin");
    const dst = path.join(dir, "b.bin");
    await fsp.writeFile(src, "x".repeat(64));
    const failing = {
      copyFile: vi.fn(async () => {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }),
    } as unknown as typeof fs.promises;
    await expect(copyFilePreferReflink(src, dst, failing)).rejects.toThrow("permission denied");
    expect(failing.copyFile).toHaveBeenCalledTimes(1);
  });

  it("propagates EPERM instead of falling back to copy", async () => {
    const dir = await scratch();
    const src = path.join(dir, "a.bin");
    const dst = path.join(dir, "b.bin");
    await fsp.writeFile(src, "x".repeat(64));
    const failing = {
      copyFile: vi.fn(async () => {
        const error = new Error("operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }),
    } as unknown as typeof fs.promises;
    await expect(copyFilePreferReflink(src, dst, failing)).rejects.toThrow("operation not permitted");
    expect(failing.copyFile).toHaveBeenCalledTimes(1);
  });

  it("falls back to copy on EXDEV (cross-volume)", async () => {
    const dir = await scratch();
    const src = path.join(dir, "a.bin");
    const dst = path.join(dir, "b.bin");
    await fsp.writeFile(src, "x".repeat(64));
    const failing = {
      ...fsp,
      copyFile: vi.fn(async (s: string, d: string, mode?: number) => {
        if (mode === fs.constants.COPYFILE_FICLONE_FORCE) {
          const error = new Error("cross-device") as NodeJS.ErrnoException;
          error.code = "EXDEV";
          throw error;
        }
        return fsp.copyFile(s, d, mode);
      }),
    } as unknown as typeof fs.promises;
    expect(await copyFilePreferReflink(src, dst, failing)).toBe("copy");
    expect((await fsp.readFile(dst)).length).toBe(64);
    expect(failing.copyFile).toHaveBeenCalledTimes(2);
  });
});
