import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createDocumentAuthorityHarness, defineDocumentAuthorityContract } from '../../web/server/lib/documents/contract-fixtures.js';
import { runVSCodeMutation, runVSCodeProcessMutation } from './documents-runtime';

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
    toBeGreaterThan(expected: number) {
      assert.ok(typeof value === 'number' && value > expected);
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

describe('VS Code native mutation wiring', () => {
  it('tracks workspace FS writes, leaves outside writes unscoped, and rejects maintenance', async () => {
    const harness = await createDocumentAuthorityHarness();
    const workspace = {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: harness.workspaceRoot } }],
    };
    const workspacePath = path.join(harness.workspaceRoot, 'native.txt');
    const outsidePath = path.join(harness.root, 'outside.txt');
    try {
      const before = await harness.authority.inspectMutation(harness.identity.workspaceId);
      await runVSCodeMutation({
        workspace,
        documents: harness.authority,
        targetPaths: [workspacePath],
        owner: { kind: 'vscode-fs', id: 'native-write' },
        operation: () => writeFile(workspacePath, 'tracked'),
      });
      const after = await harness.authority.inspectMutation(harness.identity.workspaceId);
      assert.ok(after.mutationRevision > before.mutationRevision);

      const beforeOutside = after.mutationRevision;
      await runVSCodeMutation({
        workspace,
        documents: harness.authority,
        targetPaths: [outsidePath],
        owner: { kind: 'vscode-fs', id: 'outside-write' },
        operation: () => writeFile(outsidePath, 'unscoped'),
      });
      const afterOutside = await harness.authority.inspectMutation(harness.identity.workspaceId);
      assert.equal(afterOutside.mutationRevision, beforeOutside);

      await harness.authority.setMaintenance(harness.identity.workspaceId, true);
      await assert.rejects(
        runVSCodeMutation({
          workspace,
          documents: harness.authority,
          targetPaths: [path.join(harness.workspaceRoot, 'maintenance.txt')],
          owner: { kind: 'vscode-fs', id: 'maintenance-write' },
          operation: () => writeFile(path.join(harness.workspaceRoot, 'maintenance.txt'), 'blocked'),
        }),
        (error: unknown) => (error as { code?: string })?.code === 'maintenance',
      );
    } finally {
      await harness.cleanup();
    }
  });

  it('keeps process writers alive through completion and releases them on failure', async () => {
    const events: string[] = [];
    const workspace = {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
    };
    const documents = {
      runMutationForScope: async <T>(_scope: string, _owner: unknown, operation: () => T | PromiseLike<T>) => await operation(),
      registerWriterForScope: async () => {
        events.push('register');
        return {
          markMutated: async () => { events.push('mark'); },
          close: async () => { events.push('close'); },
        };
      },
    };

    await runVSCodeProcessMutation({
      workspace,
      documents,
      targetPaths: [process.cwd()],
      owner: { kind: 'vscode-shell', id: 'process' },
      purpose: 'vscode-shell-exec',
      operation: async () => {
        events.push('operation');
        await Promise.resolve();
      },
    });
    assert.deepEqual(events, ['register', 'operation', 'mark', 'close']);

    events.length = 0;
    await assert.rejects(runVSCodeProcessMutation({
      workspace,
      documents,
      targetPaths: [process.cwd()],
      owner: { kind: 'vscode-shell', id: 'failed-process' },
      purpose: 'vscode-shell-exec',
      operation: async () => {
        events.push('operation');
        throw new Error('process failed');
      },
    }), /process failed/);
    assert.deepEqual(events, ['register', 'operation', 'mark', 'close']);
  });
});
