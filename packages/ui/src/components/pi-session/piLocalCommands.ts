import { parseSlashCommand } from '@/components/chat/composer/submit/slashCommands';

export type PiLocalCommand = {
  kind: 'tree';
  query: string;
};

export const parsePiLocalCommand = (text: string): PiLocalCommand | null => {
  const command = parseSlashCommand(text);
  if (command?.name !== 'tree') return null;
  return { kind: 'tree', query: command.argument };
};

