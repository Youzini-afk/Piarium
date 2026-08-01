import type { WireEnvelope } from "./envelopes.js";
import { type JsonValue, PIARIUM_PROTOCOL_VERSION } from "./types.js";

const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;

export class ProtocolDecodeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProtocolDecodeError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolDecodeError("invalid_envelope", `${field} must be a non-empty string`);
  }
}

export function decodeEnvelope(frame: string): WireEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    throw new ProtocolDecodeError("invalid_json", "Protocol frame is not valid JSON");
  }

  if (!isRecord(value)) {
    throw new ProtocolDecodeError("invalid_envelope", "Protocol frame must be a JSON object");
  }
  if (value.v !== PIARIUM_PROTOCOL_VERSION) {
    throw new ProtocolDecodeError(
      "unsupported_version",
      `Unsupported protocol version: ${String(value.v)}`,
    );
  }

  switch (value.kind) {
    case "request":
      requireNonEmptyString(value.id, "id");
      requireNonEmptyString(value.method, "method");
      if (!("params" in value)) {
        throw new ProtocolDecodeError("invalid_envelope", "request.params is required");
      }
      break;
    case "response":
      requireNonEmptyString(value.id, "id");
      if (typeof value.ok !== "boolean") {
        throw new ProtocolDecodeError("invalid_envelope", "response.ok must be a boolean");
      }
      if (value.ok && !("result" in value)) {
        throw new ProtocolDecodeError("invalid_envelope", "successful response.result is required");
      }
      if (!value.ok && !isRecord(value.error)) {
        throw new ProtocolDecodeError("invalid_envelope", "failed response.error is required");
      }
      break;
    case "event":
      requireNonEmptyString(value.event, "event");
      if (!Number.isSafeInteger(value.seq) || Number(value.seq) < 0) {
        throw new ProtocolDecodeError(
          "invalid_envelope",
          "event.seq must be a non-negative integer",
        );
      }
      if (!("data" in value)) {
        throw new ProtocolDecodeError("invalid_envelope", "event.data is required");
      }
      break;
    default:
      throw new ProtocolDecodeError("invalid_envelope", "Unknown protocol envelope kind");
  }

  return value as WireEnvelope;
}

export function encodeEnvelope(envelope: WireEnvelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

export interface JsonLineDecoderOptions {
  maxFrameBytes?: number;
}

export class JsonLineDecoder {
  readonly #decoder = new TextDecoder();
  readonly #encoder = new TextEncoder();
  readonly #maxFrameBytes: number;
  #buffer = "";

  constructor(options: JsonLineDecoderOptions = {}) {
    this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (!Number.isSafeInteger(this.#maxFrameBytes) || this.#maxFrameBytes <= 0) {
      throw new RangeError("maxFrameBytes must be a positive integer");
    }
  }

  push(chunk: string | Uint8Array): WireEnvelope[] {
    this.#buffer +=
      typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
    this.#assertWithinLimit();

    const envelopes: WireEnvelope[] = [];
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      let frame = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (frame.endsWith("\r")) frame = frame.slice(0, -1);
      if (frame.length > 0) envelopes.push(decodeEnvelope(frame));
      this.#assertWithinLimit();
      newline = this.#buffer.indexOf("\n");
    }
    return envelopes;
  }

  finish(): WireEnvelope[] {
    this.#buffer += this.#decoder.decode();
    if (this.#buffer.length === 0) return [];
    this.#assertWithinLimit();
    const frame = this.#buffer.endsWith("\r") ? this.#buffer.slice(0, -1) : this.#buffer;
    this.#buffer = "";
    return frame.length === 0 ? [] : [decodeEnvelope(frame)];
  }

  #assertWithinLimit(): void {
    if (this.#encoder.encode(this.#buffer).byteLength > this.#maxFrameBytes) {
      this.#buffer = "";
      throw new ProtocolDecodeError(
        "frame_too_large",
        "Protocol frame exceeds the configured limit",
      );
    }
  }
}

export function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
