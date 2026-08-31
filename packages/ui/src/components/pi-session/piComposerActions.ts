export type PiComposerPrimaryAction = 'send' | 'stop';

interface PiComposerActionInput {
  aborting: boolean;
  busy: boolean;
  canAbort: boolean;
  canSend: boolean;
  sending: boolean;
}

interface PiComposerActionProjection {
  primary: PiComposerPrimaryAction;
  showSecondaryStop: boolean;
}

export const projectPiComposerActions = ({
  aborting,
  busy,
  canAbort,
  canSend,
  sending,
}: PiComposerActionInput): PiComposerActionProjection => {
  const stopAvailable = canAbort && (busy || aborting);
  const primary = stopAvailable && (aborting || (!canSend && !sending))
    ? 'stop'
    : 'send';
  return {
    primary,
    showSecondaryStop: stopAvailable && primary !== 'stop',
  };
};
