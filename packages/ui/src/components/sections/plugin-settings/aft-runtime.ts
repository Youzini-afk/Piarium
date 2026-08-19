import type { PiCommandDescriptor } from '@piarium/protocol';

export type AftRuntimeState = 'available' | 'failure' | 'loading' | 'no-session' | 'not-observed';

export const observedAftStatusCommand = (
  commands: readonly PiCommandDescriptor[],
): boolean => commands.some((command) => command.name === 'aft-status');

export const aftRuntimeState = (input: {
  commandsChecked: boolean;
  commandsFailed: boolean;
  hasActiveSession: boolean;
  statusCommandObserved: boolean;
}): AftRuntimeState => {
  if (!input.hasActiveSession) return 'no-session';
  if (input.commandsFailed) return 'failure';
  if (!input.commandsChecked) return 'loading';
  return input.statusCommandObserved ? 'available' : 'not-observed';
};
