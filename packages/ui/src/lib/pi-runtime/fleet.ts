import { getPiRuntimeConnection } from './client';

export const getPiFleetStatus = async (sessionId: string) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('fleet.status', { sessionId });
};
