import { beforeEach, describe, expect, test } from 'bun:test';
import type { EditorAPI, RuntimeAPIs } from './api/types';
import { openFileInMainEditor } from './openFileInMainEditor';
import { setWorkbenchWorkspaceResolutionForTests } from '@/lib/extensions/workbench-workspace';
import { activeEditorTab } from '@/lib/workbench/editors/groups';
import { peekEditorWorkbench, resetEditorWorkbenchForTests } from '@/lib/workbench/editors/session';
import { useUIStore } from '@/stores/useUIStore';

const resetStores = () => {
  resetEditorWorkbenchForTests();
  setWorkbenchWorkspaceResolutionForTests();
  useUIStore.setState({
    activeMainTab: 'chat',
    pendingFileFocusPath: null,
    pendingFileNavigation: null,
  });
};

const withWindowRuntime = async (
  apis: Partial<RuntimeAPIs> | null,
  callback: () => Promise<void> | void,
) => {
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  if (apis) {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __PIARIUM_RUNTIME_APIS__: apis,
      },
    });
  } else if (previousWindowDescriptor) {
    delete (globalThis as { window?: Window }).window;
  }

  try {
    await callback();
  } finally {
    if (previousWindowDescriptor) {
      Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
    } else {
      delete (globalThis as { window?: Window }).window;
    }
  }
};

describe('openFileInMainEditor', () => {
  beforeEach(() => {
    resetStores();
  });

  test('opens files through the VS Code editor bridge when running in VS Code', async () => {
    const calls: Array<{ path: string; line?: number; column?: number }> = [];
    const editor = {
      openFile: async (path: string, line?: number, column?: number) => {
        calls.push({ path, line, column });
      },
    } as Partial<EditorAPI> as EditorAPI;

    await withWindowRuntime({
      runtime: { platform: 'vscode', isDesktop: false, isVSCode: true, label: 'VS Code Extension' },
      editor,
    } as Partial<RuntimeAPIs>, async () => {
      const opened = openFileInMainEditor(null, '/repo/src/index.ts', { line: 7, column: 3 });

      expect(opened).toBe(true);
      expect(calls).toEqual([{ path: '/repo/src/index.ts', line: 7, column: 3 }]);
      expect(useUIStore.getState().activeMainTab).toBe('chat');
      expect(peekEditorWorkbench('workspace-1')).toBeUndefined();
    });
  });

  test('opens files in the shared files view outside VS Code', async () => {
    await withWindowRuntime(null, () => {
      setWorkbenchWorkspaceResolutionForTests('/repo', 'workspace-1');
      const opened = openFileInMainEditor('/repo', '/repo/src/index.ts');

      expect(opened).toBe(true);
      expect(useUIStore.getState().activeMainTab).toBe('files');
      const workbench = peekEditorWorkbench('workspace-1');
      expect(workbench ? activeEditorTab(workbench)?.resourceId : undefined).toBe('src/index.ts');
    });
  });
});
