import { expect, test } from 'bun:test';
import { piariumSurfaceRuntime } from '@/lib/extensions/surface-runtime';
import {
  ensureBuiltinWorkbenchCommands,
  setBuiltinWorkbenchCommandsEnabled,
  workbenchCommandRegistrationsFromSnapshot,
} from './surface-command-registry';

test('withdraws and restores built-in command contributions without a document refresh', async () => {
  await ensureBuiltinWorkbenchCommands();
  const registrations = workbenchCommandRegistrationsFromSnapshot(piariumSurfaceRuntime.getSnapshot());
  expect(registrations.map((registration) => registration.meta.commandId)).toEqual([
    'new-session',
    'new-worktree',
    'add-project',
    'toggle-sidebar',
    'toggle-terminal',
    'context-usage',
    'open-settings',
  ]);
  expect(registrations[3]?.meta.mobileTitleKey).toBe('commandPalette.item.showSessionSwitcher');

  await setBuiltinWorkbenchCommandsEnabled(false);
  expect(workbenchCommandRegistrationsFromSnapshot(piariumSurfaceRuntime.getSnapshot())).toEqual([]);

  await setBuiltinWorkbenchCommandsEnabled(true);
  expect(workbenchCommandRegistrationsFromSnapshot(piariumSurfaceRuntime.getSnapshot()).length).toBe(7);
});
