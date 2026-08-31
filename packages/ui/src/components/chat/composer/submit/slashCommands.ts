/**
 * The composer's local slash commands.
 *
 * Most of them do the same thing: render a pair of magic prompts — one the
 * user sees, one the model is instructed with — and send them as a single
 * message. That shape was previously written out nine times as an `else if`
 * chain, so adding a command meant copying twenty lines and remembering to
 * change every string in them. Here the shape is the executor and the
 * commands are data.
 *
 * Commands that are not "send a prompt pair" (undo, redo, timeline, compact,
 * handoff-review) stay with the composer: they manipulate session state or
 * open UI rather than producing a message.
 *
 * The canonical location is now lib/pi-session/slashCommands.ts so that
 * stores and other lib consumers can import it without crossing the
 * components boundary. This file re-exports for backward compatibility.
 */

export {
  type CommandRequirement,
  type MagicPromptCommand,
  MAGIC_PROMPT_COMMANDS,
  type ParsedSlashCommand,
  parseSlashCommand,
  findMagicPromptCommand,
  canRunCommand,
  buildCommandVariables,
} from '@/lib/pi-session/slashCommands';
