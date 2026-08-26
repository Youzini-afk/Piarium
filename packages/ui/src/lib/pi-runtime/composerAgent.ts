import type { PiAgentDescriptor, PiAgentInvocationDescriptor } from '@piarium/protocol';

export interface PiComposerAgentSelection {
  description: string;
  id: string;
  invocation: PiAgentInvocationDescriptor;
  name: string;
  providerId: string;
}

export const composerAgentSelection = (
  agent: PiAgentDescriptor,
): PiComposerAgentSelection | null => (
  agent.status === 'available' && agent.invocation
    ? {
        description: agent.description,
        id: agent.id,
        invocation: agent.invocation,
        name: agent.name,
        providerId: agent.providerId,
      }
    : null
);

export const renderPiComposerAgentInvocation = (
  text: string,
  selection: PiComposerAgentSelection,
  instructions?: string,
): string => {
  const command = selection.invocation.command.trim().replace(/^\/+/, '');
  const task = [text.trim(), instructions?.trim()]
    .filter((value): value is string => Boolean(value))
    .join('\n\n');
  const separator = selection.invocation.taskSeparator === 'double-dash' ? ' -- ' : ' ';
  return `/${command} ${selection.name}${separator}${task}`.trimEnd();
};
