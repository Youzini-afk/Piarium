import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { JsonValue, PiSettingsScope } from "@piarium/protocol";
import lockfile from "proper-lockfile";
import { HostError } from "./errors.js";

type SettingsDocument = { [key: string]: JsonValue };

function isSettingsDocument(value: unknown): value is SettingsDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettingsDocument(raw: string, path: string): SettingsDocument {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new HostError(
      "invalid_settings_file",
      `Settings file is not valid JSON: ${path}`,
      { cause: error },
    );
  }
  if (!isSettingsDocument(value)) {
    throw new HostError("invalid_settings_file", `Settings file must contain an object: ${path}`);
  }
  return value;
}

export function applyTopLevelSettingsChanges(
  current: SettingsDocument,
  set: SettingsDocument,
  remove: readonly string[],
): SettingsDocument {
  const next = { ...current };
  for (const key of remove) delete next[key];
  for (const [key, value] of Object.entries(set)) next[key] = value;
  return next;
}

async function ensureSettingsFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile("{}\n", "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      typeof error !== "object"
      || error === null
      || !("code" in error)
      || error.code !== "EEXIST"
    ) {
      throw error;
    }
  }
}

export class PiSettingsFileEditor {
  readonly #globalPath: string;
  readonly #projectPath: string;

  constructor(options: { agentDir: string; cwd: string }) {
    this.#globalPath = join(resolve(options.agentDir), "settings.json");
    this.#projectPath = join(resolve(options.cwd), ".pi", "settings.json");
  }

  async update(
    scope: PiSettingsScope,
    set: JsonValue,
    remove: readonly string[],
  ): Promise<SettingsDocument> {
    if (!isSettingsDocument(set)) {
      throw new HostError("invalid_settings", "Settings set must be an object");
    }
    const path = scope === "global" ? this.#globalPath : this.#projectPath;
    await ensureSettingsFile(path);
    let compromised: Error | undefined;
    const release = await lockfile.lock(path, {
      onCompromised: (error) => {
        compromised = error;
      },
      realpath: false,
      retries: {
        factor: 1.5,
        forever: true,
        maxTimeout: 1_000,
        minTimeout: 20,
        randomize: true,
      },
    });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const current = parseSettingsDocument(await readFile(path, "utf8"), path);
      const next = applyTopLevelSettingsChanges(current, set, remove);
      if (compromised) throw compromised;
      await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      if (compromised) throw compromised;
      await rename(temporaryPath, path);
      return next;
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      await release();
    }
  }
}
