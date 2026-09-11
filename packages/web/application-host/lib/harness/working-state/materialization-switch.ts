import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ThreadWorktree } from "@piarium/protocol";

export type MaterializationSwitchJournal = NonNullable<ThreadWorktree["materializationSwitch"]>;

const exists = async (target: string): Promise<boolean> => {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
};

const replaceWith = async (source: string, destination: string): Promise<void> => {
  if (await exists(destination)) {
    const discarded = `${destination}.switch-discard-${randomUUID()}`;
    await fs.promises.rename(destination, discarded);
    try {
      await fs.promises.rename(source, destination);
    } catch (error) {
      await fs.promises.rename(discarded, destination).catch(() => undefined);
      throw error;
    }
    await fs.promises.rm(discarded, { recursive: true, force: true });
    return;
  }
  await fs.promises.rename(source, destination);
};

export async function removeOrphanMaterializationDirs(
  livePath: string,
  keep?: { stagingPath?: string; backupPath?: string },
): Promise<void> {
  const directory = path.dirname(livePath);
  const base = path.basename(livePath);
  let names: string[];
  try {
    names = await fs.promises.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await Promise.all(names.map(async (name) => {
    if (!name.startsWith(`${base}.materializing-`) && !name.startsWith(`${base}.virtual-backup-`)) return;
    const full = path.join(directory, name);
    if (full === keep?.stagingPath || full === keep?.backupPath) return;
    await fs.promises.rm(full, { recursive: true, force: true });
  }));
}

export async function rollbackMaterializationSwitch(
  livePath: string,
  journal: MaterializationSwitchJournal,
): Promise<void> {
  const liveExists = await exists(livePath);
  const backupExists = await exists(journal.backupPath);
  if (journal.stage === "staging-ready") {
    if (!liveExists && backupExists) await fs.promises.rename(journal.backupPath, livePath);
    await fs.promises.rm(journal.stagingPath, { recursive: true, force: true });
    await fs.promises.rm(journal.backupPath, { recursive: true, force: true });
    return;
  }
  if (backupExists) {
    await replaceWith(journal.backupPath, livePath);
  }
  await fs.promises.rm(journal.stagingPath, { recursive: true, force: true });
}

export const inferredPromoted = async (
  livePath: string,
  journal: MaterializationSwitchJournal,
): Promise<boolean> => (
  journal.stage === "staging-promoted"
  || (
    journal.stage === "live-backed-up"
    && await exists(livePath)
    && !await exists(journal.stagingPath)
    && await exists(journal.backupPath)
  )
);

export async function recoverMaterializationSwitch(
  livePath: string,
  journal: MaterializationSwitchJournal,
  intent: "abort" | "restart",
): Promise<"virtual" | "materialized"> {
  if (intent === "restart" && await inferredPromoted(livePath, journal)) {
    return "materialized";
  }
  await rollbackMaterializationSwitch(livePath, journal);
  await removeOrphanMaterializationDirs(livePath);
  return "virtual";
}
