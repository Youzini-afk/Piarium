import { afterEach, describe, expect, test } from 'bun:test';
import { projectWorkbenchMenu, registerWorkbenchMenuItem, resetWorkbenchMenus } from './menus';
import { clearWorkbenchContextKeys, setWorkbenchContextKey } from './context-keys';

afterEach(() => {
  resetWorkbenchMenus();
  clearWorkbenchContextKeys();
});

describe('workbench menus', () => {
  test('projects items for the requested group when context matches', () => {
    registerWorkbenchMenuItem({
      id: 'split',
      commandId: 'workbench.action.splitEditor',
      group: 'editor/tab',
      order: 2,
      when: { editorIsOpen: true },
    });
    registerWorkbenchMenuItem({
      id: 'always',
      commandId: 'workbench.action.closeActiveEditor',
      group: 'editor/tab',
      order: 1,
    });
    registerWorkbenchMenuItem({
      id: 'other',
      commandId: 'workbench.action.splitEditorOrthogonal',
      group: 'editor/title',
      order: 1,
    });

    expect(projectWorkbenchMenu('editor/tab').map((item) => item.id)).toEqual(['always']);
    setWorkbenchContextKey('editorIsOpen', true);
    expect(projectWorkbenchMenu('editor/tab').map((item) => item.id)).toEqual(['always', 'split']);
    expect(projectWorkbenchMenu('editor/title').map((item) => item.id)).toEqual(['other']);
  });
});
