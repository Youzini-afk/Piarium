import type { JsonValue } from "@piarium/protocol";
import { HostError } from "./errors.js";

export function expectRecord(value: unknown, label: string = "params"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostError("invalid_params", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function readString(
  record: Record<string, unknown>,
  key: string,
  options?: { allowEmpty?: boolean },
): string;
export function readString(
  record: Record<string, unknown>,
  key: string,
  options: { allowEmpty?: boolean; optional: true },
): string | undefined;
export function readString(
  record: Record<string, unknown>,
  key: string,
  options: { allowEmpty?: boolean; optional?: boolean } = {},
): string | undefined {
  const value = record[key];
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== "string" || (!options.allowEmpty && value.length === 0)) {
    throw new HostError(
      "invalid_params",
      options.allowEmpty ? `${key} must be a string` : `${key} must be a non-empty string`,
    );
  }
  return value;
}

export function readBoolean(record: Record<string, unknown>, key: string): boolean;
export function readBoolean(
  record: Record<string, unknown>,
  key: string,
  options: { defaultValue: boolean },
): boolean;
export function readBoolean(
  record: Record<string, unknown>,
  key: string,
  options: { optional: true },
): boolean | undefined;
export function readBoolean(
  record: Record<string, unknown>,
  key: string,
  options: { defaultValue?: boolean; optional?: boolean } = {},
): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    if (options.defaultValue !== undefined) return options.defaultValue;
    if (options.optional) return undefined;
  }
  if (typeof value !== "boolean") {
    throw new HostError("invalid_params", `${key} must be a boolean`);
  }
  return value;
}

export function readStringArray(
  record: Record<string, unknown>,
  key: string,
  options: { optional?: boolean } = {},
): string[] | undefined {
  const value = record[key];
  if (value === undefined && options.optional) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new HostError("invalid_params", `${key} must be an array of strings`);
  }
  return value;
}

export function readJson(record: Record<string, unknown>, key: string): JsonValue | undefined {
  return record[key] as JsonValue | undefined;
}
