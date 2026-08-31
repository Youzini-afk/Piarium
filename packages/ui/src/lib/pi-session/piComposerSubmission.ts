import type { MagicPromptId } from '@/lib/magicPrompts';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import {
  buildCommandVariables,
  canRunCommand,
  findMagicPromptCommand,
  parseSlashCommand,
} from '@/lib/pi-session/slashCommands';

export interface PiComposerSubmission {
  instructions?: string;
  text: string;
}

export type MagicPromptRenderer = (
  id: MagicPromptId,
  variables?: Record<string, string>,
) => Promise<string>;

export const renderPiComposerSubmission = async (
  text: string,
  renderer: MagicPromptRenderer = renderMagicPrompt,
): Promise<PiComposerSubmission> => {
  const parsed = parseSlashCommand(text);
  const command = parsed ? findMagicPromptCommand(parsed.name) : null;
  if (!command || !canRunCommand(command, { hasSession: true, hasDraft: false })) {
    return { text };
  }
  const variables = buildCommandVariables(command, parsed?.argument ?? '');
  const [visibleText, instructions] = await Promise.all([
    renderer(command.visiblePrompt, variables.visible),
    renderer(command.instructionsPrompt, variables.instructions),
  ]);
  return { instructions, text: visibleText };
};
