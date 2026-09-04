export interface Utf8ByteSlice {
  text: string;
  offset: number;
  length: number;
  nextOffset: number;
  total: number;
  eof: boolean;
}

const isContinuationByte = (value: number | undefined): boolean => (
  value !== undefined && (value & 0xc0) === 0x80
);

/**
 * Slice text using UTF-8 byte offsets without ever returning a partial code
 * point. A start inside a code point moves to its leading byte. If a requested
 * page is smaller than the next code point, the page expands just enough to
 * make forward progress; callers must continue from nextOffset.
 */
export function sliceUtf8ByBytes(
  value: string | Uint8Array,
  requestedOffset = 0,
  requestedLength = 32_768,
): Utf8ByteSlice {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const total = bytes.length;
  let offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.floor(requestedOffset)) : 0;
  const length = Number.isFinite(requestedLength) ? Math.max(1, Math.floor(requestedLength)) : 32_768;
  offset = Math.min(offset, total);
  while (offset > 0 && offset < total && isContinuationByte(bytes[offset])) offset -= 1;

  let end = Math.min(total, offset + length);
  while (end > offset && end < total && isContinuationByte(bytes[end])) end -= 1;
  if (end === offset && offset < total) {
    end = offset + 1;
    while (end < total && isContinuationByte(bytes[end])) end += 1;
  }

  return {
    text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, end)),
    offset,
    length: end - offset,
    nextOffset: end,
    total,
    eof: end >= total,
  };
}
