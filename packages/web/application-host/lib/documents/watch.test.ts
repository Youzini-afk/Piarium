import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceWatcher,
  type NativeWatcher,
  type WatchEvent,
  type WorkspaceWatchFs,
  type WorkspaceWatchFsPromises,
} from './watch.js';

const waitForFlush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

const createHarness = () => {
  const files = new Set<string>();
  const events: WatchEvent[] = [];
  const native = Object.assign(new EventEmitter(), { close: vi.fn() }) as EventEmitter & NativeWatcher;
  let onChange: (eventType: string, filename: string | Buffer | null) => void = () => undefined;
  const fsModule: WorkspaceWatchFs = {
    watch: vi.fn((_root, _options, listener) => {
      onChange = listener;
      return native;
    }),
  };
  const fsPromises: WorkspaceWatchFsPromises = {
    stat: vi.fn(async (filePath: string) => {
      if (!files.has(filePath)) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
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
    sourceId: 'watch-source',
    onEvent: (event) => events.push(event),
  });
  return {
    controller,
    events,
    files,
    fsPromises,
    rootPath,
    change: (eventType: string, filename: string) => onChange(eventType, filename),
  };
};

describe('workspace document watcher', () => {
  it('reports deletion without requiring a prior content snapshot', async () => {
    const harness = createHarness();
    harness.change('rename', 'existing.txt');
    await waitForFlush();
    expect(harness.events).toContainEqual({
      kind: 'deleted',
      sourceId: 'watch-source',
      generation: 1,
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
    expect('readFile' in harness.fsPromises).toBe(false);
    harness.controller.close();
  });
});
