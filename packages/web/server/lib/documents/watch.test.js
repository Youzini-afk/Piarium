import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceWatcher } from './watch.js';

const waitForFlush = () => new Promise((resolve) => setTimeout(resolve, 60));

const createHarness = () => {
  const files = new Set();
  const events = [];
  const native = new EventEmitter();
  native.close = vi.fn();
  let onChange = () => undefined;
  const fsModule = {
    watch: vi.fn((_root, _options, listener) => {
      onChange = listener;
      return native;
    }),
  };
  const fsPromises = {
    stat: vi.fn(async (filePath) => {
      if (!files.has(filePath)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }
      return { isFile: () => true };
    }),
  };
  const rootPath = path.resolve('workspace');
  const controller = createWorkspaceWatcher({
    workspaceId: 'workspace-id',
    rootPath,
    fsModule,
    fsPromises,
    pathModule: path,
    onEvent: (event) => events.push(event),
  });
  return { controller, events, files, fsPromises, rootPath, change: (eventType, filename) => onChange(eventType, filename) };
};

describe('workspace document watcher', () => {
  it('reports deletion without requiring a prior content snapshot', async () => {
    const harness = createHarness();
    harness.change('rename', 'existing.txt');
    await waitForFlush();
    expect(harness.events).toContainEqual({
      kind: 'deleted',
      sequence: 1,
      resource: { workspaceId: 'workspace-id', resourceId: 'existing.txt' },
    });
    harness.controller.close();
  });

  it('does not impose a guessed lifetime event limit or read file bodies', async () => {
    const harness = createHarness();
    for (let index = 0; index < 300; index += 1) {
      const filename = `file-${index}.txt`;
      harness.files.add(path.join(harness.rootPath, filename));
      harness.change('rename', filename);
    }
    await waitForFlush();
    expect(harness.events.filter((event) => event.kind === 'created')).toHaveLength(300);
    expect(harness.events.some((event) => event.kind === 'reset' && event.reason === 'overflow')).toBe(false);
    expect(harness.fsPromises?.readFile).toBeUndefined();
    harness.controller.close();
  });
});
