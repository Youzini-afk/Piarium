import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFilePreferReflink } from "./reflink.js";
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
    await fsp.writeFile(objectFile, "object-bytes\n");

    const states: Record<string, RecoveryState> = {
      "src/a.txt": { kind: "regular-file", objectHash: "sha256-x", byteLength: 13, mode: 0o644 },
      "src/dir": { kind: "directory" },
    };
    const result = await materializeWorkingState({
      targetDir: target,
      states,
      objectPathFor: (state) => (state.kind === "regular-file" ? objectFile : null),
      readContent: async () => { throw new Error("readContent should not run when the object path exists"); },
    });
    expect(await fsp.readFile(path.join(target, "src", "a.txt"), "utf8")).toBe("object-bytes\n");
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
