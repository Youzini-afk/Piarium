import type { MultiRunAgentSelection } from '@/types/multirun';

export const renderPiAgentInvocation = (
  agent: MultiRunAgentSelection,
  task: string,
): string => {
  const { command, taskSeparator } = agent.invocation;
  if (!/^[\w:-]+$/u.test(command) || !/^[\p{L}\p{N}_.:-]+$/u.test(agent.name)) {
    throw new Error(`Agent ${agent.name} exposes an invalid invocation contract`);
  }
  const separator = taskSeparator === 'double-dash' ? ' -- ' : ' ';
  return `/${command} ${agent.name}${separator}${task}`;
};
