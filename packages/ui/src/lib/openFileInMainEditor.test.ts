import { beforeEach, describe, expect, test } from 'bun:test';
import type { EditorAPI, RuntimeAPIs } from './api/types';
import { openFileInMainEditor } from './openFileInMainEditor';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore } from '@/stores/useUIStore';

const resetStores = () => {
  useFilesViewTabsStore.setState({ byRoot: {} });
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
        __OPENCHAMBER_RUNTIME_APIS__: apis,
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
      expect(useFilesViewTabsStore.getState().byRoot).toEqual({});
    });
  });

  test('opens files in the shared files view outside VS Code', async () => {
    await withWindowRuntime(null, () => {
      const opened = openFileInMainEditor('/repo', '/repo/src/index.ts');

      expect(opened).toBe(true);
      expect(useUIStore.getState().activeMainTab).toBe('files');
      expect(useFilesViewTabsStore.getState().byRoot['/repo']?.selectedPath).toBe('/repo/src/index.ts');
    });
  });
});
