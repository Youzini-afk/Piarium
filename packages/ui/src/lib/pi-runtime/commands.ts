import { getPiRuntimeConnection } from './client';

export type PiCommandContext =
  | { cwd: string; sessionId?: never }
  | { cwd?: never; sessionId: string };

export const listPiCommands = async (context: PiCommandContext) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('command.list', context);
};
