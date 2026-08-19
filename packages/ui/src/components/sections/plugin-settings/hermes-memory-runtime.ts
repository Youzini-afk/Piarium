import type { PiCommandDescriptor } from '@piarium/protocol';

export type HermesMemoryRuntimeState = 'available' | 'failure' | 'loading' | 'no-session' | 'not-observed';

export const observedHermesMemoryCommand = (
  commands: readonly PiCommandDescriptor[],
): boolean => commands.some((command) => command.name === 'memory-insights');

export const hermesMemoryRuntimeState = (input: {
  commandsChecked: boolean;
  commandsFailed: boolean;
  hasActiveSession: boolean;
  signatureObserved: boolean;
}): HermesMemoryRuntimeState => {
  if (!input.hasActiveSession) return 'no-session';
  if (input.commandsFailed) return 'failure';
  if (!input.commandsChecked) return 'loading';
  return input.signatureObserved ? 'available' : 'not-observed';
};
