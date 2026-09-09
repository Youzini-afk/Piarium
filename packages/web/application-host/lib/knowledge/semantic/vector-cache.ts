/**
 * In-process vector reuse. Identity is space + purpose + the text actually
 * sent to the backend. A full cache never rejects a query; it only evicts.
 */

import type { SemanticEmbedPurpose } from "./embedder.js";
import { embedTextKey } from "./identity.js";

export const DEFAULT_VECTOR_CACHE_BYTES = 64 * 1024 * 1024;

export type VectorCacheKey = {
  spaceId: string;
  purpose: SemanticEmbedPurpose;
  embedText: string;
};

const keyOf = (input: VectorCacheKey): string => (
  `${input.spaceId}\0${input.purpose}\0${embedTextKey(input.embedText)}`
);

const vectorBytes = (vector: readonly number[]): number => vector.length * 8 + 64;

export function createVectorCache(options?: { maxBytes?: number }) {
  const maxBytes = options?.maxBytes ?? DEFAULT_VECTOR_CACHE_BYTES;
  const entries = new Map<string, { vector: number[]; bytes: number; touch: number }>();
  let usedBytes = 0;
  let clock = 0;

  const evict = (needed: number): void => {
    if (maxBytes <= 0) {
      entries.clear();
      usedBytes = 0;
      return;
    }
    while (usedBytes + needed > maxBytes && entries.size > 0) {
      let oldestKey: string | undefined;
      let oldestTouch = Number.POSITIVE_INFINITY;
      for (const [key, entry] of entries) {
        if (entry.touch < oldestTouch) {
          oldestTouch = entry.touch;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      const removed = entries.get(oldestKey);
      entries.delete(oldestKey);
      usedBytes = Math.max(0, usedBytes - (removed?.bytes ?? 0));
    }
  };

  return {
    get usedBytes() { return usedBytes; },
    get size() { return entries.size; },
    get(input: VectorCacheKey): number[] | undefined {
      const entry = entries.get(keyOf(input));
      if (!entry) return undefined;
      entry.touch = ++clock;
      return entry.vector;
    },
    set(input: VectorCacheKey, vector: readonly number[]): void {
      const key = keyOf(input);
      const bytes = vectorBytes(vector);
      const previous = entries.get(key);
      if (previous) usedBytes = Math.max(0, usedBytes - previous.bytes);
      if (bytes > maxBytes) {
        entries.delete(key);
        return;
      }
      evict(bytes);
      entries.set(key, { vector: [...vector], bytes, touch: ++clock });
      usedBytes += bytes;
    },
    clear(): void {
      entries.clear();
      usedBytes = 0;
    },
  };
}

export type SemanticVectorCache = ReturnType<typeof createVectorCache>;
