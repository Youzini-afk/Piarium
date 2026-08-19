import type { PiCommandDescriptor } from '@piarium/protocol';

export type RtkRuntimeAction = 'clear-stats' | 'show' | 'stats' | 'verify';
type RtkRuntimeState = 'available' | 'failure' | 'loading' | 'no-session' | 'not-observed';

export const rtkCommandObserved = (
  commands: readonly PiCommandDescriptor[],
): boolean => commands.some((command) => command.name === 'rtk');

export const buildRtkCommand = (action: RtkRuntimeAction): string => `/rtk ${action}`;

export const rtkRuntimeState = (input: {
  commandObserved: boolean;
  commandsChecked: boolean;
  commandsFailed: boolean;
  hasActiveSession: boolean;
}): RtkRuntimeState => {
  if (!input.hasActiveSession) return 'no-session';
  if (input.commandsFailed) return 'failure';
  if (!input.commandsChecked) return 'loading';
  return input.commandObserved ? 'available' : 'not-observed';
};
