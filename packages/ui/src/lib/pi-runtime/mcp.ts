import type { RuntimeContextTarget } from '@piarium/protocol';
import { getPiRuntimeConnection } from './client';

export const getPiMcpConfigSnapshot = async (target: RuntimeContextTarget) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('mcp.config.snapshot', target);
};
