import { describe, expect, test } from 'vitest';

import {
  eventMatchesShortcut,
  getShortcutAction,
  isRiskyBrowserShortcut,
  UNASSIGNED_SHORTCUT,
} from './shortcuts';

const event = (overrides: Partial<KeyboardEvent>): KeyboardEvent => ({
  altKey: false,
  code: '',
  ctrlKey: false,
  key: '',
  metaKey: false,
  shiftKey: false,
  ...overrides,
}) as KeyboardEvent;

describe('editor and workspace shortcut defaults', () => {
  test('keeps workspace search separate from the legacy Files surface', () => {
    expect(getShortcutAction('toggle_files')?.defaultCombo).toBe('mod+shift+f');
    expect(getShortcutAction('open_right_sidebar_files')?.defaultCombo).toBe(UNASSIGNED_SHORTCUT);
    expect(eventMatchesShortcut(
      event({ code: 'KeyF', ctrlKey: true, key: 'f', shiftKey: true }),
      getShortcutAction('toggle_files')!,
    )).toBe(true);
  });

  test('does not assign common editor chords to unrelated global actions', () => {
    expect(getShortcutAction('open_go_to_line')?.defaultCombo).toBe('mod+g');
    expect(getShortcutAction('open_help')?.defaultCombo).toBe('mod+shift+period');
    expect(getShortcutAction('toggle_services_menu')?.defaultCombo).toBe('mod+alt+s');
    expect(['mod+h', 'mod+alt+f']).toContain(getShortcutAction('editor_replace')?.defaultCombo);
    expect(isRiskyBrowserShortcut('mod+h')).toBe(true);
  });
});
