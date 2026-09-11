import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recoverMaterializationSwitch,
  removeOrphanMaterializationDirs,
  rollbackMaterializationSwitch,
} from "./materialization-switch.js";
import { assertManagedWorktreeOwnership } from "../worktree-ownership.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

const temp = async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "piarium-materialize-switch-"));
  roots.push(root);
  const live = path.join(root, "scratch");
  await fs.promises.mkdir(live);
  await fs.promises.writeFile(path.join(live, "virtual.txt"), "scratch\n");
  const worktree = { path: live, managedRoot: root, base: "zero-commit" };
  const assertOwnership = (operation: string, candidates: readonly string[] = []) => (
    assertManagedWorktreeOwnership(worktree, operation, candidates, {
      authorizeManagedRoot: (candidate) => candidate === root,
    })
  );
  return { root, live, worktree, assertOwnership };
};

describe("materialization switch recovery", () => {
  it("rolls staging-ready back to the virtual live path and deletes staging", async () => {
    const { live, worktree, assertOwnership } = await temp();
    const staging = `${live}.materializing-a`;
    const backup = `${live}.virtual-backup-a`;
    await fs.promises.mkdir(staging);
    await fs.promises.writeFile(path.join(staging, "next.txt"), "staging\n");
    await rollbackMaterializationSwitch(worktree, {
      writeRevision: 1,
      stagingPath: staging,
      backupPath: backup,
      stage: "staging-ready",
    }, assertOwnership);
    expect(await fs.promises.readFile(path.join(live, "virtual.txt"), "utf8")).toBe("scratch\n");
    await expect(fs.promises.stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores backup when live was already renamed", async () => {
    const { live, worktree, assertOwnership } = await temp();
    const staging = `${live}.materializing-b`;
    const backup = `${live}.virtual-backup-b`;
    await fs.promises.mkdir(staging);
    await fs.promises.writeFile(path.join(staging, "next.txt"), "staging\n");
    await fs.promises.rename(live, backup);
    await rollbackMaterializationSwitch(worktree, {
      writeRevision: 1,
      stagingPath: staging,
      backupPath: backup,
      stage: "live-backed-up",
    }, assertOwnership);
    expect(await fs.promises.readFile(path.join(live, "virtual.txt"), "utf8")).toBe("scratch\n");
    await expect(fs.promises.stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a promoted live tree on restart and rolls it back on abort", async () => {
    const { live, worktree, assertOwnership } = await temp();
    const staging = `${live}.materializing-c`;
    const backup = `${live}.virtual-backup-c`;
    await fs.promises.rename(live, backup);
    await fs.promises.mkdir(live);
    await fs.promises.writeFile(path.join(live, "next.txt"), "promoted\n");
    const journal = {
      writeRevision: 2,
      stagingPath: staging,
      backupPath: backup,
      stage: "staging-promoted" as const,
    };
    expect(await recoverMaterializationSwitch(worktree, journal, "restart", assertOwnership)).toBe("materialized");
    expect(await fs.promises.readFile(path.join(live, "next.txt"), "utf8")).toBe("promoted\n");
    expect(await recoverMaterializationSwitch(worktree, journal, "abort", assertOwnership)).toBe("virtual");
    expect(await fs.promises.readFile(path.join(live, "virtual.txt"), "utf8")).toBe("scratch\n");
    await expect(fs.promises.stat(path.join(live, "next.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes orphan switch directories that are not the journaled pair", async () => {
    const { live, worktree, assertOwnership } = await temp();
    const orphan = `${live}.materializing-old`;
    await fs.promises.mkdir(orphan);
    await removeOrphanMaterializationDirs(worktree, assertOwnership);
    await expect(fs.promises.stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
