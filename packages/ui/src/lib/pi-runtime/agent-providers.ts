import type { JsonValue, RuntimeContextTarget } from '@piarium/protocol';
import { getPiRuntimeConnection } from './client';

export const listPiAgentProviders = async (target: RuntimeContextTarget) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('agentProvider.list', target);
};

export const runPiAgentProviderAction = async (
  target: RuntimeContextTarget,
  providerId: string,
  action: string,
  agentId?: string,
  input?: JsonValue,
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('agentProvider.action', {
    ...target,
    action,
    providerId,
    ...(agentId === undefined ? {} : { agentId }),
    ...(input === undefined ? {} : { input }),
  });
};
