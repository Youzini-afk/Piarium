import type { PiExtensionNotice } from '@/stores/usePiInteractionStore';

const WORKSPACE_HISTORY_INITIALIZATION_NOTICE =
  'Initializing workspace history for this project. The first prompt may take a moment.';

/**
 * Piarium already keeps the first submitted turn visibly busy. Repeating the workspace-history
 * preflight notice for every new session adds an acknowledgement toast without giving the user an
 * action. The plugin's later "finishing its initial snapshot" notice and every warning/error remain
 * visible because those report an actual wait or failure rather than a possibility.
 */
export const shouldPresentPiExtensionNotice = (notice: PiExtensionNotice): boolean => !(
  notice.type === 'info' && notice.message === WORKSPACE_HISTORY_INITIALIZATION_NOTICE
);
