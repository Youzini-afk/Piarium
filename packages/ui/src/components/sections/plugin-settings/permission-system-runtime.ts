import type { PiCommandDescriptor } from '@piarium/protocol';

type PermissionSystemRuntimeState =
  | 'no-session'
  | 'loading'
  | 'failure'
  | 'not-observed'
  | 'available';

const PERMISSION_SYSTEM_COMMAND_NAME = 'permission-system';

export const permissionSystemCommandObserved = (
  commands: readonly PiCommandDescriptor[],
): boolean => commands.some((command) => (
  command.name.replace(/^\//, '') === PERMISSION_SYSTEM_COMMAND_NAME
));

export const buildPermissionSystemCommand = (): string => '/permission-system show';

export const permissionSystemRuntimeState = (input: {
  commandObserved: boolean;
  commandsChecked: boolean;
  commandsFailed: boolean;
  hasActiveSession: boolean;
}): PermissionSystemRuntimeState => {
  if (!input.hasActiveSession) return 'no-session';
  if (input.commandsFailed) return 'failure';
  if (!input.commandsChecked) return 'loading';
  return input.commandObserved ? 'available' : 'not-observed';
};
