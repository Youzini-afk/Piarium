import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkspaceContentSearch } from './content.js';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';

const createFakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit('close', null);
  };
  return child;
};

const matchLine = (absolutePath, preview) => JSON.stringify({
  type: 'match',
  data: {
    path: { text: absolutePath },
    line_number: 2,
    lines: { text: `${preview}\n` },
    submatches: [{ start: 0, end: 4 }],
  },
});

describe('workspace content search', () => {
  it('returns ready hits, empty success, and failure without mapping errors to empty', async () => {
    const harness = await createDocumentAuthorityHarness();
    try {
      const notePath = path.join(harness.workspaceRoot, 'note.txt');
      let mode = 'ready';
      const search = createWorkspaceContentSearch({
        documents: harness.authority,
        pathModule: path,
        spawn: () => {
          if (mode === 'throw') {
            const error = new Error('missing ripgrep');
            error.code = 'ENOENT';
            throw error;
          }
          const child = createFakeChild();
          queueMicrotask(() => {
            if (mode === 'ready') {
              child.stdout.write(`${matchLine(notePath, 'todo item')}\n`);
              child.emit('close', 0);
              return;
            }
            if (mode === 'empty') {
              child.emit('close', 1);
              return;
            }
            child.emit('close', 2);
          });
          return child;
        },
      });

      const ready = await search.searchContent({
        workspaceId: harness.identity.workspaceId,
        query: 'todo',
      }, { generation: 3 });
      expect(ready).toMatchObject({
        status: 'ready',
        generation: 3,
        hits: [{
          resource: { workspaceId: harness.identity.workspaceId, resourceId: 'note.txt' },
          line: 2,
          preview: 'todo item',
        }],
      });

      mode = 'empty';
      const empty = await search.searchContent({
        workspaceId: harness.identity.workspaceId,
        query: 'todo',
      }, { generation: 3 });
      expect(empty).toEqual({ status: 'empty', generation: 3 });

      mode = 'throw';
      const missing = await search.searchContent({
        workspaceId: harness.identity.workspaceId,
        query: 'todo',
      }, { generation: 3 });
      expect(missing.status).toBe('failure');
      expect(missing).not.toMatchObject({ status: 'empty' });
      expect(missing.message).toMatch(/ripgrep/i);

      mode = 'fail';
      const failed = await search.searchContent({
        workspaceId: harness.identity.workspaceId,
        query: 'todo',
      }, { generation: 3 });
      expect(failed).toEqual({ status: 'failure', generation: 3, message: 'Content search failed' });
    } finally {
      await harness.cleanup();
    }
  });

  it('cancels an in-flight search by killing the child process', async () => {
    const harness = await createDocumentAuthorityHarness();
    try {
      let child;
      const search = createWorkspaceContentSearch({
        documents: harness.authority,
        pathModule: path,
        spawn: () => {
          child = createFakeChild();
          return child;
        },
      });
      const controller = new AbortController();
      const pending = search.searchContent({
        workspaceId: harness.identity.workspaceId,
        query: 'todo',
      }, { generation: 4, signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      await expect(pending).resolves.toEqual({ status: 'cancelled', generation: 4 });
      expect(child.killed).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  it('streams results and stops ripgrep at the requested global result count', async () => {
    const harness = await createDocumentAuthorityHarness();
    try {
      const firstPath = path.join(harness.workspaceRoot, 'first.txt');
      const secondPath = path.join(harness.workspaceRoot, 'second.txt');
      let child;
      let args;
      const search = createWorkspaceContentSearch({
        documents: harness.authority,
        pathModule: path,
        spawn: (_command, nextArgs) => {
          args = nextArgs;
          child = createFakeChild();
          queueMicrotask(() => {
            const output = `${matchLine(firstPath, 'first')}\n${matchLine(secondPath, 'second')}\n`;
            child.stdout.write(output.slice(0, 17));
            child.stdout.write(output.slice(17));
          });
          return child;
        },
      });

      const result = await search.searchContent({
        workspaceId: harness.identity.workspaceId,
        query: 'match',
        maxResults: 1,
      }, { generation: 5 });

      expect(result).toMatchObject({ status: 'ready', generation: 5, hits: [{ preview: 'first' }] });
      expect(result.hits).toHaveLength(1);
      expect(child.killed).toBe(true);
      expect(args).not.toContain('--max-count');
    } finally {
      await harness.cleanup();
    }
  });
});
