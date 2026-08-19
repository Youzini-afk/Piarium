import type { PiCommandDescriptor } from '@piarium/protocol';

export const PI_LENS_RUNTIME_COMMANDS = [
  'lens-toggle',
  'lens-context-toggle',
  'lens-widget-toggle',
  'lens-tdi',
  'lens-map',
  'lens-health',
  'lens-perf',
  'lens-tools',
] as const;

export type PiLensRuntimeCommandId = typeof PI_LENS_RUNTIME_COMMANDS[number];

export type PiLensRuntimeState = 'no-session' | 'loading' | 'failure' | 'not-observed' | 'available';

export const piLensRuntimeCommandName = (command: PiLensRuntimeCommandId): string => command;

export const buildPiLensRuntimeCommand = (command: PiLensRuntimeCommandId): string => (
  `/${piLensRuntimeCommandName(command)}`
);

export const observedPiLensRuntimeCommands = (
  commands: readonly PiCommandDescriptor[],
): ReadonlySet<PiLensRuntimeCommandId> => {
  const known = new Set<string>(PI_LENS_RUNTIME_COMMANDS);
  return new Set(
    commands
      .map((command) => command.name.replace(/^\//, ''))
      .filter((name): name is PiLensRuntimeCommandId => known.has(name)),
  );
};

export const piLensRuntimeState = (input: {
  commandsChecked: boolean;
  commandsFailed: boolean;
  hasActiveSession: boolean;
  commandNames: ReadonlySet<PiLensRuntimeCommandId>;
}): PiLensRuntimeState => {
  if (!input.hasActiveSession) return 'no-session';
  if (input.commandsFailed) return 'failure';
  if (!input.commandsChecked) return 'loading';
  return input.commandNames.size > 0 ? 'available' : 'not-observed';
};
