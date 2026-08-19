import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JsonValue } from "@piarium/protocol";
import lockfile from "proper-lockfile";
import { HostError } from "./errors.js";

export type JsonObjectDocument = { [key: string]: JsonValue };

export interface JsonObjectDocumentReadResult {
  document: JsonObjectDocument;
  exists: boolean;
  revision: string;
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

function revisionForJsonObjectContent(content: string, exists: boolean): string {
  return createHash("sha256")
    .update(exists ? "present\0" : "missing\0")
    .update(content)
    .digest("hex");
}

export class JsonObjectFileEditor {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async read(): Promise<JsonObjectDocumentReadResult> {
    try {
      const content = await readFile(this.#path, "utf8");
      return {
        document: parseJsonObjectDocument(content, this.#path),
        exists: true,
        revision: revisionForJsonObjectContent(content, true),
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return {
          document: {},
          exists: false,
          revision: revisionForJsonObjectContent("", false),
        };
      }
      throw error;
    }
  }

  async update(
    set: JsonValue,
    remove: readonly string[],
  ): Promise<JsonObjectDocument> {
    return (await this.#update(set, remove)).document;
  }

  async updateRevisioned(
    set: JsonValue,
    remove: readonly string[],
    expectedRevision: string,
  ): Promise<JsonObjectDocumentReadResult> {
    return this.#update(set, remove, expectedRevision);
  }

  async #update(
    set: JsonValue,
    remove: readonly string[],
    expectedRevision?: string,
  ): Promise<JsonObjectDocumentReadResult> {
    if (!isJsonObjectDocument(set)) {
      throw new HostError("invalid_config", "Configuration set must be an object");
    }
    const parent = dirname(this.#path);
    await mkdir(parent, { recursive: true });
    let compromised: Error | undefined;
    // Match Pi's SettingsManager/FileSettingsStorage lock identity so a
    // revision check and atomic replacement exclude every native settings writer.
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
      const current = await this.read();
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new HostError(
          "config_conflict",
          `Configuration changed since it was opened: ${this.#path}`,
          { details: { currentRevision: current.revision, expectedRevision } },
        );
      }
      const next = applyTopLevelJsonChanges(current.document, set, remove);
      const content = `${JSON.stringify(next, null, 2)}\n`;
      if (compromised) throw compromised;
      await writeFile(temporaryPath, content, "utf8");
      if (compromised) throw compromised;
      await rename(temporaryPath, this.#path);
      return {
        document: next,
        exists: true,
        revision: revisionForJsonObjectContent(content, true),
      };
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      await release();
    }
  }
}
