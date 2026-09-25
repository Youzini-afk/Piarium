const ABORT_MESSAGE = /(?:operation|request) (?:was )?aborted|aborted by (?:the )?(?:user|caller)|aborterror/i;

export const isPiAbortError = (error: unknown): boolean => {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return ABORT_MESSAGE.test(message);
};
