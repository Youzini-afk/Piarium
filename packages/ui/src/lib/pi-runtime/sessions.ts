import { getPiRuntimeConnection } from './client';

export const listPiSessions = async (cwd?: string) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('session.list', cwd === undefined ? {} : { cwd });
};
