import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_IMAGE_COUNT,
  MAX_IMAGE_DATA_LENGTH,
  readImageAttachments,
  readJsonRecord,
  readJsonValue,
} from "../src/shared/ipc-validation.js";

describe("desktop IPC validation", () => {
  it("accepts bounded image attachments and clones the payload", () => {
    const input = [{ data: "aGVsbG8=", mimeType: "image/png" }];
    const parsed = readImageAttachments(input);
    assert.deepEqual(parsed, input);
    assert.notEqual(parsed, input);
  });

  it("rejects excessive or malformed image payloads", () => {
    assert.throws(
      () => readImageAttachments(Array.from({ length: MAX_IMAGE_COUNT + 1 }, () => ({}))),
      /at most/,
    );
    assert.throws(
      () => readImageAttachments([{ data: "x", mimeType: "text/plain" }]),
      /image MIME type/,
    );
    assert.throws(
      () =>
        readImageAttachments([
          { data: "x".repeat(MAX_IMAGE_DATA_LENGTH + 1), mimeType: "image/png" },
        ]),
      /IPC limit/,
    );
  });

  it("accepts JSON records while rejecting cycles, scalars, and oversized values", () => {
    assert.deepEqual(readJsonRecord({ retryEnabled: true }, "settings"), { retryEnabled: true });
    assert.throws(() => readJsonRecord([], "settings"), /must be an object/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => readJsonValue(cyclic, "value"), /valid JSON/);
    assert.throws(() => readJsonValue("12345", "value", 4), /size limit/);
  });
});
