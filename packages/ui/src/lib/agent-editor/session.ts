import { resetEditorContextAttachments } from './attachments';
import { resetAgentFileChangeHints } from './hints';
import { resetEditorSessionLinks } from './navigation';

export const resetAgentEditorCoordination = (): void => {
  resetEditorContextAttachments();
  resetAgentFileChangeHints();
  resetEditorSessionLinks();
};
