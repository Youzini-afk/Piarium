import type { JsonValue } from '@piarium/protocol';
import { getPiRuntimeConnection } from './client';

export const getPiFleetStatus = async (sessionId: string) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('fleet.status', { sessionId });
};

export const runPiFleetAction = async (input: {
  action: string;
  entryKey?: string;
  payload?: JsonValue;
  providerId: string;
  sessionId: string;
}) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('fleet.action', {
    action: input.action,
    ...(input.entryKey === undefined ? {} : { entryKey: input.entryKey }),
    ...(input.payload === undefined ? {} : { input: input.payload }),
    providerId: input.providerId,
    sessionId: input.sessionId,
  });
};
