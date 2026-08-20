import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
// @ts-expect-error Shared Web/VS Code contract fixtures are a JS module.
import { defineDocumentAuthorityContract } from '../../web/server/lib/documents/contract-fixtures.js';

type ExpectClass = new (...args: never[]) => unknown;

const expect = (value: unknown) => {
  const asRecord = (): Record<string, unknown> => {
    assert.ok(value && typeof value === 'object');
    return value as Record<string, unknown>;
  };
  return {
    toEqual(expected: unknown) {
      assert.deepEqual(value, expected);
    },
    toBe(expected: unknown) {
      assert.strictEqual(value, expected);
    },
    toBeUndefined() {
      assert.equal(value, undefined);
    },
    toBeInstanceOf(cls: ExpectClass) {
      assert.ok(value instanceof cls);
    },
    toBeGreaterThanOrEqual(expected: number) {
      assert.ok(typeof value === 'number' && value >= expected);
    },
    toContain(expected: unknown) {
      if (Array.isArray(value)) {
        assert.ok(value.includes(expected));
        return;
      }
      assert.ok(String(value).includes(String(expected)));
    },
    toHaveLength(length: number) {
      assert.ok(value && typeof value === 'object' && 'length' in value);
      assert.equal((value as { length: number }).length, length);
    },
    toMatchObject(expected: Record<string, unknown>) {
      const record = asRecord();
      for (const [key, entry] of Object.entries(expected)) {
        assert.deepEqual(record[key], entry);
      }
    },
    get not() {
      return {
        toBe(expected: unknown) {
          assert.notStrictEqual(value, expected);
        },
        toContain(expected: unknown) {
          const text = typeof value === 'string' ? value : JSON.stringify(value);
          assert.ok(!text.includes(String(expected)));
        },
      };
    },
    get rejects() {
      const promise = Promise.resolve(value);
      return {
        async toMatchObject(expected: Record<string, unknown>) {
          await assert.rejects(promise, (error: unknown) => {
            expect(error).toMatchObject(expected);
            return true;
          });
        },
        async toBeInstanceOf(cls: ExpectClass) {
          await assert.rejects(promise, (error: unknown) => error instanceof cls);
        },
        async toThrow(pattern: RegExp) {
          await assert.rejects(promise, pattern);
        },
      };
    },
  };
};

defineDocumentAuthorityContract({ describe, it, expect, beforeEach, afterEach });
