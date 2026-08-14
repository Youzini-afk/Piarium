import React from 'react';
import type { JsonValue } from '@piarium/extension-contract';
import type { SurfaceContribution, SurfaceRegistrySnapshot } from '@piarium/extension-surface';
import {
  createBuiltinSurfaceController,
  piariumSurfaceRuntime,
} from '@/lib/extensions/surface-runtime';
import {
  BUILTIN_COMMANDS_EXTENSION_ID,
  registerBuiltinWorkbenchCommands,
} from './builtin-command-contributions';
import type {
  WorkbenchCommandImplementation,
  WorkbenchCommandMeta,
  WorkbenchCommandRegistration,
} from './surface-command-types';

const builtinCommandsController = createBuiltinSurfaceController({
  activate: registerBuiltinWorkbenchCommands,
  extensionId: BUILTIN_COMMANDS_EXTENSION_ID,
  extensionVersion: '0.1.0',
});

export const ensureBuiltinWorkbenchCommands = (): Promise<void> => builtinCommandsController.ensure();

export const setBuiltinWorkbenchCommandsEnabled = (enabled: boolean): Promise<void> => (
  builtinCommandsController.setEnabled(enabled)
);

const stringData = (data: Record<string, JsonValue>, key: string): string | undefined => (
  typeof data[key] === 'string' ? data[key] : undefined
);

const commandRegistration = (contribution: SurfaceContribution): WorkbenchCommandRegistration | null => {
  if (contribution.descriptor.kind !== 'command') return null;
  const data = contribution.descriptor.data;
  const commandId = stringData(data, 'commandId');
  const titleKey = stringData(data, 'titleKey');
  const icon = stringData(data, 'icon');
  const mobileTitleKey = stringData(data, 'mobileTitleKey');
  const shortcutId = stringData(data, 'shortcutId');
  const order = typeof data.order === 'number' && Number.isFinite(data.order) ? data.order : undefined;
  const keywords = Array.isArray(data.keywords)
    ? data.keywords.filter((value): value is string => typeof value === 'string')
    : [];
  const implementation = contribution.implementation as WorkbenchCommandImplementation;
  if (!commandId || !titleKey || !icon || order === undefined || typeof implementation?.execute !== 'function') {
    return null;
  }
  return {
    contributionId: contribution.descriptor.id,
    implementation,
    meta: {
      commandId,
      titleKey: titleKey as WorkbenchCommandMeta['titleKey'],
      icon: icon as WorkbenchCommandMeta['icon'],
      keywords,
      ...(mobileTitleKey ? { mobileTitleKey: mobileTitleKey as WorkbenchCommandMeta['mobileTitleKey'] } : {}),
      order,
      ...(shortcutId ? { shortcutId } : {}),
    },
  };
};

export const workbenchCommandRegistrationsFromSnapshot = (
  snapshot: SurfaceRegistrySnapshot,
): WorkbenchCommandRegistration[] => snapshot.visibleContributions
  .map(commandRegistration)
  .filter((value): value is WorkbenchCommandRegistration => value !== null);

export const useWorkbenchCommandRegistrations = (): WorkbenchCommandRegistration[] => {
  React.useEffect(() => {
    void ensureBuiltinWorkbenchCommands().catch((error) => {
      console.error('[Piarium Extensions] Failed to activate built-in workbench commands:', error);
    });
  }, []);
  const snapshot = React.useSyncExternalStore(
    piariumSurfaceRuntime.subscribe,
    piariumSurfaceRuntime.getSnapshot,
    piariumSurfaceRuntime.getSnapshot,
  );
  return React.useMemo(() => workbenchCommandRegistrationsFromSnapshot(snapshot), [snapshot]);
};
