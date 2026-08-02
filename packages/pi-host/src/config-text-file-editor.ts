import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type PiConfigTextFormat } from "@piarium/protocol";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import lockfile from "proper-lockfile";
import { HostError } from "./errors.js";

export interface ConfigTextFileSnapshot {
  content: string;
  exists: boolean;
  revision: string;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function revisionFor(content: string, exists: boolean): string {
  return createHash("sha256")
    .update(exists ? "present\0" : "missing\0")
    .update(content)
    .digest("hex");
}

function validateContent(content: string, format: PiConfigTextFormat, path: string): void {
  let value: unknown;
  if (format === "json") {
    try {
      value = JSON.parse(content);
    } catch (error) {
      throw new HostError("invalid_config_file", `Configuration file is not valid JSON: ${path}`, {
        cause: error,
      });
    }
  } else {
    const errors: ParseError[] = [];
    value = parse(content.replace(/^\uFEFF/, ""), errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (errors.length > 0) {
      const first = errors[0];
      const issue = first
        ? `${printParseErrorCode(first.error)} at offset ${first.offset}`
        : "unknown parse error";
      throw new HostError(
        "invalid_config_file",
        `Configuration file is not valid JSONC (${issue}): ${path}`,
      );
    }
  }
  if (!isObject(value)) {
    throw new HostError("invalid_config_file", `Configuration file must contain an object: ${path}`);
  }
}

export class ConfigTextFileEditor {
  readonly #format: PiConfigTextFormat;
  readonly #path: string;

  constructor(path: string, format: PiConfigTextFormat) {
    this.#format = format;
    this.#path = path;
  }

  async read(): Promise<ConfigTextFileSnapshot> {
    try {
      const content = await readFile(this.#path, "utf8");
      return { content, exists: true, revision: revisionFor(content, true) };
    } catch (error) {
      if (isMissingFileError(error)) {
        const content = "{}\n";
        return { content, exists: false, revision: revisionFor(content, false) };
      }
      throw error;
    }
  }

  async update(content: string, expectedRevision: string): Promise<ConfigTextFileSnapshot> {
    validateContent(content, this.#format, this.#path);
    const parent = dirname(this.#path);
    await mkdir(parent, { recursive: true });
    let compromised: Error | undefined;
    const release = await lockfile.lock(parent, {
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
      if (current.revision !== expectedRevision) {
        throw new HostError(
          "config_conflict",
          `Configuration file changed since it was opened: ${this.#path}`,
          {
            details: {
              currentRevision: current.revision,
              expectedRevision,
            },
          },
        );
      }
      if (compromised) throw compromised;
      await writeFile(temporaryPath, content, "utf8");
      if (compromised) throw compromised;
      await rename(temporaryPath, this.#path);
      return {
        content,
        exists: true,
        revision: revisionFor(content, true),
      };
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      await release();
    }
  }
}
