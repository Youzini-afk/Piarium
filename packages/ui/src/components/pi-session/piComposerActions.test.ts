import { describe, expect, it } from 'vitest';
import { projectPiComposerActions } from './piComposerActions';

describe('Pi composer primary action', () => {
  it('uses the primary button to stop an active response when the draft is empty', () => {
    expect(projectPiComposerActions({
      aborting: false,
      busy: true,
      canAbort: true,
      canSend: false,
      sending: false,
    })).toEqual({ primary: 'stop', showSecondaryStop: false });
  });

  it('keeps send primary and exposes stop separately when a follow-up can be sent', () => {
    expect(projectPiComposerActions({
      aborting: false,
      busy: true,
      canAbort: true,
      canSend: true,
      sending: false,
    })).toEqual({ primary: 'send', showSecondaryStop: true });
  });

  it('keeps stop available while a follow-up is being dispatched', () => {
    expect(projectPiComposerActions({
      aborting: false,
      busy: true,
      canAbort: true,
      canSend: false,
      sending: true,
    })).toEqual({ primary: 'send', showSecondaryStop: true });
  });

  it('keeps the primary stop state stable until an abort request settles', () => {
    expect(projectPiComposerActions({
      aborting: true,
      busy: false,
      canAbort: true,
      canSend: true,
      sending: false,
    })).toEqual({ primary: 'stop', showSecondaryStop: false });
  });

  it('does not invent a stop action when the session cannot abort', () => {
    expect(projectPiComposerActions({
      aborting: false,
      busy: true,
      canAbort: false,
      canSend: false,
      sending: false,
    })).toEqual({ primary: 'send', showSecondaryStop: false });
  });
});
