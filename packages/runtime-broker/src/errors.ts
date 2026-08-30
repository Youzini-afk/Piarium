import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  PI_RUNTIME_ISSUE_CODES,
  PI_RUNTIME_ISSUE_HOST_ENTRY_UNAVAILABLE,
  type JsonValue,
  type PiRuntimeIssueCode,
} from "@piarium/protocol";

export class PiRuntimeNotReadyError extends Error {
  readonly code = "runtime_not_ready";

  constructor(message = "Pi runtime is not ready") {
    super(message);
    this.name = "PiRuntimeNotReadyError";
  }
}

export class PiRuntimeBrokerError extends Error {
  readonly code: string;
  readonly details: JsonValue | undefined;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    options: { details?: JsonValue; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "PiRuntimeBrokerError";
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

export class PiHostEntryUnavailableError extends PiRuntimeBrokerError {
  readonly candidates: readonly string[];

  constructor(candidates: readonly string[]) {
    const normalized = [...new Set(candidates.map((candidate) => resolve(candidate)))];
    super(
      PI_RUNTIME_ISSUE_HOST_ENTRY_UNAVAILABLE,
      `Piarium installation files required to start Pi are missing or unavailable. `
        + `Reinstall Piarium; changing the selected Pi runtime will not repair these application files. `
        + `Checked: ${normalized.join(", ")}`,
      { details: { checkedPaths: normalized }, retryable: true },
    );
    this.name = "PiHostEntryUnavailableError";
    this.candidates = normalized;
  }
}

const isAsarArchiveEntry = (entry: string): boolean => resolve(entry)
  .split(sep)
  .some((segment) => segment.toLowerCase() === "app.asar");

export const isExternalPiHostEntry = (entry: string): boolean => {
  if (isAsarArchiveEntry(entry)) return false;
  try {
    return statSync(resolve(entry)).isFile();
  } catch {
    return false;
  }
};

export const assertExternalPiHostEntry = (entry: string): string => {
  const normalized = resolve(entry);
  if (!isExternalPiHostEntry(normalized)) {
    throw new PiHostEntryUnavailableError([normalized]);
  }
  return normalized;
};

export const piRuntimeIssueCodeFromError = (error: unknown): PiRuntimeIssueCode | undefined => {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && (PI_RUNTIME_ISSUE_CODES as readonly string[]).includes(code)
    ? code as PiRuntimeIssueCode
    : undefined;
};
