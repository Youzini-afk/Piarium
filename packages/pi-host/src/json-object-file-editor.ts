import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JsonValue } from "@piarium/protocol";
import lockfile from "proper-lockfile";
import { HostError } from "./errors.js";

export type JsonObjectDocument = { [key: string]: JsonValue };

export interface JsonObjectDocumentReadResult {
  document: JsonObjectDocument;
  exists: boolean;
}

function isJsonObjectDocument(value: unknown): value is JsonObjectDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObjectDocument(raw: string, path: string): JsonObjectDocument {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new HostError(
      "invalid_config_file",
      `Configuration file is not valid JSON: ${path}`,
      { cause: error },
    );
  }
  if (!isJsonObjectDocument(value)) {
    throw new HostError(
      "invalid_config_file",
      `Configuration file must contain an object: ${path}`,
    );
  }
  return value;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

export function applyTopLevelJsonChanges(
  current: JsonObjectDocument,
  set: JsonObjectDocument,
  remove: readonly string[],
): JsonObjectDocument {
  const next = { ...current };
  for (const key of remove) delete next[key];
  for (const [key, value] of Object.entries(set)) next[key] = value;
  return next;
}

async function ensureJsonObjectFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile("{}\n", "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isFileExistsError(error)) throw error;
  }
}

export class JsonObjectFileEditor {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async read(): Promise<JsonObjectDocumentReadResult> {
    try {
      return {
        document: parseJsonObjectDocument(await readFile(this.#path, "utf8"), this.#path),
        exists: true,
      };
    } catch (error) {
      if (isMissingFileError(error)) return { document: {}, exists: false };
      throw error;
    }
  }

  async update(
    set: JsonValue,
    remove: readonly string[],
  ): Promise<JsonObjectDocument> {
    if (!isJsonObjectDocument(set)) {
      throw new HostError("invalid_config", "Configuration set must be an object");
    }
    await ensureJsonObjectFile(this.#path);
    let compromised: Error | undefined;
    const release = await lockfile.lock(this.#path, {
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
    const temporaryPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const current = parseJsonObjectDocument(
        await readFile(this.#path, "utf8"),
        this.#path,
      );
      const next = applyTopLevelJsonChanges(current, set, remove);
      if (compromised) throw compromised;
      await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      if (compromised) throw compromised;
      await rename(temporaryPath, this.#path);
      return next;
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      await release();
    }
  }
}
