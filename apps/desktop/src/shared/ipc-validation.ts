import type { ImageAttachment, JsonValue } from "@piarium/protocol";

export const MAX_IMAGE_COUNT = 8;
export const MAX_IMAGE_DATA_LENGTH = 3 * 1024 * 1024;
export const MAX_JSON_VALUE_LENGTH = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readImageAttachments(value: unknown): ImageAttachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("images must be an array");
  if (value.length > MAX_IMAGE_COUNT) {
    throw new TypeError(`images must contain at most ${MAX_IMAGE_COUNT} items`);
  }

  let encodedLength = 0;
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new TypeError(`images[${index}] must be an object`);
    const { data, mimeType } = entry;
    if (typeof data !== "string" || data.length === 0) {
      throw new TypeError(`images[${index}].data must be a non-empty string`);
    }
    if (typeof mimeType !== "string" || !/^image\/[a-z0-9.+-]{1,64}$/i.test(mimeType)) {
      throw new TypeError(`images[${index}].mimeType must be an image MIME type`);
    }
    encodedLength += data.length;
    if (encodedLength > MAX_IMAGE_DATA_LENGTH) {
      throw new TypeError("encoded image data exceeds the desktop IPC limit");
    }
    return { data, mimeType };
  });
}

export function readJsonValue(
  value: unknown,
  label: string,
  maximumLength: number = MAX_JSON_VALUE_LENGTH,
): JsonValue {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new TypeError(`${label} must be valid JSON`);
  }
  if (encoded === undefined) throw new TypeError(`${label} must be valid JSON`);
  if (encoded.length > maximumLength) throw new TypeError(`${label} exceeds the IPC size limit`);
  return JSON.parse(encoded) as JsonValue;
}

export function readJsonRecord(value: unknown, label: string): Record<string, JsonValue> {
  const parsed = readJsonValue(value, label);
  if (!isRecord(parsed)) throw new TypeError(`${label} must be an object`);
  return parsed as Record<string, JsonValue>;
}
